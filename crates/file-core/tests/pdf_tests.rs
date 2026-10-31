//! PDF engine tests. They need a PDFium library: set `ORANGEFILE_PDFIUM` to its folder
//! (`npm run get-pdfium` fetches one for the platform you're on). Without it the tests that
//! need PDFium print a notice and return, unless `ORANGEFILE_REQUIRE_PDFIUM=1`, which makes
//! a missing library a failure (CI should set it).

mod common;

use file_core::engine::pdf::{HostConfig, PdfHost, WorkerProgram, MAX_RENDER_PIXELS};
use file_core::engine::Registry;
use file_core::request::Secret;
use file_core::{Availability, Error};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf").join(name)
}

fn worker() -> WorkerProgram {
    WorkerProgram::Exe(PathBuf::from(env!("CARGO_BIN_EXE_of-pdf-worker")))
}

fn pdfium_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("ORANGEFILE_PDFIUM").map(PathBuf::from);
    if dir.is_none() {
        assert!(
            std::env::var_os("ORANGEFILE_REQUIRE_PDFIUM").is_none(),
            "ORANGEFILE_REQUIRE_PDFIUM is set but ORANGEFILE_PDFIUM is not"
        );
        eprintln!("skipped: ORANGEFILE_PDFIUM is not set");
    }
    dir
}

fn host_with(dir: &Path, tweak: impl FnOnce(&mut HostConfig)) -> PdfHost {
    let mut cfg = HostConfig::for_app().with_worker(worker());
    cfg.library_dirs = vec![dir.to_path_buf()];
    tweak(&mut cfg);
    PdfHost::new(cfg)
}

fn host() -> Option<PdfHost> {
    pdfium_dir().map(|d| host_with(&d, |_| {}))
}

fn png_at(host: &PdfHost, name: &str, pw: Option<&Secret>, page: u32, width: u32) -> image::RgbImage {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("p.png");
    host.render(&fixture(name), pw, page, width, &out).unwrap();
    image::open(&out).unwrap().to_rgb8()
}

fn near(px: &image::Rgb<u8>, want: [u8; 3]) -> bool {
    px.0.iter().zip(want).all(|(a, b)| (i32::from(*a) - i32::from(b)).abs() <= 6)
}

#[test]
fn describes_a_document() {
    let Some(h) = host() else { return };
    let info = h.info(&fixture("three-pages.pdf"), None).unwrap();
    assert_eq!(info.page_count, 3);
    assert_eq!(info.pages.len(), 3);
    let (a4w, a4h) = (info.pages[0].width_pt, info.pages[0].height_pt);
    assert!((a4w - 595.3).abs() < 1.0 && (a4h - 841.9).abs() < 1.0, "A4 portrait: {a4w}x{a4h}");
    assert!(info.pages[1].width_pt > info.pages[1].height_pt, "page 2 is landscape");
    assert!(info.pages[2].width_pt > info.pages[2].height_pt, "page 3 is A4 turned 90 degrees, so it is shown landscape");
    assert!(!info.encrypted && info.permissions.is_none());
    assert_eq!(info.metadata.title.as_deref(), Some("Three pages"));
    assert_eq!(info.metadata.author.as_deref(), Some("OrangeFile tests"));
    assert_eq!(info.signature_count, 0);
    assert!(!info.has_form);
    assert!(info.warnings.is_empty(), "{:?}", info.warnings);
    assert!(info.version.is_some());
}

#[test]
fn renders_the_right_page_with_rotation_applied() {
    let Some(h) = host() else { return };
    let red = png_at(&h, "three-pages.pdf", None, 0, 300);
    assert_eq!(red.width(), 300);
    assert!((red.height() as i32 - 424).abs() <= 1, "A4 aspect: {}", red.height());
    assert!(near(red.get_pixel(150, 300), [217, 26, 26]), "page 1 is red: {:?}", red.get_pixel(150, 300));

    let green = png_at(&h, "three-pages.pdf", None, 1, 400);
    assert!(green.width() > green.height(), "landscape");
    assert!(near(green.get_pixel(200, 250), [26, 153, 26]), "{:?}", green.get_pixel(200, 250));

    let blue = png_at(&h, "three-pages.pdf", None, 2, 400);
    assert!(blue.width() > blue.height(), "the /Rotate 90 page is drawn turned");
    assert!(near(blue.get_pixel(200, 250), [26, 51, 217]), "{:?}", blue.get_pixel(200, 250));
}

