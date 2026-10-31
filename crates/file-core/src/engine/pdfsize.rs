//! Compress PDF: make PDFs smaller without Ghostscript.
//!
//! Most of a heavy PDF is usually its pictures (scans, photos). At the "balanced" and "strong" levels each picture that is
//! larger than needed for its page is scaled down to a target resolution and saved again as JPEG; pictures are only
//! replaced when that makes them clearly smaller. Then the file is tidied: unused objects dropped, streams compressed,
//! and, when qpdf is available, objects packed into object streams. The "lossless" level only does the tidying.
//!
//! What is left alone: masks and transparency (soft masks), CMYK and other colour spaces, 16-bit and 1-bit pictures,
//! JPEG 2000, JBIG2 and fax-coded pictures, pictures with decode arrays or colour-key masks. Text and drawings are vectors
//! and are never touched. The result is checked (it opens and has the same pages) before it replaces anything; if it
//! isn't smaller, the original is kept and the result says so.
//!
//! PDFs are parsed in this process by lopdf (Rust, memory-safe), with limits on how much any stream may expand to, so
//! a crafted file can't exhaust memory.

use super::qpdf::{self, QpdfHost};
use super::{Availability, Choice, Engine, EngineInfo, OperationSpec, OptionKind, OptionSpec};
use crate::error::{Error, IoContext, Result};
use crate::formats::{self, FileDescriptor, FormatInfo};
use crate::fs_safe::{self, Committed};
use crate::job::{FileResult, JobContext};
use crate::request::{JobRequest, Operation, Review, Secret, MAX_CONFLICTS};
use lopdf::{Document, Object, ObjectId};
use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;

pub const OP: &str = "pdf_compress";
/// Largest PDF compressed (it is held in memory while it is rewritten).
pub const MAX_INPUT_BYTES: u64 = 300 * 1024 * 1024;
/// Largest decoded picture worked on, in bytes (about 33 megapixels of RGB).
const MAX_PICTURE_BYTES: usize = 100 * 1024 * 1024;
/// A picture is replaced only when the new one is at most this fraction of the old one.
const KEEP_IF_UNDER: f64 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// Nothing visible changes.
    Lossless,
    /// Pictures at about 150 dpi, JPEG quality 75: fine on screens and for most printing.
    #[default]
    Balanced,
    /// Pictures at about 100 dpi, quality 55: smallest, for email and uploads.
    Strong,
}

