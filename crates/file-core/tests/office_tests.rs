//! Word/Excel/PowerPoint to PDF through a real LibreOffice. Skipped unless `soffice` is available:
//! set ORANGEFILE_LIBREOFFICE to a folder that contains program/soffice (or install LibreOffice).
//! ORANGEFILE_REQUIRE_LIBREOFFICE=1 turns the skip into a failure (used in CI).

use file_core::engine::office::{OfficeConfig, OfficeEngine, OfficeHost};
use file_core::engine::pdf::{HostConfig, PdfHost};
use file_core::engine::{Availability, Registry};
use file_core::formats;
use file_core::request::{self, JobRequest};
use file_core::{Error, JobContext};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/office").join(name)
}

fn config() -> OfficeConfig {
    let mut cfg = OfficeConfig::nothing();
    cfg.search_installed = true;
    if let Some(dir) = std::env::var_os("ORANGEFILE_LIBREOFFICE") {
        cfg = cfg.with_bundled_dir(dir);
    }
    cfg
}

struct Lab {
    registry: Registry,
    dir: tempfile::TempDir,
}

fn lab_with(cfg: OfficeConfig) -> Option<Lab> {
    let host = Arc::new(OfficeHost::new(cfg));
    if matches!(host.availability(), Availability::Unavailable { .. }) {
        assert!(std::env::var_os("ORANGEFILE_REQUIRE_LIBREOFFICE").is_none(), "ORANGEFILE_REQUIRE_LIBREOFFICE is set but LibreOffice is not available");
        eprintln!("skipped: LibreOffice is not available");
        return None;
    }
    let pdf = Arc::new(PdfHost::new(HostConfig::for_app()));
    Some(Lab { registry: Registry::bundled_with_office(pdf, host), dir: tempfile::tempdir().unwrap() })
}

fn lab() -> Option<Lab> {
    lab_with(config())
}

impl Lab {
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
    fn req(&self, inputs: &[&Path], policy: &str) -> JobRequest {
        serde_json::from_value(json!({"inputs": inputs, "output_dir": self.out(), "conflict": policy, "operation": {"type": "office_to_pdf"}})).unwrap()
    }
    fn run(&self, req: &JobRequest) -> (file_core::Result<()>, JobContext) {
        let ctx = JobContext::silent();
        let result = request::validate_with(&self.registry, req).and_then(|_| request::run_with(&self.registry, req, &ctx));
        (result, ctx)
    }
    fn names(&self, dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
}

/// Page count read from the page tree entries LibreOffice writes uncompressed (`/Type/Page` but not `/Type/Pages`).
fn pdf_pages(path: &Path) -> usize {
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes.starts_with(b"%PDF-"), "not a PDF: {}", path.display());
    let text = String::from_utf8_lossy(&bytes);
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    compact.matches("/Type/Page").count() - compact.matches("/Type/Pages").count()
}

fn results(ctx: &JobContext) -> Value {
    serde_json::to_value(ctx.snapshot()).unwrap()
}

#[test]
fn detects_documents_by_content_not_by_name() {
    let d = tempfile::tempdir().unwrap();
    let cases = [
        ("report.docx", formats::DOCX),
        ("sheet.xlsx", formats::XLSX),
        ("deck.pptx", formats::PPTX),
        ("report.odt", formats::ODT),
        ("sheet.ods", formats::ODS),
        ("deck.odp", formats::ODP),
        ("report.doc", formats::DOC),
        ("sheet.xls", formats::XLS),
        ("deck.ppt", formats::PPT),
        ("note.rtf", formats::RTF),
    ];
    for (name, want) in cases {
        let disguised = d.path().join(format!("{name}.bin"));
        std::fs::copy(fixture(name), &disguised).unwrap();
        assert_eq!(formats::detect_office_file(&disguised), Some(want), "{name}");
    }
    // A name can't make something a document.
    let fake = d.path().join("fake.docx");
    std::fs::write(&fake, b"just some text").unwrap();
    assert_eq!(formats::detect_office_file(&fake), None);
    // Any other ZIP is not a document either.
    let zip = d.path().join("plain.docx");
    {
        use std::io::Write;
        let mut z = zip::ZipWriter::new(std::fs::File::create(&zip).unwrap());
        z.start_file("hello.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"hi").unwrap();
        z.finish().unwrap();
    }
    assert_eq!(formats::detect_office_file(&zip), None);
    // An Excel workbook named .docx is still a workbook.
    let swapped = d.path().join("swapped.docx");
    std::fs::copy(fixture("sheet.xlsx"), &swapped).unwrap();
    assert_eq!(formats::detect_office_file(&swapped), Some(formats::XLSX));
}

#[test]
fn engine_is_unavailable_without_libreoffice_and_says_so() {
    let host = Arc::new(OfficeHost::new(OfficeConfig::nothing()));
    let reg = Registry::bundled_with_office(Arc::new(PdfHost::new(HostConfig::for_app())), host);
    let caps = reg.capabilities();
    let op = caps.operations.iter().find(|o| o.spec.id == "office_to_pdf").unwrap();
    assert!(!op.available);
    assert!(op.unavailable_reason.as_deref().unwrap().contains("LibreOffice"));

    let d = tempfile::tempdir().unwrap();
    std::fs::copy(fixture("report.docx"), d.path().join("report.docx")).unwrap();
    let req: JobRequest = serde_json::from_value(json!({"inputs": [d.path().join("report.docx")], "output_dir": d.path(), "operation": {"type": "office_to_pdf"}})).unwrap();
    let err = request::validate_with(&reg, &req).unwrap_err();
    assert_eq!(err.code(), "engine_unavailable");
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1, "nothing written");
}

