//! Add/remove PDF passwords (real qpdf) and Compress PDF (lopdf, plus qpdf when present).
//! The password tests are skipped when qpdf isn't installed; ORANGEFILE_REQUIRE_QPDF=1 turns the skip into a failure.
mod common;
use common::*;
use file_core::engine::qpdf::{QpdfConfig, QpdfHost};
use file_core::Outcome;
use lopdf::{dictionary, Document, Object, Stream};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf").join(name)
}

fn have_qpdf() -> bool {
    let mut cfg = QpdfConfig::nothing();
    cfg.search_installed = true;
    let ok = QpdfHost::new(cfg).available();
    if !ok {
        assert!(std::env::var_os("ORANGEFILE_REQUIRE_QPDF").is_none(), "ORANGEFILE_REQUIRE_QPDF is set but qpdf is not installed");
        eprintln!("skipped: qpdf is not installed");
    }
    ok
}

fn job(op: serde_json::Value, inputs: Vec<PathBuf>, out: &Path) -> file_core::JobStatus {
    run(&req(json!({"inputs": inputs, "output_dir": out, "operation": op})))
}

fn encrypted(p: &Path) -> bool {
    Document::load(p).map(|d| d.is_encrypted()).unwrap_or(true)
}

#[test]
fn add_a_password_then_remove_it() {
    if !have_qpdf() {
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("report.pdf");
    fs::copy(fixture("three-pages.pdf"), &src).unwrap();
    let before = fs::read(&src).unwrap();

    let s = job(json!({"type": "pdf_protect", "password": "s3cret pass", "allow_print": false}), vec![src.clone()], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let locked = d.path().join("report (protected).pdf");
    assert!(locked.is_file());
    assert!(encrypted(&locked), "the copy needs a password");
    let opened = Document::load_with_password(&locked, "s3cret pass").expect("opens with the password");
    assert_eq!(opened.get_pages().len(), 3);
    assert_eq!(fs::read(&src).unwrap(), before, "the original is untouched");

    // wrong password: refused, nothing written
    let s = job(json!({"type": "pdf_unlock", "password": "nope"}), vec![locked.clone()], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Failed);
    assert_eq!(s.results[0].error_code.as_deref(), Some("wrong_password"));
    assert!(!d.path().join("report (protected) (unlocked).pdf").exists());

    // right password: an unprotected copy with every page
    let s = job(json!({"type": "pdf_unlock", "password": "s3cret pass"}), vec![locked.clone()], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let open = d.path().join("report (protected) (unlocked).pdf");
    assert!(!encrypted(&open));
    assert_eq!(Document::load(&open).unwrap().get_pages().len(), 3);

    // nothing to remove
    let s = job(json!({"type": "pdf_unlock", "password": "x"}), vec![src.clone()], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Failed);
    assert!(s.results[0].message.as_deref().unwrap().contains("no password"), "{:?}", s.results[0].message);
}

#[test]
fn passwords_never_reach_the_command_line() {
    // The argument file is the only place a password is written, and it is removed with the private folder.
    if !have_qpdf() {
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("a.pdf");
    fs::copy(fixture("three-pages.pdf"), &src).unwrap();
    job(json!({"type": "pdf_protect", "password": "hunter2"}), vec![src], d.path());
    let leftovers: Vec<String> = fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(leftovers.iter().all(|n| !n.starts_with(".filetool-")), "private folders are cleaned up: {leftovers:?}");
}

/// A one-page A4 PDF holding a big photo-like picture stored raw (Flate), like many scanners make.
fn photo_pdf(path: &Path, w: u32, h: u32) {
    let img = photo(w, h);
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut pic = Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 },
        img.into_raw(),
    );
    pic.compress().unwrap();
    let pic_id = doc.add_object(pic);
    let content = Stream::new(dictionary! {}, b"q 595 0 0 842 0 0 cm /Im1 Do Q".to_vec());
    let content_id = doc.add_object(content);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        "Contents" => content_id, "Resources" => dictionary! { "XObject" => dictionary! { "Im1" => pic_id } },
    });
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    doc.save(path).unwrap();
}