#[test]
fn the_page_text_is_drawn() {
    let Some(h) = host() else { return };
    let img = png_at(&h, "three-pages.pdf", None, 0, 600);
    // White heading text on the red page: some pixels in the top band are near white.
    let whites = (0..600).flat_map(|x| (20..80).map(move |y| (x, y))).filter(|&(x, y)| near(img.get_pixel(x, y), [255, 255, 255])).count();
    assert!(whites > 100, "text pixels found: {whites}");
}

#[test]
fn passwords() {
    let Some(h) = host() else { return };
    let f = fixture("encrypted.pdf");
    assert!(matches!(h.info(&f, None), Err(Error::PasswordRequired)));
    assert!(matches!(h.info(&f, Some(&Secret::new(""))), Err(Error::PasswordRequired)), "an empty password is no password");
    assert!(matches!(h.info(&f, Some(&Secret::new("wrong"))), Err(Error::WrongPassword)));
    let info = h.info(&f, Some(&Secret::new("open-sesame"))).unwrap();
    assert_eq!(info.page_count, 3);
    assert!(info.encrypted);
    let img = png_at(&h, "encrypted.pdf", Some(&Secret::new("open-sesame")), 0, 200);
    assert!(near(img.get_pixel(100, 150), [217, 26, 26]));
    // Rendering without the password fails the same way.
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(h.render(&f, None, 0, 200, &dir.path().join("x.png")), Err(Error::PasswordRequired)));
    assert!(!dir.path().join("x.png").exists());
}

#[test]
fn a_restricted_pdf_opens_and_says_what_is_restricted() {
    let Some(h) = host() else { return };
    let info = h.info(&fixture("restricted.pdf"), None).unwrap();
    assert!(info.encrypted);
    let p = info.permissions.expect("permissions are reported for protected files");
    assert!(!p.modify && !p.copy, "{p:?}");
    assert!(info.warnings.iter().any(|w| w.contains("restrict")), "{:?}", info.warnings);
}

#[test]
fn bad_files_are_reported_not_crashed_on() {
    let Some(h) = host() else { return };
    assert!(matches!(h.info(&fixture("not-a-pdf.pdf"), None), Err(Error::CorruptPdf(_))));
    assert!(matches!(h.info(&fixture("no-pages.pdf"), None), Err(Error::CorruptPdf(_))));
    assert!(matches!(h.info(Path::new("/definitely/not/here.pdf"), None), Err(Error::Io { .. })));
    // A cut-off file either opens with the pages PDFium can recover, or is reported damaged.
    match h.info(&fixture("truncated.pdf"), None) {
        Ok(i) => assert!(i.page_count >= 1),
        Err(e) => assert!(matches!(e, Error::CorruptPdf(_)), "{e:?}"),
    }
}

#[test]
fn page_numbers_are_checked() {
    let Some(h) = host() else { return };
    let dir = tempfile::tempdir().unwrap();
    let e = h.render(&fixture("three-pages.pdf"), None, 3, 100, &dir.path().join("x.png")).unwrap_err();
    assert!(matches!(e, Error::PageOutOfRange { page: 4 }), "{e:?}");
}

#[test]
fn render_size_is_bounded() {
    let Some(h) = host() else { return };
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("big.png");
    let r = h.render(&fixture("huge-page.pdf"), None, 0, u32::MAX, &out).unwrap();
    assert!(r.width <= 4096 && r.height <= 8192 && u64::from(r.width) * u64::from(r.height) <= MAX_RENDER_PIXELS, "{r:?}");
    let img = image::open(&out).unwrap();
    assert_eq!((img.width(), img.height()), (r.width, r.height));
    let info = h.info(&fixture("huge-page.pdf"), None).unwrap();
    assert!(info.warnings.iter().any(|w| w.contains("very large")));
}

