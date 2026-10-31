//! Merge, split and rearrange, with a real PDFium (see pdf_tests.rs for how to provide one).

use file_core::engine::pdf::{HostConfig, PdfHost, WorkerProgram};
use file_core::engine::Registry;
use file_core::request::{self, JobRequest};
use file_core::{CancelToken, ConflictPolicy, Error, JobContext, Outcome};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf").join(name)
}

struct Lab {
    host: Arc<PdfHost>,
    registry: Registry,
    dir: tempfile::TempDir,
}

fn lab() -> Option<Lab> {
    let Some(lib) = std::env::var_os("ORANGEFILE_PDFIUM") else {
        assert!(std::env::var_os("ORANGEFILE_REQUIRE_PDFIUM").is_none(), "ORANGEFILE_REQUIRE_PDFIUM is set but ORANGEFILE_PDFIUM is not");
        eprintln!("skipped: ORANGEFILE_PDFIUM is not set");
        return None;
    };
    let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(PathBuf::from(env!("CARGO_BIN_EXE_of-pdf-worker"))));
    cfg.library_dirs = vec![PathBuf::from(lib)];
    let host = Arc::new(PdfHost::new(cfg));
    Some(Lab { registry: Registry::bundled_with(host.clone()), host, dir: tempfile::tempdir().unwrap() })
}

impl Lab {
    /// A private copy of a fixture, so a test can check that the "original" didn't change.
    fn copy(&self, name: &str) -> PathBuf {
        let p = self.dir.path().join(name);
        std::fs::copy(fixture(name), &p).unwrap();
        p
    }