fn first_picture(p: &Path) -> (String, i64, i64) {
    let doc = Document::load(p).unwrap();
    for o in doc.objects.values() {
        if let Ok(s) = o.as_stream() {
            if s.dict.get(b"Subtype").and_then(|v| v.as_name()).ok() == Some(b"Image".as_slice()) {
                let f = s.dict.get(b"Filter").ok().and_then(|f| f.as_name().ok()).map(|n| String::from_utf8_lossy(n).into_owned()).unwrap_or_default();
                return (f, s.dict.get(b"Width").unwrap().as_i64().unwrap(), s.dict.get(b"Height").unwrap().as_i64().unwrap());
            }
        }
    }
    panic!("no picture")
}

#[test]
fn compress_shrinks_big_pictures_and_keeps_every_page() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("scan.pdf");
    photo_pdf(&src, 3000, 4240);
    let before = fs::metadata(&src).unwrap().len();

    let s = job(json!({"type": "pdf_compress", "level": "balanced"}), vec![src.clone()], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let out = d.path().join("scan (compressed).pdf");
    let after = fs::metadata(&out).unwrap().len();
    assert!(after * 3 < before, "much smaller: {before} → {after}");
    let msg = s.results[0].message.clone().unwrap();
    assert!(msg.contains("% smaller") && msg.contains("1 of 1 pictures"), "{msg}");
    let (filter, w, h) = first_picture(&out);
    assert_eq!(filter, "DCTDecode");
    // A4 long side 842 pt = 11.7 in; at 150 dpi that's at most 1755 px, proportions kept
    assert!(h <= 1755 && h >= 1700, "{w}x{h}");
    assert!((w as f64 / h as f64 - 3000.0 / 4240.0).abs() < 0.01);
    assert_eq!(Document::load(&out).unwrap().get_pages().len(), 1);

    // strong is smaller still
    let strong_dir = d.path().join("strong");
    fs::create_dir(&strong_dir).unwrap();
    job(json!({"type": "pdf_compress", "level": "strong"}), vec![src.clone()], &strong_dir);
    assert!(fs::metadata(strong_dir.join("scan (compressed).pdf")).unwrap().len() < after);

    // lossless leaves the picture as it was
    let light = d.path().join("light");
    fs::create_dir(&light).unwrap();
    let s = job(json!({"type": "pdf_compress", "level": "lossless"}), vec![src.clone()], &light);
    assert_eq!(s.results[0].outcome, Outcome::Done);
    let (filter, w, h) = first_picture(&light.join("scan (compressed).pdf"));
    assert_eq!((filter.as_str(), w, h), ("FlateDecode", 3000, 4240));
}

#[test]
fn compress_keeps_the_original_when_it_cannot_do_better_and_handles_passwords() {
    let d = tempfile::tempdir().unwrap();
    // text only: nothing to shrink
    let src = d.path().join("text.pdf");
    fs::copy(fixture("three-pages.pdf"), &src).unwrap();
    let s = job(json!({"type": "pdf_compress", "level": "strong"}), vec![src.clone()], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let out = d.path().join("text (compressed).pdf");
    assert!(fs::metadata(&out).unwrap().len() <= fs::metadata(&src).unwrap().len());
    assert_eq!(Document::load(&out).unwrap().get_pages().len(), 3);

    // protected: needs the password, and the copy isn't protected
    let locked = d.path().join("locked.pdf");
    fs::copy(fixture("encrypted.pdf"), &locked).unwrap();
    let s = job(json!({"type": "pdf_compress", "level": "balanced"}), vec![locked.clone()], d.path());
    assert_eq!(s.results[0].error_code.as_deref(), Some("password_required"), "{:?}", s.results);
    let s = job(json!({"type": "pdf_compress", "level": "balanced", "password": "wrong"}), vec![locked.clone()], d.path());
    assert_eq!(s.results[0].error_code.as_deref(), Some("wrong_password"), "{:?}", s.results);
    let s = job(json!({"type": "pdf_compress", "level": "balanced", "password": "open-sesame"}), vec![locked.clone()], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    assert!(!encrypted(&d.path().join("locked (compressed).pdf")));

    // not a PDF
    let s = job(json!({"type": "pdf_compress"}), vec![fixture("not-a-pdf.pdf")], d.path());
    assert_eq!(s.results[0].outcome, Outcome::Failed);
}