#[test]
fn parallel_calls_work() {
    let Some(h) = host() else { return };
    let h = Arc::new(h);
    let threads: Vec<_> = (0..6)
        .map(|i| {
            let h = h.clone();
            std::thread::spawn(move || {
                let dir = tempfile::tempdir().unwrap();
                h.render(&fixture("three-pages.pdf"), None, i % 3, 120, &dir.path().join("p.png")).unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
}

#[test]
fn the_source_file_is_never_modified() {
    let Some(h) = host() else { return };
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("a.pdf");
    std::fs::copy(fixture("three-pages.pdf"), &copy).unwrap();
    let before = std::fs::read(&copy).unwrap();
    h.info(&copy, None).unwrap();
    h.render(&copy, None, 0, 300, &dir.path().join("p.png")).unwrap();
    assert_eq!(std::fs::read(&copy).unwrap(), before);
}

// ---------------------------------------------------------------- without PDFium

#[test]
fn a_missing_library_makes_the_engine_unavailable_with_a_reason() {
    let empty = tempfile::tempdir().unwrap();
    let h = host_with(empty.path(), |_| {});
    match h.availability() {
        Availability::Unavailable { reason } => assert!(reason.contains("missing"), "{reason}"),
        other => panic!("{other:?}"),
    }
    let e = h.info(&fixture("three-pages.pdf"), None).unwrap_err();
    assert!(matches!(e, Error::EngineUnavailable { .. }), "{e:?}");
    // The reason must not leak where we looked.
    assert!(!e.user_message().contains(empty.path().to_str().unwrap()));
}

#[test]
fn the_registry_reports_pdf_viewing_and_its_availability() {
    let empty = tempfile::tempdir().unwrap();
    let reg = Registry::bundled_with(Arc::new(host_with(empty.path(), |_| {})));
    let caps = reg.capabilities();
    let op = caps.operations.iter().find(|o| o.spec.id == "pdf_view").expect("pdf_view is listed");
    assert!(op.spec.interactive && !op.available && op.unavailable_reason.is_some());
    assert!(caps.formats.iter().any(|f| f.id == "pdf"), "the PDF format is catalogued either way");
    assert!(caps.engines.iter().any(|e| e.info.id == "pdf"));
    assert!(reg.pdf_host().is_some());

    if let Some(dir) = pdfium_dir() {
        let reg = Registry::bundled_with(Arc::new(host_with(&dir, |_| {})));
        let op = reg.capabilities().operations.into_iter().find(|o| o.spec.id == "pdf_view").unwrap();
        assert!(op.available, "{:?}", op.unavailable_reason);
    }
}

// ---------------------------------------------------------------- worker failures

#[cfg(unix)]
mod unix_workers {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("worker.sh");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// A host whose "PDFium" is a stand-in file and whose worker is a script.
    fn fake(body: &str, timeout: Duration) -> (tempfile::TempDir, PdfHost) {
        let dir = tempfile::tempdir().unwrap();
        let lib = if cfg!(target_os = "macos") { "libpdfium.dylib" } else { "libpdfium.so" };
        std::fs::write(dir.path().join(lib), b"not a real library").unwrap();
        let w = script(dir.path(), body);
        let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(w));
        cfg.library_dirs = vec![dir.path().to_path_buf()];
        cfg.timeout = timeout;
        (dir, PdfHost::new(cfg))
    }

    #[test]
    fn a_crashing_worker_is_an_error_for_that_call_only() {
        // Answers the probe, then dies like a segfault on real work.
        let (_d, h) = fake(
            r#"input=$(cat); case "$input" in *probe*) echo '{"status":"ok","data":{}}';; *) kill -SEGV $$;; esac"#,
            Duration::from_secs(10),
        );
        assert!(h.availability().is_available());
        let e = h.info(&fixture("three-pages.pdf"), None).unwrap_err();
        assert!(matches!(e, Error::PdfWorker(_)), "{e:?}");
        assert!(!e.user_message().contains("SEGV"), "internal details stay out of the message");
        assert!(h.availability().is_available(), "the host keeps working after a crash");
    }

    #[test]
    fn a_hung_worker_is_stopped() {
        let (_d, h) = fake(r#"input=$(cat); case "$input" in *probe*) echo '{"status":"ok","data":{}}';; *) sleep 30;; esac"#, Duration::from_millis(600));
        assert!(h.availability().is_available());
        let t = std::time::Instant::now();
        let e = h.info(&fixture("three-pages.pdf"), None).unwrap_err();
        assert!(matches!(e, Error::PdfWorker(ref m) if m.contains("too long")), "{e:?}");
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn nonsense_replies_are_rejected() {
        let (_d, h) = fake(r#"input=$(cat); case "$input" in *probe*) echo '{"status":"ok","data":{}}';; *) echo 'hello';; esac"#, Duration::from_secs(5));
        assert!(matches!(h.info(&fixture("three-pages.pdf"), None), Err(Error::PdfWorker(_))));
        let (_d, h) = fake(
            r#"input=$(cat); case "$input" in *probe*) echo '{"status":"ok","data":{}}';; *) echo '{"status":"ok","data":{"page_count":"many"}}';; esac"#,
            Duration::from_secs(5),
        );
        assert!(matches!(h.info(&fixture("three-pages.pdf"), None), Err(Error::PdfWorker(_))));
    }

    #[test]
    fn a_worker_that_cannot_start_makes_the_engine_unavailable() {
        let (_d, h) = fake("exit 3", Duration::from_secs(5));
        assert!(matches!(h.availability(), Availability::Unavailable { .. }));
    }

    #[test]
    fn the_password_and_file_name_travel_on_stdin_not_in_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("seen");
        let body = format!(
            r#"echo "$@" > {l}.args; input=$(cat); echo "$input" > {l}.stdin; case "$input" in *probe*) echo '{{"status":"ok","data":{{}}}}';; *) echo '{{"status":"err","code":"wrong_password","message":"x"}}';; esac"#,
            l = log.display()
        );
        let (_d, h) = fake(&body, Duration::from_secs(5));
        let e = h.info(&fixture("three-pages.pdf"), Some(&Secret::new("hunter2-secret"))).unwrap_err();
        assert!(matches!(e, Error::WrongPassword));
        let args = std::fs::read_to_string(dir.path().join("seen.args")).unwrap();
        let stdin = std::fs::read_to_string(dir.path().join("seen.stdin")).unwrap();
        // The only argument is the worker flag.
        assert_eq!(args.trim(), "--pdf-worker");
        assert!(stdin.contains("hunter2-secret") && stdin.contains("three-pages.pdf"), "{stdin}");
    }

    #[test]
    fn the_memory_cap_applies_to_the_worker() {
        let Some(dir) = pdfium_dir() else { return };
        // Drawing the huge page needs a ~64 MB bitmap and copies of it, which render_size_is_bounded
        // shows works with the normal cap. Under 96 MiB of address space it can't, and the worker
        // fails that one call instead of taking the machine's memory.
        let h = host_with(&dir, |c| c.memory_limit_bytes = 96 * 1024 * 1024);
        assert!(h.availability().is_available(), "loading PDFium itself fits in the cap");
        let out = tempfile::tempdir().unwrap();
        let e = h.render(&fixture("huge-page.pdf"), None, 0, 4096, &out.path().join("x.png")).unwrap_err();
        assert!(matches!(e, Error::PdfWorker(_)), "{e:?}");
        assert!(!out.path().join("x.png").exists());
        // ...and the next call still works.
        h.render(&fixture("three-pages.pdf"), None, 0, 200, &out.path().join("ok.png")).unwrap();
    }
}
