mod common;
use common::*;
use file_core::engine::{Availability, ConversionPair, Engine, EngineInfo, OperationSpec, Registry};
use file_core::formats::{FileDescriptor, FormatInfo};
use file_core::request::{JobRequest, Operation, Review};
use file_core::{Error, JobContext, Result};
use serde_json::json;
use std::sync::Arc;

/// A fake engine used to exercise availability and pair handling.
struct Stub {
    availability: Availability,
    pairs: Vec<(&'static str, &'static str)>,
}

impl Engine for Stub {
    fn info(&self) -> EngineInfo {
        EngineInfo { id: "stub".into(), name: "Stub engine".into(), version: "0.0.1".into(), availability: self.availability.clone(), license: "MIT".into() }
    }
    fn formats(&self) -> Vec<FormatInfo> {
        vec![]
    }
    fn operations(&self) -> Vec<OperationSpec> {
        vec![OperationSpec {
            interactive: false,
            id: "convert_image".into(),
            label: "Stub convert".into(),
            description: String::new(),
            inputs: vec!["png".into()],
            outputs: vec!["jpeg".into()],
            pairs: self.pairs.iter().map(|(f, t)| ConversionPair { from: (*f).into(), to: (*t).into(), notes: vec![] }).collect(),
            options: vec![],
        }]
    }
    fn preflight(&self, _: &Operation, _: &[FileDescriptor], _: bool) -> Result<()> {
        Ok(())
    }
    fn review(&self, _: &JobRequest) -> Result<Review> {
        Ok(Review::default())
    }
    fn run(&self, _: &JobRequest, _: &JobContext) -> Result<()> {
        Ok(())
    }
}

fn convert_request(dir: &std::path::Path) -> JobRequest {
    let src = png(&dir.join("a.png"), 4, 4, false);
    req(json!({"inputs": [src], "output_dir": dir, "operation": {"type": "convert_image", "format": "jpeg"}}))
}