    fn out(&self) -> PathBuf {
        let p = self.dir.path().join("out");
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn req(&self, inputs: &[&Path], operation: Value, policy: &str) -> JobRequest {
        serde_json::from_value(json!({ "inputs": inputs, "output_dir": self.out(), "conflict": policy, "operation": operation })).unwrap()
    }

    fn run(&self, req: &JobRequest) -> (file_core::Result<()>, JobContext) {
        let ctx = JobContext::silent();
        let result = request::validate_with(&self.registry, req).and_then(|_| request::run_with(&self.registry, req, &ctx));
        (result, ctx)
    }

    fn files_in(&self, dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn pages(&self, pdf: &Path) -> u32 {
        self.host.info(pdf, None).unwrap().page_count
    }

    /// The colour at the middle of a page, and whether it is drawn landscape.
    fn look(&self, pdf: &Path, page: u32) -> ([u8; 3], bool) {
        let out = self.dir.path().join(format!("look-{page}-{}.png", uuid::Uuid::new_v4().simple()));
        self.host.render(pdf, None, page - 1, 120, &out).unwrap();
        let img = image::open(&out).unwrap().to_rgb8();
        // Avoid the white heading: sample low on the page.
        (img.get_pixel(img.width() / 2, img.height() * 3 / 4).0, img.width() > img.height())
    }
}

fn near(got: [u8; 3], want: [u8; 3]) -> bool {
    got.iter().zip(want).all(|(a, b)| (i32::from(*a) - i32::from(b)).abs() <= 8)
}

const RED: [u8; 3] = [217, 26, 26];
const GREEN: [u8; 3] = [26, 153, 26];
const BLUE: [u8; 3] = [26, 51, 217];
const ORANGE: [u8; 3] = [242, 140, 13];
const PURPLE: [u8; 3] = [140, 38, 179];

fn ten(n: u32) -> [u8; 3] {
    [(255.0 * f64::from(n) / 11.0) as u8, 51, (255.0 * (1.0 - f64::from(n) / 11.0)) as u8]
}

fn merge_op() -> Value {
    json!({ "type": "pdf_merge", "password": null, "output_name": null })
}

// ------------------------------------------------------------------ merge

#[test]
fn merge_puts_every_page_of_every_file_in_order() {
    let Some(l) = lab() else { return };
    let (a, b) = (l.copy("three-pages.pdf"), l.copy("second.pdf"));
    let before = (std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
    let (r, ctx) = l.run(&l.req(&[&a, &b], merge_op(), "rename"));
    r.unwrap();
    let out = l.out().join("merged.pdf");
    assert_eq!(l.files_in(&l.out()), ["merged.pdf"], "one output, no temp files left");
    assert_eq!(l.pages(&out), 5);
    let looks: Vec<_> = (1..=5).map(|p| l.look(&out, p)).collect();
    for (i, want) in [RED, GREEN, BLUE, ORANGE, PURPLE].into_iter().enumerate() {
        assert!(near(looks[i].0, want), "page {} is {:?}, want {want:?}", i + 1, looks[i].0);
    }
    assert!(looks[1].1 && looks[2].1, "the landscape page and the page turned by /Rotate keep their orientation");
    assert!(!looks[0].1 && !looks[3].1);
    assert_eq!((std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap()), before, "sources untouched");
    let snap = ctx.snapshot();
    assert_eq!(snap.results.len(), 1);
    assert_eq!(snap.results[0].outcome, Outcome::Done);
    assert_eq!(snap.output_paths, vec![out]);
}

#[test]
fn the_order_of_the_inputs_is_the_order_of_the_pages() {
    let Some(l) = lab() else { return };
    let (a, b) = (l.copy("three-pages.pdf"), l.copy("second.pdf"));
    l.run(&l.req(&[&b, &a], json!({"type": "pdf_merge", "output_name": "swapped"}), "rename")).0.unwrap();
    let out = l.out().join("swapped.pdf");
    assert!(near(l.look(&out, 1).0, ORANGE) && near(l.look(&out, 3).0, RED));
}

#[test]
fn merging_a_file_with_itself_repeats_its_pages() {
    let Some(l) = lab() else { return };
    let a = l.copy("second.pdf");
    l.run(&l.req(&[&a, &a], merge_op(), "rename")).0.unwrap();
    let out = l.out().join("merged.pdf");
    assert_eq!(l.pages(&out), 4);
    assert!(near(l.look(&out, 3).0, ORANGE));
}

#[test]
fn output_properties() {
    let Some(l) = lab() else { return };
    let (a, b) = (l.copy("three-pages.pdf"), l.copy("second.pdf"));
    l.run(&l.req(&[&a, &b], merge_op(), "rename")).0.unwrap();
    let info = l.host.info(&l.out().join("merged.pdf"), None).unwrap();
    assert!(!info.encrypted);
    // The review says document properties are not carried over; hold it to that.
    assert!(info.metadata.title.is_none() && info.metadata.author.is_none(), "{:?}", info.metadata);
}

#[test]
fn merge_conflict_policies() {
    let Some(l) = lab() else { return };
    let (a, b) = (l.copy("three-pages.pdf"), l.copy("second.pdf"));
    l.run(&l.req(&[&a, &b], merge_op(), "rename")).0.unwrap();
    let first = std::fs::read(l.out().join("merged.pdf")).unwrap();

    l.run(&l.req(&[&b, &a], merge_op(), "rename")).0.unwrap();
    assert_eq!(l.files_in(&l.out()), ["merged (1).pdf", "merged.pdf"], "keep both");
    assert_eq!(std::fs::read(l.out().join("merged.pdf")).unwrap(), first);

    let (r, ctx) = l.run(&l.req(&[&b, &a], merge_op(), "skip"));
    r.unwrap();
    assert_eq!(l.files_in(&l.out()).len(), 2, "nothing new");
    assert_eq!(ctx.snapshot().results[0].outcome, Outcome::Skipped);

    l.run(&l.req(&[&b, &a], merge_op(), "replace")).0.unwrap();
    assert_ne!(std::fs::read(l.out().join("merged.pdf")).unwrap(), first, "replaced");
    assert_eq!(l.files_in(&l.out()).len(), 2);
}

#[test]
fn replace_never_overwrites_a_source() {
    let Some(l) = lab() else { return };
    // Output folder = the folder the sources are in, named like one of them.
    let (a, b) = (l.copy("three-pages.pdf"), l.copy("second.pdf"));
    let before = std::fs::read(&a).unwrap();
    let req: JobRequest = serde_json::from_value(json!({
        "inputs": [&a, &b], "output_dir": l.dir.path(), "conflict": "replace",
        "operation": {"type": "pdf_merge", "output_name": "three-pages"}
    }))
    .unwrap();
    let (r, _) = l.run(&req);
    assert!(matches!(r, Err(Error::WouldOverwriteSource(_))), "{r:?}");
    assert_eq!(std::fs::read(&a).unwrap(), before);
}

#[test]
fn merge_with_passwords() {
    let Some(l) = lab() else { return };
    let (a, e) = (l.copy("second.pdf"), l.copy("encrypted.pdf"));
    let (r, ctx) = l.run(&l.req(&[&a, &e], merge_op(), "rename"));
    let msg = r.unwrap_err().user_message();
    assert!(msg.contains("encrypted.pdf") && msg.contains("password"), "names the file: {msg}");
    assert_eq!(ctx.snapshot().results[0].outcome, Outcome::Failed);
    assert!(l.files_in(&l.out()).is_empty(), "no output and no temp file after a failure");

    let wrong = json!({"type": "pdf_merge", "password": "nope"});
    assert!(l.run(&l.req(&[&a, &e], wrong, "rename")).0.unwrap_err().user_message().contains("password is incorrect"));

    let right = json!({"type": "pdf_merge", "password": "open-sesame"});
    l.run(&l.req(&[&a, &e], right, "rename")).0.unwrap();
    let out = l.out().join("merged.pdf");
    assert_eq!(l.pages(&out), 5);
    assert!(!l.host.info(&out, None).unwrap().encrypted, "the merged file is not protected");
}

#[test]
fn merge_rejects_bad_input_clearly() {
    let Some(l) = lab() else { return };
    let (a, junk) = (l.copy("three-pages.pdf"), l.dir.path().join("fake.pdf"));
    std::fs::write(&junk, b"%PDF-1.7\nnot really a document").unwrap();
    let msg = l.run(&l.req(&[&a, &junk], merge_op(), "rename")).0.unwrap_err().user_message();
    assert!(msg.contains("fake.pdf") && msg.contains("damaged"), "{msg}");
    assert!(l.files_in(&l.out()).is_empty());

    let msg = l.run(&l.req(&[&a], merge_op(), "rename")).0.unwrap_err().user_message();
    assert!(msg.contains("at least two"), "{msg}");

    let text = l.dir.path().join("note.pdf");
    std::fs::write(&text, b"hello").unwrap();
    assert!(matches!(l.run(&l.req(&[&a, &text], merge_op(), "rename")).0, Err(Error::InvalidRequest(_)) | Err(Error::UnsupportedFormat(_))));
}

#[test]
fn a_cancelled_job_leaves_nothing() {
    let Some(l) = lab() else { return };
    let (a, b) = (l.copy("three-pages.pdf"), l.copy("second.pdf"));
    let token = CancelToken::default();
    token.cancel();
    let ctx = JobContext::new("t", "pdf_merge", token, |_| {});
    let r = request::run_with(&l.registry, &l.req(&[&a, &b], merge_op(), "rename"), &ctx);
    assert!(matches!(r, Err(Error::Cancelled)));
    assert!(l.files_in(&l.out()).is_empty());
    let token = CancelToken::default();
    token.cancel();
    let ctx = JobContext::new("t", "pdf_split", token, |_| {});
    let r = request::run_with(&l.registry, &l.req(&[&l.copy("ten-pages.pdf")], json!({"type": "pdf_split", "mode": "every", "every": 1}), "rename"), &ctx);
    assert!(matches!(r, Err(Error::Cancelled)));
    assert!(l.files_in(&l.out()).is_empty(), "no folder left behind either: {:?}", l.files_in(&l.out()));
}

// ------------------------------------------------------------------ pages (reorder, rotate, delete, extract)

fn pages_op(pages: Value) -> Value {
    json!({"type": "pdf_pages", "pages": pages})
}

#[test]
fn reorder() {
    let Some(l) = lab() else { return };
    let a = l.copy("three-pages.pdf");
    l.run(&l.req(&[&a], pages_op(json!([{"page": 3}, {"page": 1}, {"page": 2}])), "rename")).0.unwrap();
    let out = l.out().join("three-pages (edited).pdf");
    assert_eq!(l.pages(&out), 3);
    assert!(near(l.look(&out, 1).0, BLUE) && near(l.look(&out, 2).0, RED) && near(l.look(&out, 3).0, GREEN));
    assert!(l.look(&out, 1).1, "the page that was turned in the source is still turned");
}

#[test]
fn delete_and_extract_are_the_same_thing() {
    let Some(l) = lab() else { return };
    let a = l.copy("ten-pages.pdf");
    let keep: Vec<u32> = vec![1, 2, 4, 5, 6, 7, 8, 9, 10]; // delete page 3
    let plan: Vec<_> = keep.iter().map(|p| json!({"page": p})).collect();
    l.run(&l.req(&[&a], json!({"type": "pdf_pages", "pages": plan, "output_name": "without-3"}), "rename")).0.unwrap();
    let out = l.out().join("without-3.pdf");
    assert_eq!(l.pages(&out), 9);
    assert!(near(l.look(&out, 3).0, ten(4)), "page 3 of the result is the old page 4");

    l.run(&l.req(&[&a], json!({"type": "pdf_pages", "pages": [{"page": 7}, {"page": 8}], "output_name": "extract.pdf"}), "rename")).0.unwrap();
    let ex = l.out().join("extract.pdf");
    assert_eq!(l.pages(&ex), 2);
    assert!(near(l.look(&ex, 1).0, ten(7)) && near(l.look(&ex, 2).0, ten(8)));
}

#[test]
fn rotate_adds_to_the_rotation_a_page_already_has() {
    let Some(l) = lab() else { return };
    let a = l.copy("three-pages.pdf");
    let plan = json!([{"page": 1, "rotate": 90}, {"page": 2, "rotate": 180}, {"page": 3, "rotate": 270}]);
    l.run(&l.req(&[&a], pages_op(plan), "rename")).0.unwrap();
    let out = l.out().join("three-pages (edited).pdf");
    assert!(l.look(&out, 1).1, "A4 portrait turned 90 is landscape");
    assert!(l.look(&out, 2).1, "landscape turned 180 stays landscape");
    assert!(!l.look(&out, 3).1, "page 3 was turned 90 already; 90 + 270 makes it upright again");
    let sizes = l.host.info(&out, None).unwrap().pages;
    assert!(sizes[0].width_pt > sizes[0].height_pt && sizes[2].height_pt > sizes[2].width_pt, "{sizes:?}");
}

#[test]
fn a_page_can_appear_twice() {
    let Some(l) = lab() else { return };
    let a = l.copy("three-pages.pdf");
    l.run(&l.req(&[&a], pages_op(json!([{"page": 2}, {"page": 2, "rotate": 90}, {"page": 1}])), "rename")).0.unwrap();
    let out = l.out().join("three-pages (edited).pdf");
    assert_eq!(l.pages(&out), 3);
    assert!(near(l.look(&out, 1).0, GREEN) && near(l.look(&out, 2).0, GREEN) && near(l.look(&out, 3).0, RED));
    assert!(l.look(&out, 1).1 && !l.look(&out, 2).1);
}

#[test]
fn page_plans_are_checked() {
    let Some(l) = lab() else { return };
    let a = l.copy("three-pages.pdf");
    let run = |plan: Value| l.run(&l.req(&[&a], pages_op(plan), "rename")).0;
    assert!(run(json!([])).unwrap_err().user_message().contains("at least one page"));
    assert!(matches!(run(json!([{"page": 0}])), Err(Error::InvalidRequest(_))));
    assert!(matches!(run(json!([{"page": 1, "rotate": 45}])), Err(Error::InvalidRequest(_))));
    assert!(matches!(run(json!([{"page": 1, "rotate": 360}])), Err(Error::InvalidRequest(_))));
    let e = run(json!([{"page": 1}, {"page": 4}])).unwrap_err().user_message();
    assert!(e.contains("page 4"), "{e}");
    assert!(l.files_in(&l.out()).is_empty(), "failed plans write nothing");
    let two = l.req(&[&a, &l.copy("second.pdf")], pages_op(json!([{"page": 1}])), "rename");
    assert!(l.run(&two).0.is_err(), "pages works on exactly one file");
}

#[test]
fn an_encrypted_source_needs_its_password_here_too() {
    let Some(l) = lab() else { return };
    let e = l.copy("encrypted.pdf");
    assert!(l.run(&l.req(&[&e], pages_op(json!([{"page": 1}])), "rename")).0.unwrap_err().user_message().contains("password"));
    let op = json!({"type": "pdf_pages", "pages": [{"page": 2}], "password": "open-sesame"});
    l.run(&l.req(&[&e], op, "rename")).0.unwrap();
    let out = l.out().join("encrypted (edited).pdf");
    assert!(near(l.look(&out, 1).0, GREEN));
}

// ------------------------------------------------------------------ split

#[test]
fn split_every_n_pages() {
    let Some(l) = lab() else { return };
    let a = l.copy("ten-pages.pdf");
    let (r, ctx) = l.run(&l.req(&[&a], json!({"type": "pdf_split", "mode": "every", "every": 4}), "rename"));
    r.unwrap();
    let dir = l.out().join("ten-pages (split)");
    assert_eq!(l.files_in(&dir), ["ten-pages - pages 1-4.pdf", "ten-pages - pages 5-8.pdf", "ten-pages - pages 9-10.pdf"]);
    assert_eq!(l.files_in(&l.out()), ["ten-pages (split)"]);
    let counts: Vec<_> = l.files_in(&dir).iter().map(|f| l.pages(&dir.join(f))).collect();
    assert_eq!(counts, [4, 4, 2]);
    assert!(near(l.look(&dir.join("ten-pages - pages 5-8.pdf"), 1).0, ten(5)));
    assert!(near(l.look(&dir.join("ten-pages - pages 9-10.pdf"), 2).0, ten(10)));
    let snap = ctx.snapshot();
    assert_eq!(snap.results.len(), 3);
    assert_eq!(snap.output_paths, vec![dir], "the folder is the output");
}

#[test]
fn split_one_file_per_page() {
    let Some(l) = lab() else { return };
    let a = l.copy("three-pages.pdf");
    l.run(&l.req(&[&a], json!({"type": "pdf_split", "mode": "every", "every": 1}), "rename")).0.unwrap();
    let dir = l.out().join("three-pages (split)");
    assert_eq!(l.files_in(&dir), ["three-pages - page 1.pdf", "three-pages - page 2.pdf", "three-pages - page 3.pdf"]);
    assert!(near(l.look(&dir.join("three-pages - page 2.pdf"), 1).0, GREEN));
}

#[test]
fn split_by_ranges() {
    let Some(l) = lab() else { return };
    let a = l.copy("ten-pages.pdf");
    l.run(&l.req(&[&a], json!({"type": "pdf_split", "mode": "ranges", "ranges": "1-3, 5, 9-"}), "rename")).0.unwrap();
    let dir = l.out().join("ten-pages (split)");
    assert_eq!(l.files_in(&dir), ["ten-pages - page 5.pdf", "ten-pages - pages 1-3.pdf", "ten-pages - pages 9-10.pdf"]);
    assert_eq!(l.pages(&dir.join("ten-pages - pages 1-3.pdf")), 3);
}

#[test]
fn split_bad_ranges_write_nothing() {
    let Some(l) = lab() else { return };
    let a = l.copy("ten-pages.pdf");
    for ranges in ["1-11", "0", "5-2", "abc", ""] {
        let r = l.run(&l.req(&[&a], json!({"type": "pdf_split", "mode": "ranges", "ranges": ranges}), "rename")).0;
        assert!(r.is_err(), "{ranges:?}");
    }
    assert!(l.files_in(&l.out()).is_empty(), "no folder for a split that never started: {:?}", l.files_in(&l.out()));
}

#[test]
fn split_conflicts() {
    let Some(l) = lab() else { return };
    let a = l.copy("three-pages.pdf");
    let op = json!({"type": "pdf_split", "mode": "every", "every": 1});
    l.run(&l.req(&[&a], op.clone(), "rename")).0.unwrap();
    // Keep both: a second folder, so the first is not mixed with the new parts.
    l.run(&l.req(&[&a], op.clone(), "rename")).0.unwrap();
    assert_eq!(l.files_in(&l.out()), ["three-pages (split)", "three-pages (split) (1)"]);
    // Skip: existing parts are left alone.
    let (r, ctx) = l.run(&l.req(&[&a], op.clone(), "skip"));
    r.unwrap();
    assert!(ctx.snapshot().results.iter().all(|r| r.outcome == Outcome::Skipped));
    assert_eq!(l.files_in(&l.out()).len(), 2);
    // Replace: parts are overwritten in place.
    let part = l.out().join("three-pages (split)/three-pages - page 1.pdf");
    std::fs::write(&part, b"old").unwrap();
    l.run(&l.req(&[&a], op, "replace")).0.unwrap();
    assert!(l.pages(&part) == 1);
}

#[test]
fn split_an_encrypted_file() {
    let Some(l) = lab() else { return };
    let e = l.copy("encrypted.pdf");
    assert!(l.run(&l.req(&[&e], json!({"type": "pdf_split", "mode": "every", "every": 1}), "rename")).0.unwrap_err().user_message().contains("password"));
    assert!(l.files_in(&l.out()).is_empty());
    l.run(&l.req(&[&e], json!({"type": "pdf_split", "mode": "every", "every": 2, "password": "open-sesame"}), "rename")).0.unwrap();
    assert_eq!(l.files_in(&l.out().join("encrypted (split)")).len(), 2);
}

// ------------------------------------------------------------------ review and preflight

#[test]
fn review_reports_conflicts_warnings_and_blockers() {
    let Some(l) = lab() else { return };
    let (a, b) = (l.copy("three-pages.pdf"), l.copy("second.pdf"));
    let review = |req: &JobRequest| request::review_with(&l.registry, req).unwrap();

    let r = review(&l.req(&[&a, &b], merge_op(), "rename"));
    assert!(r.errors.is_empty() && r.conflicts.is_empty());
    assert!(r.warnings.iter().any(|w| w.contains("bookmarks")), "{:?}", r.warnings);
    assert!(r.total_bytes > 0);
    l.run(&l.req(&[&a, &b], merge_op(), "rename")).0.unwrap();
    assert_eq!(review(&l.req(&[&a, &b], merge_op(), "rename")).conflicts, vec![l.out().join("merged.pdf")]);

    let r = review(&l.req(&[&a], merge_op(), "rename"));
    assert!(r.errors.iter().any(|e| e.contains("at least two")), "{:?}", r.errors);

    let with_pw = json!({"type": "pdf_merge", "password": "x"});
    assert!(review(&l.req(&[&a, &b], with_pw, "rename")).warnings.iter().any(|w| w.contains("not password-protected")));

    // Split: how many files, and a password request for a protected file.
    let r = review(&l.req(&[&l.copy("ten-pages.pdf")], json!({"type": "pdf_split", "mode": "every", "every": 3}), "rename"));
    assert!(r.warnings.iter().any(|w| w.contains("4 new PDFs")), "{:?}", r.warnings);
    let r = review(&l.req(&[&l.copy("encrypted.pdf")], json!({"type": "pdf_split", "mode": "every", "every": 1}), "rename"));
    assert!(r.needs_password && r.errors.is_empty());
    let r = review(&l.req(&[&a], json!({"type": "pdf_split", "mode": "ranges", "ranges": "2-9"}), "rename"));
    assert!(r.errors.iter().any(|e| e.contains("Page 9")), "{:?}", r.errors);
}

#[test]
fn preflight_checks_file_types_and_options_without_a_pdf_engine() {
    // No PDFium needed: this part never starts a worker.
    let empty = tempfile::tempdir().unwrap();
    let mut cfg = HostConfig::for_app();
    cfg.library_dirs = vec![empty.path().to_path_buf()];
    let reg = Registry::bundled_with(Arc::new(PdfHost::new(cfg)));
    let op = |v: Value| serde_json::from_value::<file_core::Operation>(v).unwrap();
    let pdf = file_core::formats::FileDescriptor { name: "a.pdf".into(), size: 1, format: Some("pdf".into()) };
    let png = file_core::formats::FileDescriptor { name: "a.png".into(), size: 1, format: Some("png".into()) };
    let unknown = file_core::formats::FileDescriptor { name: "x.pdf".into(), size: 1, format: None };

    // The engine is unavailable, so engine_for refuses; preflight is what the engine itself would say.
    let e = reg.engine_for("pdf_merge").err().unwrap();
    assert!(matches!(e, Error::EngineUnavailable { .. }));
    for name in ["pdf_merge", "pdf_split", "pdf_pages"] {
        assert!(reg.engine_for(name).is_err(), "{name} is found, and refused as unavailable");
        assert!(reg.pdf_host().is_some());
    }
    let ops = file_core::engine::pdf::ops::preflight;
    let m = op(merge_op());
    assert!(ops(&m, &[pdf.clone()], true).is_ok());
    assert!(matches!(ops(&m, &[png], true), Err(Error::UnsupportedFormat(_))));
    assert!(matches!(ops(&m, &[unknown.clone()], true), Err(Error::UnsupportedFormat(_))));
    assert!(ops(&m, &[unknown], false).is_ok(), "unknown content is left for the job to report");
    assert!(ops(&op(json!({"type": "pdf_split", "mode": "every", "every": 0})), &[], true).is_err());
    assert!(ops(&op(json!({"type": "pdf_split", "mode": "ranges", "ranges": "3-1"})), &[], true).is_err());
    assert!(ops(&op(json!({"type": "pdf_merge", "output_name": "../x"})), &[], true).is_err());
    assert!(ops(&op(pages_op(json!([]))), &[], true).is_err());
    assert!(ops(&op(pages_op(json!([{"page": 1, "rotate": 90}]))), &[], true).is_ok());

    let caps = reg.capabilities();
    let ids: Vec<_> = caps.operations.iter().filter(|o| o.engine == "pdf").map(|o| (o.spec.id.as_str(), o.spec.interactive)).collect();
    assert_eq!(
        ids,
        [
            ("pdf_view", true),
            ("pdf_merge", false),
            ("pdf_split", false),
            ("images_to_pdf", false),
            ("pdf_to_images", false),
            ("pdf_annotate", true),
            ("pdf_reorder", true),
            ("pdf_rotate", true),
            ("pdf_delete_pages", true),
            ("pdf_extract_pages", true)
        ]
    );
    let _ = ConflictPolicy::Rename;
}