impl Level {
    fn picture_settings(self) -> Option<(f32, u8)> {
        match self {
            Level::Lossless => None,
            Level::Balanced => Some((150.0, 75)),
            Level::Strong => Some((100.0, 55)),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PdfCompressOptions {
    #[serde(default)]
    pub level: Level,
    /// For protected PDFs. The compressed copy is not protected.
    pub password: Option<Secret>,
}

pub struct PdfSizeEngine {
    qpdf: Arc<QpdfHost>,
}

impl PdfSizeEngine {
    pub fn new(qpdf: Arc<QpdfHost>) -> Self {
        Self { qpdf }
    }
}

fn display(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn out_name(input: &Path) -> String {
    format!("{} (compressed).pdf", qpdf::stem(input))
}

impl Engine for PdfSizeEngine {
    fn info(&self) -> EngineInfo {
        EngineInfo {
            id: "pdfsize".into(),
            name: "PDF compression".into(),
            version: format!("lopdf {}{}", env!("FC_VER_LOPDF"), if self.qpdf.available() { format!(" + qpdf {}", self.qpdf.version()) } else { String::new() }),
            availability: Availability::Bundled,
            license: "MIT (lopdf); Apache-2.0 (qpdf, when present)".into(),
        }
    }

    fn operations(&self) -> Vec<OperationSpec> {
        vec![OperationSpec {
            id: OP.into(),
            label: "Compress PDF".into(),
            description: "Make PDFs smaller by resizing and recompressing the pictures inside them. Text stays sharp.".into(),
            inputs: vec![formats::PDF.into()],
            outputs: vec![formats::PDF.into()],
            pairs: vec![],
            options: vec![
                OptionSpec {
                    id: "level".into(),
                    label: "Compression".into(),
                    help: Some("Text and drawings always stay sharp; only pictures change.".into()),
                    kind: OptionKind::Choice {
                        choices: vec![
                            Choice { value: "lossless".into(), label: "Light (no visible change)".into() },
                            Choice { value: "balanced".into(), label: "Balanced".into() },
                            Choice { value: "strong".into(), label: "Strong (smallest)".into() },
                        ],
                        default: "balanced".into(),
                    },
                    applies_to: vec![],
                },
                OptionSpec { id: "password".into(), label: "Password".into(), help: Some("Only if the PDF is protected. The compressed copy isn't.".into()), kind: OptionKind::Secret, applies_to: vec![] },
            ],
            interactive: false,
        }]
    }

    fn formats(&self) -> Vec<FormatInfo> {
        vec![]
    }

    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()> {
        let Operation::PdfCompress(_) = op else {
            return Err(Error::Unsupported("the PDF compression engine does not handle this operation".into()));
        };
        for f in files {
            match f.format.as_deref() {
                Some(formats::PDF) => {}
                Some(_) => return Err(Error::UnsupportedFormat(f.name.clone())),
                None if strict => return Err(Error::UnsupportedFormat(f.name.clone())),
                None => {}
            }
            if f.size > MAX_INPUT_BYTES {
                return Err(Error::InvalidRequest(format!("“{}” is larger than the 300 MB this can compress.", f.name)));
            }
        }
        Ok(())
    }

    fn review(&self, req: &JobRequest) -> Result<Review> {
        let mut r = Review::default();
        for p in &req.inputs {
            r.total_bytes += fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            if formats::detect_file(p) != Some(formats::PDF) {
                r.errors.push(format!("“{}” isn't a PDF.", display(p)));
            }
            let target = req.output_dir.join(out_name(p));
            if fs::symlink_metadata(&target).is_ok() && r.conflicts.len() < MAX_CONFLICTS {
                r.conflicts.push(target);
            }
        }
        Ok(r)
    }

    fn run(&self, req: &JobRequest, ctx: &JobContext) -> Result<()> {
        let Operation::PdfCompress(o) = &req.operation else {
            return Err(Error::Unsupported("the PDF compression engine does not handle this operation".into()));
        };
        ctx.set_totals(req.inputs.len() as u64, Some(req.inputs.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum()));
        for input in &req.inputs {
            ctx.check_cancelled()?;
            ctx.begin_file(&display(input));
            let size = fs::metadata(input).map(|m| m.len()).unwrap_or(0);
            match self.one(input, o, req, ctx) {
                Ok((Committed::Written(p), note)) => {
                    ctx.add_output(p.clone());
                    ctx.add_result(FileResult::done(display(input), p, Some(note)));
                }
                Ok((Committed::Skipped, _)) => ctx.add_result(FileResult::skipped(display(input), "A file with this name already exists, so it was skipped.")),
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(e) => ctx.add_result(FileResult::failed(display(input), &e)),
            }
            ctx.add_bytes(size);
            ctx.file_processed();
        }
        Ok(())
    }
}

/// What happened to the pictures, for the result note.
#[derive(Default, Debug)]
pub struct PictureReport {
    pub seen: usize,
    pub replaced: usize,
}

impl PdfSizeEngine {
    fn one(&self, input: &Path, o: &PdfCompressOptions, req: &JobRequest, ctx: &JobContext) -> Result<(Committed, String)> {
        let meta = fs::metadata(input).at(input)?;
        if !meta.is_file() || formats::detect_file(input) != Some(formats::PDF) {
            return Err(Error::UnsupportedFormat(display(input)));
        }
        if meta.len() > MAX_INPUT_BYTES {
            return Err(Error::InvalidRequest("This PDF is larger than the 300 MB that can be compressed.".into()));
        }
        let desired = req.output_dir.join(out_name(input));
        if fs_safe::resolve_destination(&desired, req.conflict, &req.inputs)? == fs_safe::Resolved::Skip {
            return Ok((Committed::Skipped, String::new()));
        }
        let work = tempfile::Builder::new().prefix(".filetool-pdfsize-").tempdir_in(&req.output_dir).at(&req.output_dir)?;
        let before = meta.len();

        let password = o.password.as_ref().map(|p| p.expose()).unwrap_or("");
        let mut doc = load(input, password)?;
        let pages = doc.get_pages().len();
        ctx.check_cancelled()?;
        let report = match o.level.picture_settings() {
            Some((dpi, quality)) => shrink_pictures(&mut doc, dpi, quality, &|| ctx.check_cancelled())?,
            None => PictureReport::default(),
        };
        ctx.check_cancelled()?;
        doc.prune_objects();
        doc.delete_zero_length_streams();
        doc.compress();
        let rewritten = work.path().join("rewritten.pdf");
        doc.save(&rewritten).map_err(|e| Error::PdfTool(format!("it couldn't be written ({e})")))?;
        drop(doc);

        // Pack it tighter with qpdf when it is there; a failure here just keeps the lopdf result.
        let mut best = rewritten.clone();
        if self.qpdf.available() {
            let packed = work.path().join("packed.pdf");
            let args = ["--object-streams=generate", "--compress-streams=y", "--recompress-flate", "--compression-level=9", "rewritten.pdf", "packed.pdf"].map(String::from);
            if let Ok(qpdf::Outcome::Ok | qpdf::Outcome::Warnings) = self.qpdf.run(&args, work.path(), &ctx.cancel_token()) {
                if packed.is_file() && size_of(&packed) < size_of(&rewritten) {
                    best = packed;
                }
            }
        }
        ctx.check_cancelled()?;

        // Check before trusting it: it opens, and every page is there.
        let ok = Document::load(&best).map(|d| d.get_pages().len() == pages).unwrap_or(false);
        if !ok {
            return Err(Error::PdfTool("the compressed copy didn't check out, so nothing was saved".into()));
        }
        let after = size_of(&best);
        let encrypted = qpdf::is_encrypted(input);
        let (source, note) = if after < before {
            let pct = ((before - after) as f64 / before as f64 * 100.0).round() as u64;
            let pics = if report.replaced > 0 { format!(" {} of {} pictures made lighter.", report.replaced, report.seen) } else { String::new() };
            (best, format!("{pct}% smaller.{pics}"))
        } else if encrypted {
            // The original can't stand in: it is protected and the copy must not be.
            (best, "Already about as small as it gets; this copy just has no password.".into())
        } else {
            (input.to_path_buf(), "Already about as small as it gets, so the copy is the same as the original.".into())
        };
        let tmp = fs_safe::temp_in(&req.output_dir)?;
        fs::copy(&source, tmp.path()).at(&req.output_dir)?;
        ctx.check_cancelled()?;
        Ok((fs_safe::commit(tmp, &desired, req.conflict, &req.inputs)?, note))
    }
}

fn size_of(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(u64::MAX)
}

fn load(input: &Path, password: &str) -> Result<Document> {
    let opts = lopdf::LoadOptions { max_decompressed_size: Some(MAX_PICTURE_BYTES), ..Default::default() };
    let bytes = fs::read(input).at(input)?;
    let mut doc = Document::load_mem_with_options(&bytes, opts).map_err(|e| match e {
        lopdf::Error::Decryption(_) | lopdf::Error::InvalidPassword => if password.is_empty() { Error::PasswordRequired } else { Error::WrongPassword },
        _ => Error::PdfTool(format!("it may be damaged ({e})")),
    })?;
    if doc.is_encrypted() {
        doc.decrypt(password).map_err(|_| if password.is_empty() { Error::PasswordRequired } else { Error::WrongPassword })?;
    }
    Ok(doc)
}

/// The largest page side, in points (1/72 inch), used to work out how many pixels a picture needs at most.
fn largest_page_side(doc: &Document) -> f32 {
    let mut best: f32 = 0.0;
    for (_, id) in doc.get_pages() {
        let side = doc
            .get_dictionary(id)
            .ok()
            .and_then(|d| d.get(b"MediaBox").ok())
            .and_then(|b| doc.dereference(b).ok().map(|(_, o)| o.clone()))
            .and_then(|b| b.as_array().ok().cloned())
            .and_then(|a| {
                let v: Vec<f32> = a.iter().filter_map(|x| x.as_float().ok()).collect();
                (v.len() == 4).then(|| (v[2] - v[0]).abs().max((v[3] - v[1]).abs()))
            })
            .unwrap_or(842.0);
        best = best.max(side);
    }
    if best <= 0.0 { 842.0 } else { best.min(14_400.0) }
}

enum Kind {
    Jpeg,
    Raw,
}

/// Resize and recompress the pictures this can handle safely. Returns how many there were and how many changed.
pub fn shrink_pictures(doc: &mut Document, dpi: f32, quality: u8, check: &dyn Fn() -> Result<()>) -> Result<PictureReport> {
    let max_px = ((largest_page_side(doc) / 72.0) * dpi).ceil().max(64.0) as u32;
    // Soft masks are pictures too, but they carry transparency: never turn them into JPEG.
    let mut masks: HashSet<ObjectId> = HashSet::new();
    for obj in doc.objects.values() {
        if let Object::Stream(s) = obj {
            if let Ok(Object::Reference(id)) = s.dict.get(b"SMask") {
                masks.insert(*id);
            }
        }
    }
    let ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| match o {
            Object::Stream(s) if s.dict.get(b"Subtype").ok().and_then(|v| v.as_name().ok()) == Some(b"Image".as_slice()) => Some(*id),
            _ => None,
        })
        .collect();
    let mut report = PictureReport { seen: ids.len(), replaced: 0 };
    for id in ids {
        check()?;
        if masks.contains(&id) {
            continue;
        }
        let Some((kind, channels)) = classify(doc, id) else { continue };
        let Some(Object::Stream(s)) = doc.objects.get(&id) else { continue };
        let w = s.dict.get(b"Width").and_then(|v| v.as_i64()).unwrap_or(0);
        let h = s.dict.get(b"Height").and_then(|v| v.as_i64()).unwrap_or(0);
        if w <= 0 || h <= 0 || (w as usize).saturating_mul(h as usize).saturating_mul(channels) > MAX_PICTURE_BYTES {
            continue;
        }
        let (w, h) = (w as u32, h as u32);
        let old_len = s.content.len();
        let decoded = match kind {
            Kind::Jpeg => image::load_from_memory_with_format(&s.content, image::ImageFormat::Jpeg).ok(),
            Kind::Raw => s.decompressed_content_with_limit(MAX_PICTURE_BYTES).ok().and_then(|px| raw_image(px, w, h, channels)),
        };
        let Some(mut img) = decoded else { continue };
        if (img.width(), img.height()) != (w, h) {
            continue; // the file and the picture disagree: leave it
        }
        let scale = (max_px as f32 / w.max(h) as f32).min(1.0);
        let resized = scale < 0.95;
        if !resized && matches!(kind, Kind::Jpeg) && quality >= 75 {
            continue; // a JPEG at the right size is already compressed; saving it again would only lose detail
        }
        if resized {
            let (nw, nh) = (((w as f32 * scale).round() as u32).max(1), ((h as f32 * scale).round() as u32).max(1));
            img = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
        }
        let img = if channels == 1 { image::DynamicImage::ImageLuma8(img.to_luma8()) } else { image::DynamicImage::ImageRgb8(img.to_rgb8()) };
        let mut jpeg = Vec::new();
        if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality).encode_image(&img).is_err() {
            continue;
        }
        if (jpeg.len() as f64) > old_len as f64 * KEEP_IF_UNDER {
            continue;
        }
        if let Some(Object::Stream(s)) = doc.objects.get_mut(&id) {
            s.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            s.dict.remove(b"DecodeParms");
            s.dict.set("Width", Object::Integer(img.width() as i64));
            s.dict.set("Height", Object::Integer(img.height() as i64));
            s.dict.set("BitsPerComponent", Object::Integer(8));
            s.set_content(jpeg);
            report.replaced += 1;
        }
    }
    Ok(report)
}

/// JPEG or raw (Flate/uncompressed) 8-bit gray or RGB, with nothing unusual about it; anything else is None.
fn classify(doc: &Document, id: ObjectId) -> Option<(Kind, usize)> {
    let Some(Object::Stream(s)) = doc.objects.get(&id) else { return None };
    let d = &s.dict;
    if d.get(b"ImageMask").and_then(|v| v.as_bool()).unwrap_or(false) || d.has(b"Decode") || d.has(b"Mask") {
        return None;
    }
    if d.get(b"BitsPerComponent").and_then(|v| v.as_i64()).unwrap_or(0) != 8 {
        return None;
    }
    let channels = match d.get(b"ColorSpace").ok().map(|c| doc.dereference(c).map(|(_, o)| o.clone())) {
        Some(Ok(Object::Name(n))) if n == b"DeviceRGB" => 3,
        Some(Ok(Object::Name(n))) if n == b"DeviceGray" => 1,
        Some(Ok(Object::Array(a))) if a.first().and_then(|x| x.as_name().ok()) == Some(b"ICCBased".as_slice()) => {
            let n = a.get(1).and_then(|r| doc.dereference(r).ok()).and_then(|(_, o)| o.as_stream().ok().and_then(|st| st.dict.get(b"N").and_then(|v| v.as_i64()).ok()));
            match n {
                Some(3) => 3,
                Some(1) => 1,
                _ => return None,
            }
        }
        _ => return None,
    };
    let filters: Vec<Vec<u8>> = match d.get(b"Filter") {
        Err(_) => vec![],
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(a)) => a.iter().filter_map(|x| x.as_name().ok().map(|n| n.to_vec())).collect(),
        Ok(_) => return None,
    };
    match filters.as_slice() {
        [f] if f == b"DCTDecode" => Some((Kind::Jpeg, channels)),
        [] => Some((Kind::Raw, channels)),
        [f] if f == b"FlateDecode" => Some((Kind::Raw, channels)),
        _ => None,
    }
}

fn raw_image(px: Vec<u8>, w: u32, h: u32, channels: usize) -> Option<image::DynamicImage> {
    if px.len() != (w as usize) * (h as usize) * channels {
        return None;
    }
    match channels {
        1 => image::GrayImage::from_raw(w, h, px).map(image::DynamicImage::ImageLuma8),
        3 => image::RgbImage::from_raw(w, h, px).map(image::DynamicImage::ImageRgb8),
        _ => None,
    }
}