#[test]
fn advertises_all_office_formats() {
    let reg = Registry::bundled_with_office(Arc::new(PdfHost::new(HostConfig::for_app())), Arc::new(OfficeHost::new(OfficeConfig::nothing())));
    let caps = reg.capabilities();
    let op = caps.operations.iter().find(|o| o.spec.id == "office_to_pdf").unwrap();
    for f in ["docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "ppt", "odp"] {
        assert!(op.spec.inputs.iter().any(|i| i == f), "{f}");
        assert!(caps.formats.iter().any(|x| x.id == f), "{f} in the format catalogue");
    }
    assert_eq!(op.spec.outputs, ["pdf"]);
}

#[test]
fn converts_every_supported_format() {
    let Some(lab) = lab() else { return };
    // (file, pages in the PDF)
    let cases = [
        ("report.docx", 2),
        ("report.doc", 2),
        ("report.odt", 2),
        ("sheet.xlsx", 1),
        ("sheet.xls", 1),
        ("sheet.ods", 1),
        ("deck.pptx", 3),
        ("deck.ppt", 3),
        ("deck.odp", 3),
        ("note.rtf", 1),
    ];
    let files: Vec<PathBuf> = cases.iter().map(|(n, _)| lab.copy(n)).collect();
    let refs: Vec<&Path> = files.iter().map(|p| p.as_path()).collect();
    let before: Vec<Vec<u8>> = files.iter().map(|p| std::fs::read(p).unwrap()).collect();
    let (res, ctx) = lab.run(&lab.req(&refs, "rename"));
    res.unwrap();
    let snap = results(&ctx);
    assert_eq!(snap["files_completed"], 10, "{snap}");
    let out = lab.out();
    // Same stem for every format, so the second file of a pair gets a numbered name.
    let produced = lab.names(&out);
    assert_eq!(produced.len(), cases.len(), "{produced:?}");
    assert!(produced.iter().all(|n| n.ends_with(".pdf")));
    let mut pages: Vec<usize> = produced.iter().map(|n| pdf_pages(&out.join(n))).collect();
    pages.sort();
    let mut want: Vec<usize> = cases.iter().map(|(_, p)| *p).collect();
    want.sort();
    assert_eq!(pages, want, "{produced:?}");
    for (p, b) in files.iter().zip(before) {
        assert_eq!(std::fs::read(p).unwrap(), b, "sources are never modified");
    }
    // Nothing left behind next to the results.
    assert!(lab.names(&out).iter().all(|n| !n.starts_with('.')), "{:?}", lab.names(&out));
}

#[test]
fn text_survives_conversion_when_pdfium_is_available() {
    let Some(lab) = lab() else { return };
    let Some(lib) = std::env::var_os("ORANGEFILE_PDFIUM") else {
        eprintln!("skipped: ORANGEFILE_PDFIUM is not set");
        return;
    };
    let mut cfg = HostConfig::for_app().with_worker(file_core::engine::pdf::WorkerProgram::Exe(PathBuf::from(env!("CARGO_BIN_EXE_of-pdf-worker"))));
    cfg.library_dirs = vec![PathBuf::from(lib)];
    let docx = lab.copy("report.docx");
    let (res, _) = lab.run(&lab.req(&[&docx], "rename"));
    res.unwrap();
    let pdf = lab.out().join("report.pdf");
    let host = PdfHost::new(cfg);
    let info = host.info(&pdf, None).unwrap();
    assert_eq!(info.pages.len(), 2);
}

#[test]
fn conflict_policies() {
    let Some(lab) = lab() else { return };
    let doc = lab.copy("note.rtf");
    let existing = lab.out().join("note.pdf");
    std::fs::write(&existing, b"old").unwrap();

    // Review sees the clash.
    let r = lab.req(&[&doc], "rename");
    let review = request::review_with(&lab.registry, &r).unwrap();
    assert_eq!(review.conflicts, vec![existing.clone()]);
    assert!(review.errors.is_empty());

    // Skip: untouched, reported.
    let (res, ctx) = lab.run(&lab.req(&[&doc], "skip"));
    res.unwrap();
    assert_eq!(std::fs::read(&existing).unwrap(), b"old");
    assert_eq!(results(&ctx)["results"][0]["outcome"], "skipped");

    // Keep both: the old file stays, a new one appears.
    let (res, _) = lab.run(&lab.req(&[&doc], "rename"));
    res.unwrap();
    assert_eq!(std::fs::read(&existing).unwrap(), b"old");
    let names = lab.names(&lab.out());
    assert_eq!(names.len(), 2, "{names:?}");

    // Replace: overwritten with a real PDF.
    let (res, _) = lab.run(&lab.req(&[&doc], "replace"));
    res.unwrap();
    assert!(std::fs::read(&existing).unwrap().starts_with(b"%PDF-"));
    assert_eq!(lab.names(&lab.out()).len(), 2);
}