#[test]
fn bundled_registry_reports_real_capabilities() {
    // PDFium is a separate library; none is installed in this test, so the PDF engine must say so.
    let no_pdfium = tempfile::tempdir().unwrap();
    let mut cfg = file_core::engine::pdf::HostConfig::for_app();
    cfg.library_dirs = vec![no_pdfium.path().to_path_buf()];
    let no_office = file_core::engine::office::OfficeHost::new(file_core::engine::office::OfficeConfig::nothing());
    let no_qpdf = file_core::engine::qpdf::QpdfHost::new(file_core::engine::qpdf::QpdfConfig::nothing());
    let caps = Registry::bundled_with_hosts(std::sync::Arc::new(file_core::engine::pdf::PdfHost::new(cfg)), std::sync::Arc::new(no_office), std::sync::Arc::new(no_qpdf)).capabilities();
    let engine_ids: Vec<_> = caps.engines.iter().map(|e| e.info.id.as_str()).collect();
    assert_eq!(engine_ids, ["zip", "image", "pdf", "office", "qpdf", "pdfsize"]);
    let (compiled_in, pdf): (Vec<_>, Vec<_>) = caps.engines.iter().filter(|e| e.info.id != "qpdf").partition(|e| e.info.id != "pdf" && e.info.id != "office");
    assert!(compiled_in.iter().all(|e| e.info.availability == Availability::Bundled));
    assert!(compiled_in.iter().all(|e| e.info.version.chars().any(|c| c.is_ascii_digit())), "versions come from Cargo.lock: {:?}", caps.engines);
    assert!(pdf.iter().all(|e| matches!(e.info.availability, Availability::Unavailable { .. })));
    let office = caps.engines.iter().find(|e| e.info.id == "office").unwrap();
    assert!(matches!(office.info.availability, Availability::Unavailable { .. }), "no LibreOffice configured");

    let ops: Vec<_> = caps.operations.iter().map(|o| (o.spec.id.as_str(), o.available)).collect();
    let pdf_off = |ids: &[&'static str]| ids.iter().map(|i| (*i, false)).collect::<Vec<_>>();
    let mut want = vec![("compress", true), ("extract", true), ("convert_image", true), ("resize_image", true)];
    want.extend(pdf_off(&["pdf_view", "pdf_merge", "pdf_split", "images_to_pdf", "pdf_to_images", "pdf_annotate", "pdf_reorder", "pdf_rotate", "pdf_delete_pages", "pdf_extract_pages", "office_to_pdf"]));
    want.extend([("pdf_protect", false), ("pdf_unlock", false), ("pdf_compress", true)]);
    assert_eq!(ops, want);

    let convert = caps.operations.iter().find(|o| o.spec.id == "convert_image").unwrap();
    assert_eq!(convert.spec.pairs.len(), 9, "3 inputs x 3 outputs");
    assert!(convert.spec.pairs.iter().any(|p| p.from == "png" && p.to == "webp"));
    assert!(convert.spec.pairs.iter().all(|p| convert.spec.inputs.contains(&p.from) && convert.spec.outputs.contains(&p.to)));
    let png_to_jpeg = convert.spec.pairs.iter().find(|p| p.from == "png" && p.to == "jpeg").unwrap();
    assert!(png_to_jpeg.notes.iter().any(|n| n.to_lowercase().contains("transparent")), "explains transparency flattening");

    let ids: Vec<_> = caps.formats.iter().map(|f| f.id.as_str()).collect();
    for want in ["jpeg", "png", "webp", "zip"] {
        assert!(ids.contains(&want), "{want} missing from {ids:?}");
    }
    assert!(caps.limits.max_archive_entries > 0 && caps.limits.default_max_extract_bytes > 0);
    assert!(caps.limits.max_webp_dimension <= 16_383);
}

#[test]
fn capabilities_serialise_without_leaking_paths() {
    let caps = Registry::bundled().capabilities();
    let text = serde_json::to_string(&caps).unwrap();
    assert!(!text.contains("/home") && !text.contains("\\Users") && !text.contains("target/"), "{text}");
    let back: file_core::Capabilities = serde_json::from_str(&text).unwrap();
    assert_eq!(back, caps);
}

#[test]
fn unavailable_engine_is_reported_and_refused() {
    let d = tempfile::tempdir().unwrap();
    let reg = Registry::new(vec![Arc::new(Stub { availability: Availability::Unavailable { reason: "not installed".into() }, pairs: vec![("png", "jpeg")] })]);

    let caps = reg.capabilities();
    let op = &caps.operations[0];
    assert!(!op.available);
    assert_eq!(op.unavailable_reason.as_deref(), Some("not installed"));
    assert_eq!(serde_json::to_value(&caps.engines[0].info.availability).unwrap(), json!({"status": "unavailable", "reason": "not installed"}));

    let err = reg.engine_for("convert_image").err().unwrap();
    assert_eq!(err.code(), "engine_unavailable");
    assert!(err.user_message().contains("not installed"));

    let r = convert_request(d.path());
    assert_eq!(file_core::request::validate_with(&reg, &r).unwrap_err().code(), "engine_unavailable");
    assert_eq!(file_core::request::run_with(&reg, &r, &JobContext::silent()).unwrap_err().code(), "engine_unavailable");
    assert!(std::fs::read_dir(d.path()).unwrap().all(|e| e.unwrap().file_name().to_string_lossy() == "a.png"), "nothing was written");
}

#[test]
fn unsupported_pairs_and_operations_are_refused() {
    let reg = Registry::new(vec![Arc::new(Stub { availability: Availability::Bundled, pairs: vec![("png", "jpeg")] })]);
    assert!(reg.check_pair("convert_image", "png", "jpeg").is_ok());
    let e = reg.check_pair("convert_image", "png", "webp").unwrap_err();
    assert!(matches!(e, Error::UnsupportedConversion { .. }));
    assert_eq!(e.code(), "unsupported_conversion");
    assert!(e.user_message().contains("PNG") && e.user_message().contains("WEBP"));
    assert!(matches!(reg.check_pair("convert_image", "jpeg", "png"), Err(Error::UnsupportedConversion { .. })));
    assert_eq!(reg.check_pair("pdf_merge", "pdf", "pdf").unwrap_err().code(), "unsupported");
    assert_eq!(reg.engine_for("extract").err().unwrap().code(), "unsupported", "no engine for an unknown operation");
}

#[test]
fn bundled_engines_check_content_not_extensions() {
    let d = tempfile::tempdir().unwrap();
    let reg = Registry::bundled();
    let op: Operation = serde_json::from_value(json!({"type": "convert_image", "format": "png"})).unwrap();
    let engine = reg.engine_for("convert_image").unwrap();
    let desc = |name: &str, format: Option<&str>| FileDescriptor { name: name.into(), size: 1, format: format.map(String::from) };

    // strict (API): unknown content is refused; lenient (local batch): left for the job to report
    assert_eq!(engine.preflight(&op, &[desc("note.png", None)], true).unwrap_err().code(), "unsupported_format");
    assert!(engine.preflight(&op, &[desc("note.png", None)], false).is_ok());
    assert_eq!(engine.preflight(&op, &[desc("anim.gif", Some("gif"))], true).unwrap_err().code(), "unsupported_format");
    assert!(engine.preflight(&op, &[desc("a.jpg", Some("jpeg")), desc("b.png", Some("png"))], true).is_ok());

    // a PNG named .jpg is detected as a PNG and converts fine
    let real = png(&d.path().join("real.png"), 8, 8, false);
    let disguised = d.path().join("real.jpg");
    std::fs::rename(&real, &disguised).unwrap();
    assert_eq!(file_core::formats::detect_file(&disguised), Some("png"));
    let out = d.path().join("o");
    std::fs::create_dir(&out).unwrap();
    let s = run(&req(json!({"inputs": [disguised], "output_dir": out, "operation": {"type": "convert_image", "format": "webp"}})));
    assert_eq!(s.results[0].outcome, file_core::Outcome::Done, "{:?}", s.results);

    // extract refuses non-ZIP content when strict
    let extract: Operation = serde_json::from_value(json!({"type": "extract"})).unwrap();
    let z = reg.engine_for("extract").unwrap();
    assert_eq!(z.preflight(&extract, &[desc("fake.zip", Some("png"))], true).unwrap_err().code(), "unsupported_format");
    assert!(z.preflight(&extract, &[desc("ok.zip", Some("zip"))], true).is_ok());
}

#[test]
fn option_specs_are_valid_data() {
    let caps = Registry::bundled().capabilities();
    for op in &caps.operations {
        for o in &op.spec.options {
            assert!(!o.id.is_empty() && !o.label.is_empty());
            for a in &o.applies_to {
                assert!(op.spec.outputs.contains(&a.format), "{} applies to unknown output {}", o.id, a.format);
                if let Some(w) = &a.when {
                    assert!(op.spec.options.iter().any(|x| x.id == w.option), "{} depends on missing option {}", o.id, w.option);
                }
            }
        }
    }
}