#[test]
fn a_bad_document_fails_alone_and_leaves_nothing() {
    let Some(lab) = lab() else { return };
    let good = lab.copy("note.rtf");
    let bad = lab.dir.path().join("broken.docx");
    std::fs::write(&bad, b"this is not a document").unwrap();
    // Content check happens in review and in the job.
    let review = request::review_with(&lab.registry, &lab.req(&[&bad, &good], "rename")).unwrap();
    assert_eq!(review.errors.len(), 1, "{:?}", review.errors);

    let (res, ctx) = lab.run(&lab.req(&[&bad, &good], "rename"));
    // Either refused up front or the single file reported as failed; the good one is converted when the job runs.
    match res {
        Ok(()) => {
            let snap = results(&ctx);
            assert_eq!(snap["results"][0]["outcome"], "failed", "{snap}");
            assert_eq!(snap["results"][1]["outcome"], "done", "{snap}");
        }
        Err(e) => assert!(matches!(e, Error::UnsupportedFormat(_) | Error::InvalidRequest(_)), "{e:?}"),
    }
    assert!(lab.names(&lab.out()).iter().all(|n| !n.starts_with('.')));
}

#[test]
fn a_truncated_document_is_reported_not_crashed() {
    let Some(lab) = lab() else { return };
    let bytes = std::fs::read(fixture("report.docx")).unwrap();
    let cut = lab.dir.path().join("cut.docx");
    std::fs::write(&cut, &bytes[..bytes.len() / 3]).unwrap();
    let (res, ctx) = lab.run(&lab.req(&[&cut], "rename"));
    let snap = results(&ctx);
    // A truncated ZIP either isn't recognised or LibreOffice fails; in both cases nothing broken is left as a result.
    assert!(res.is_err() || snap["results"][0]["outcome"] == "failed", "{snap}");
    assert!(lab.names(&lab.out()).is_empty(), "{:?}", lab.names(&lab.out()));
}

#[test]
fn cancel_stops_the_process_tree_and_cleans_up() {
    let Some(lab) = lab() else { return };
    let doc = lab.copy("report.docx");
    let req = lab.req(&[&doc], "rename");
    request::validate_with(&lab.registry, &req).unwrap();
    let ctx = JobContext::silent();
    let token = ctx.cancel_token();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        token.cancel();
    });
    let started = std::time::Instant::now();
    let res = request::run_with(&lab.registry, &req, &ctx);
    canceller.join().unwrap();
    assert!(matches!(res, Err(Error::Cancelled)), "{res:?}");
    assert!(started.elapsed() < Duration::from_secs(20), "cancel is prompt");
    assert!(lab.names(&lab.out()).is_empty(), "no temp folder or partial PDF: {:?}", lab.names(&lab.out()));
}

#[test]
fn a_hung_conversion_is_stopped_by_the_timeout() {
    let mut cfg = config();
    cfg.timeout = Duration::from_millis(150);
    let Some(lab) = lab_with(cfg) else { return };
    let doc = lab.copy("report.docx");
    let started = std::time::Instant::now();
    let (res, ctx) = lab.run(&lab.req(&[&doc], "rename"));
    let snap = results(&ctx);
    assert!(res.is_err() || snap["results"][0]["outcome"] == "failed", "{snap}");
    assert_eq!(snap["results"][0]["error_code"], "office_conversion_failed", "{snap}");
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(lab.names(&lab.out()).is_empty(), "{:?}", lab.names(&lab.out()));
}

#[test]
fn bundled_folder_is_preferred_and_reported_bundled() {
    let Some(_lab) = lab() else { return };
    // Point the "bundled" folder at the real installation's root, laid out like our resources/libreoffice.
    let Some(real) = ["/usr/lib/libreoffice", "/opt/libreoffice"].iter().map(PathBuf::from).find(|p| p.join("program/soffice").is_file()) else {
        eprintln!("skipped: no LibreOffice folder with program/soffice");
        return;
    };
    let host = OfficeHost::new(OfficeConfig::nothing().with_bundled_dir(real));
    assert_eq!(host.availability(), Availability::Bundled);
    assert!(host.version().to_lowercase().contains("libreoffice"), "{}", host.version());
    let _ = OfficeEngine::new(Arc::new(host));
}
