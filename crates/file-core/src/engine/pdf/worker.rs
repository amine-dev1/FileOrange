//! The child side of the PDF engine. It reads one JSON request from stdin, loads PDFium,
//! does the work and prints one JSON reply line on stdout. Passwords arrive on stdin only,
//! never in arguments or the environment, so they don't show up in process listings.
//!
//! Handled errors (wrong password, damaged file) are replies with exit code 0. A crash inside
//! PDFium ends the process without a reply, which the host reports as a worker failure.

use super::annotate::{self, Annotation};
use super::draw;
use super::{PageInfo, PdfInfo, PdfMetadata, PdfPermissions, EXPORT_MAX_PIXELS, EXPORT_MAX_SIDE, MAX_PAGES, MAX_RENDER_HEIGHT, MAX_RENDER_PIXELS, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH};
use image::DynamicImage;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Argument that makes an executable behave as a PDF worker.
pub const WORKER_FLAG: &str = "--pdf-worker";

/// One source document for an assemble call.
#[derive(Serialize, Deserialize)]
pub struct AssembleInput {
    pub file: PathBuf,
    pub password: Option<String>,
}

/// One page of the result: which input, which of its pages (from 1) and how many extra
/// degrees clockwise to turn it (0, 90, 180 or 270), on top of the rotation it already has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageRef {
    pub input: u32,
    pub page: u32,
    #[serde(default)]
    pub rotate: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperSize {
    /// Each page is as large as its picture.
    Fit,
    A4,
    Letter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Orientation {
    Auto,
    Portrait,
    Landscape,
}

/// How pictures are put on pages when making a PDF from images.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ImagesLayout {
    pub paper: PaperSize,
    pub orientation: Orientation,
    pub margin_pt: f32,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    /// Build a new PDF from the listed pages, in order, with annotations drawn on top. Sources are only read.
    /// `images` are the pictures the annotations refer to.
    Assemble {
        library: PathBuf,
        inputs: Vec<AssembleInput>,
        pages: Vec<PageRef>,
        out: PathBuf,
        #[serde(default)]
        annotations: Vec<Annotation>,
        #[serde(default)]
        images: Vec<PathBuf>,
    },
    /// One page per picture, in order.
    ImagesToPdf { library: PathBuf, images: Vec<PathBuf>, layout: ImagesLayout, out: PathBuf },
    /// Draw a page for saving as a picture: like `Render`, but with the much larger size limits an export needs.
    Export { library: PathBuf, file: PathBuf, password: Option<String>, page: u32, width: u32, out: PathBuf },
    Probe { library: PathBuf },
    Info { library: PathBuf, file: PathBuf, password: Option<String> },
    Render { library: PathBuf, file: PathBuf, password: Option<String>, page: u32, width: u32, out: PathBuf },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Reply {
    Ok { data: serde_json::Value },
    Err {
        code: String,
        message: String,
        /// Which input of an assemble call the problem is about.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<u32>,
    },
}

struct Fail {
    code: &'static str,
    message: String,
    input: Option<u32>,
}

impl Fail {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), input: None }
    }

    fn on_input(mut self, input: usize) -> Self {
        self.input = Some(input as u32);
        self
    }
}

/// Entry point for both the stand-alone worker binary and `--pdf-worker` re-invocation.
pub fn main() -> i32 {
    let mut raw = Vec::new();
    if std::io::stdin().take(1024 * 1024).read_to_end(&mut raw).is_err() {
        return 2;
    }
    let reply = match serde_json::from_slice::<Request>(&raw) {
        Err(_) => Reply::Err { code: "bad_request".into(), message: "The worker request was not understood.".into(), input: None },
        Ok(req) => match std::panic::catch_unwind(|| handle(req)) {
            Ok(Ok(data)) => Reply::Ok { data },
            Ok(Err(f)) => Reply::Err { code: f.code.into(), message: f.message, input: f.input },
            Err(_) => Reply::Err { code: "internal".into(), message: "The PDF engine hit an internal error.".into(), input: None },
        },
    };
    let mut out = std::io::stdout().lock();
    let line = serde_json::to_string(&reply).unwrap_or_else(|_| r#"{"status":"err","code":"internal","message":"reply failed"}"#.into());
    if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
        return 2;
    }
    0
}

fn handle(req: Request) -> Result<serde_json::Value, Fail> {
    match req {
        Request::Assemble { library, inputs, pages, out, annotations, images } => {
            let engine = bind(&library)?;
            let n = assemble(&engine.pdfium, &inputs, &pages, &annotations, &images, &out)?;
            Ok(serde_json::json!({ "pages": n }))
        }
        Request::ImagesToPdf { library, images, layout, out } => {
            let engine = bind(&library)?;
            let n = images_to_pdf(&engine.pdfium, &images, layout, &out)?;
            Ok(serde_json::json!({ "pages": n }))
        }
        Request::Export { library, file, password, page, width, out } => {
            let engine = bind(&library)?;
            let doc = open(&engine.pdfium, &file, password.as_deref())?;
            let (w, h) = render_with(&doc, page, width, &out, Caps::EXPORT)?;
            Ok(serde_json::json!({ "width": w, "height": h }))
        }
        Request::Probe { library } => {
            bind(&library)?;
            Ok(serde_json::json!({}))
        }
        Request::Info { library, file, password } => {
            let engine = bind(&library)?;
            let doc = open(&engine.pdfium, &file, password.as_deref())?;
            let security = security(engine.raw.as_ref(), &file, password.as_deref());
            Ok(serde_json::to_value(info(&doc, security)?).expect("PdfInfo serializes"))
        }
        Request::Render { library, file, password, page, width, out } => {
            let engine = bind(&library)?;
            let doc = open(&engine.pdfium, &file, password.as_deref())?;
            let (w, h) = render(&doc, page, width, &out)?;
            Ok(serde_json::json!({ "width": w, "height": h }))
        }
    }
}

/// PDFium plus a second handle on the same library, used for the one question the
/// high-level wrapper cannot answer for AES-256 files (their permission bits).
struct Engine {
    pdfium: Pdfium,
    raw: Box<dyn PdfiumLibraryBindings>,
}

fn bind(library: &Path) -> Result<Engine, Fail> {
    let load = || Pdfium::bind_to_library(library).map_err(|e| Fail::new("engine_failed", format!("PDFium could not be loaded: {e}")));
    // Both loads must happen before `Pdfium::new`, which claims the crate's global slot.
    let (for_wrapper, raw) = (load()?, load()?);
    Ok(Engine { pdfium: Pdfium::new(for_wrapper), raw })
}

fn open<'a>(pdfium: &'a Pdfium, file: &Path, password: Option<&str>) -> Result<PdfDocument<'a>, Fail> {
    let password = password.filter(|p| !p.is_empty());
    pdfium.load_pdf_from_file(file, password).map_err(|e| match e {
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
            if password.is_some() {
                Fail::new("wrong_password", "The password is incorrect.")
            } else {
                Fail::new("password_required", "This PDF needs a password.")
            }
        }
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::SecurityError) => {
            Fail::new("unsupported", "This PDF uses a kind of protection that can't be opened.")
        }
        PdfiumError::IoError(e) => Fail::new("io", e.to_string()),
        _ => Fail::new("corrupt_pdf", "The file isn't a readable PDF."),
    })
}

/// Encryption state as the file's security handler reports it.
struct Security {
    encrypted: bool,
    permissions: Option<PdfPermissions>,
}

/// Permission bits per ISO 32000-1 table 22 (bit n is `1 << (n - 1)`).
fn permissions_from_bits(bits: u32) -> PdfPermissions {
    let bit = |n: u32| bits & (1 << (n - 1)) != 0;
    PdfPermissions { print: bit(3), modify: bit(4), copy: bit(5), annotate: bit(6), fill_forms: bit(9) || bit(6), assemble: bit(11) }
}

fn security(raw: &dyn PdfiumLibraryBindings, file: &Path, password: Option<&str>) -> Security {
    let unknown = Security { encrypted: false, permissions: None };
    let Some(path) = file.to_str() else { return unknown };
    // SAFETY: plain PDFium calls on a handle this function opens and closes itself.
    unsafe {
        let handle = raw.FPDF_LoadDocument(path, password.filter(|p| !p.is_empty()));
        if handle.is_null() {
            return unknown;
        }
        let revision = raw.FPDF_GetSecurityHandlerRevision(handle);
        let bits = raw.FPDF_GetDocPermissions(handle) as u32;
        raw.FPDF_CloseDocument(handle);
        // -1 means the file has no security handler.
        if revision < 0 {
            Security { encrypted: false, permissions: None }
        } else {
            Security { encrypted: true, permissions: Some(permissions_from_bits(bits)) }
        }
    }
}

fn info(doc: &PdfDocument, security: Security) -> Result<PdfInfo, Fail> {
    let pages = doc.pages();
    let count = pages.len() as u32;
    if count == 0 {
        return Err(Fail::new("corrupt_pdf", "This PDF has no pages."));
    }
    if count > MAX_PAGES {
        return Err(Fail::new("unsupported", format!("This PDF has {count} pages; at most {MAX_PAGES} are supported.")));
    }
    let sizes = pages.page_sizes().map_err(|_| Fail::new("corrupt_pdf", "The page list couldn't be read."))?;

    let tag = |t: PdfDocumentMetadataTagType| doc.metadata().get(t).map(|m| m.value().trim().to_string()).filter(|v| !v.is_empty());
    let metadata = PdfMetadata {
        title: tag(PdfDocumentMetadataTagType::Title),
        author: tag(PdfDocumentMetadataTagType::Author),
        subject: tag(PdfDocumentMetadataTagType::Subject),
        keywords: tag(PdfDocumentMetadataTagType::Keywords),
        creator: tag(PdfDocumentMetadataTagType::Creator),
        producer: tag(PdfDocumentMetadataTagType::Producer),
        created: tag(PdfDocumentMetadataTagType::CreationDate),
        modified: tag(PdfDocumentMetadataTagType::ModificationDate),
    };

    let has_form = doc.form().is_some_and(|f| !matches!(f.form_type(), PdfFormType::None));
    let mut out = PdfInfo {
        page_count: count,
        pages: sizes.iter().map(|r| PageInfo { width_pt: r.width().value, height_pt: r.height().value }).collect(),
        version: pdf_version(doc.version()),
        encrypted: security.encrypted,
        permissions: security.permissions,
        has_form,
        signature_count: doc.signatures().len() as u32,
        metadata,
        warnings: vec![],
    };
    out.compute_warnings();
    Ok(out)
}

fn assemble(pdfium: &Pdfium, inputs: &[AssembleInput], pages: &[PageRef], annotations: &[Annotation], image_files: &[PathBuf], out: &Path) -> Result<u32, Fail> {
    if pages.is_empty() {
        return Err(Fail::new("invalid_request", "There are no pages to put in the new PDF."));
    }
    if pages.len() as u32 > MAX_PAGES {
        return Err(Fail::new("unsupported", format!("A PDF can have at most {MAX_PAGES} pages here.")));
    }
    let mut docs = Vec::with_capacity(inputs.len());
    for (i, input) in inputs.iter().enumerate() {
        docs.push(open(pdfium, &input.file, input.password.as_deref()).map_err(|f| f.on_input(i))?);
    }
    for p in pages {
        let doc = docs.get(p.input as usize).ok_or_else(|| Fail::new("invalid_request", "A page refers to a file that isn't there."))?;
        if p.page == 0 || p.page > doc.pages().len() as u32 {
            return Err(Fail::new("page_out_of_range", format!("Page {} doesn't exist.", p.page)).on_input(p.input as usize));
        }
        if p.rotate % 90 != 0 || p.rotate >= 360 {
            return Err(Fail::new("invalid_request", "Pages can only be turned by 90, 180 or 270 degrees."));
        }
    }

    let mut result = pdfium.create_new_pdf().map_err(|_| Fail::new("engine_failed", "A new PDF couldn't be started."))?;
    // Consecutive pages from one file are copied in a single call. PDFium then shares fonts and
    // images between them instead of storing a copy per page, which keeps results small.
    let (mut at, mut i) = (0usize, 0usize);
    while i < pages.len() {
        let input = pages[i].input;
        let mut j = i;
        while j < pages.len() && pages[j].input == input {
            j += 1;
        }
        let list = pages[i..j].iter().map(|p| p.page.to_string()).collect::<Vec<_>>().join(",");
        result
            .pages_mut()
            .copy_pages_from_document(&docs[input as usize], &list, at as i32)
            .map_err(|_| Fail::new("corrupt_pdf", "Some pages couldn't be copied.").on_input(input as usize))?;
        at += j - i;
        i = j;
    }

    if !annotations.is_empty() {
        annotate::validate(annotations, image_files.len()).map_err(|e| Fail::new("invalid_request", e.user_message()))?;
        let images = image_files.iter().map(|f| load_image(f)).collect::<Result<Vec<_>, _>>()?;
        let font = result.fonts_mut().helvetica();
        // Annotations belong to a page of the first file; a page used twice gets them twice.
        for (k, p) in pages.iter().enumerate().filter(|(_, p)| p.input == 0) {
            let mine: Vec<&Annotation> = annotations.iter().filter(|a| a.page() == p.page).collect();
            if mine.is_empty() {
                continue;
            }
            let mut page = result.pages().get(k as i32).map_err(|_| Fail::new("corrupt_pdf", "A copied page couldn't be read."))?;
            page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
            for a in mine {
                draw::apply(&mut page, &result, font, a, &images).map_err(|m| Fail::new("engine_failed", format!("An annotation couldn't be drawn ({m}).")))?;
            }
            page.regenerate_content().map_err(|_| Fail::new("engine_failed", "The annotations couldn't be written."))?;
        }
    }

    for (k, p) in pages.iter().enumerate().filter(|(_, p)| p.rotate != 0) {
        let mut page = result.pages().get(k as i32).map_err(|_| Fail::new("corrupt_pdf", "A copied page couldn't be read."))?;
        let current = match page.rotation() {
            Ok(PdfPageRenderRotation::Degrees90) => 90,
            Ok(PdfPageRenderRotation::Degrees180) => 180,
            Ok(PdfPageRenderRotation::Degrees270) => 270,
            _ => 0,
        };
        page.set_rotation(match (current + p.rotate) % 360 {
            90 => PdfPageRenderRotation::Degrees90,
            180 => PdfPageRenderRotation::Degrees180,
            270 => PdfPageRenderRotation::Degrees270,
            _ => PdfPageRenderRotation::None,
        });
    }

    result.save_to_file(out).map_err(|e| match e {
        PdfiumError::IoError(e) => Fail::new("io", e.to_string()),
        _ => Fail::new("engine_failed", "The new PDF couldn't be written."),
    })?;
    Ok(pages.len() as u32)
}

fn pdf_version(v: PdfDocumentVersion) -> Option<String> {
    use PdfDocumentVersion as V;
    Some(match v {
        V::Unset => return None,
        V::Pdf1_0 => "1.0".into(),
        V::Pdf1_1 => "1.1".into(),
        V::Pdf1_2 => "1.2".into(),
        V::Pdf1_3 => "1.3".into(),
        V::Pdf1_4 => "1.4".into(),
        V::Pdf1_5 => "1.5".into(),
        V::Pdf1_6 => "1.6".into(),
        V::Pdf1_7 => "1.7".into(),
        V::Pdf2_0 => "2.0".into(),
        V::Other(n) => format!("{}.{}", n / 10, n % 10),
    })
}

/// Size limits for a drawn page. Previews are small; exports (saving pages as pictures) may be much larger.
#[derive(Clone, Copy)]
pub struct Caps {
    max_w: u32,
    max_h: u32,
    max_pixels: u64,
}

impl Caps {
    pub const PREVIEW: Caps = Caps { max_w: MAX_RENDER_WIDTH, max_h: MAX_RENDER_HEIGHT, max_pixels: MAX_RENDER_PIXELS };
    pub const EXPORT: Caps = Caps { max_w: EXPORT_MAX_SIDE, max_h: EXPORT_MAX_SIDE, max_pixels: EXPORT_MAX_PIXELS };
}

/// The bitmap size for a page: as wide as asked, within the preview bounds, keeping the aspect ratio.
pub fn fit(page_w: f32, page_h: f32, want: u32) -> (u32, u32) {
    fit_within(page_w, page_h, want, Caps::PREVIEW)
}

pub fn fit_within(page_w: f32, page_h: f32, want: u32, caps: Caps) -> (u32, u32) {
    let aspect = f64::from(page_h) / f64::from(page_w);
    let mut w = f64::from(want.clamp(MIN_RENDER_WIDTH, caps.max_w));
    let mut h = (w * aspect).max(1.0);
    if h > f64::from(caps.max_h) {
        h = f64::from(caps.max_h);
        w = h / aspect;
    }
    let pixels = w * h;
    if pixels > caps.max_pixels as f64 {
        let k = (caps.max_pixels as f64 / pixels).sqrt();
        w *= k;
        h *= k;
    }
    (w.round().max(1.0) as u32, h.round().max(1.0) as u32)
}

fn render(doc: &PdfDocument, index: u32, want: u32, out: &Path) -> Result<(u32, u32), Fail> {
    render_with(doc, index, want, out, Caps::PREVIEW)
}

fn render_with(doc: &PdfDocument, index: u32, want: u32, out: &Path, caps: Caps) -> Result<(u32, u32), Fail> {
    let pages = doc.pages();
    if index >= pages.len() as u32 {
        return Err(Fail::new("page_out_of_range", "No such page."));
    }
    let page = pages.get(index as i32).map_err(|_| Fail::new("corrupt_pdf", "This page couldn't be read."))?;
    let (pw, ph) = (page.width().value, page.height().value);
    if !(pw.is_finite() && ph.is_finite() && pw > 0.0 && ph > 0.0) {
        return Err(Fail::new("corrupt_pdf", "This page has no usable size."));
    }
    let (w, h) = fit_within(pw, ph, want, caps);
    let cfg = PdfRenderConfig::new()
        .set_target_size(w as i32, h as i32)
        .set_clear_color(PdfColor::WHITE)
        .render_form_data(true)
        .render_annotations(true);
    let bitmap = page.render_with_config(&cfg).map_err(|_| Fail::new("render_failed", "This page couldn't be drawn."))?;
    let (bw, bh) = (bitmap.width() as u32, bitmap.height() as u32);
    let rgba = bitmap.as_rgba_bytes();
    if rgba.len() != (bw as usize) * (bh as usize) * 4 {
        return Err(Fail::new("render_failed", "The page bitmap had an unexpected layout."));
    }
    // The page is drawn on white, so alpha carries nothing; store RGB.
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }
    write_png(out, &rgb, bw, bh)?;
    Ok((bw, bh))
}

/// A picture ready to go on a page. Plain JPEGs are embedded as they are (no recompression, small files);
/// everything else is decoded, with the camera's orientation applied.
enum Pic {
    Jpeg(PathBuf, u32, u32),
    Decoded(DynamicImage),
}

impl Pic {
    fn size(&self) -> (u32, u32) {
        match self {
            Pic::Jpeg(_, w, h) => (*w, *h),
            Pic::Decoded(i) => (i.width(), i.height()),
        }
    }
}

fn load_pic(path: &Path) -> Result<Pic, Fail> {
    use image::{ImageDecoder, ImageFormat};
    let io = |e: std::io::Error| Fail::new("io", e.to_string());
    let bad = |e: image::ImageError| Fail::new("corrupt_image", format!("This picture is damaged or incomplete ({e})."));
    let mut reader = image::ImageReader::open(path).map_err(io)?.with_guessed_format().map_err(io)?;
    let format = reader.format();
    if !matches!(format, Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP)) {
        return Err(Fail::new("unsupported", "Only JPG, PNG and WebP pictures can be used."));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(crate::engine::image::MAX_DIMENSION);
    limits.max_image_height = Some(crate::engine::image::MAX_DIMENSION);
    limits.max_alloc = Some(1024 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(bad)?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > annotate::MAX_IMAGE_PIXELS {
        return Err(Fail::new("unsupported", "This picture is too large to put on a page."));
    }
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    if format == Some(ImageFormat::Jpeg) && orientation == image::metadata::Orientation::NoTransforms {
        if !crate::engine::image::jpeg_is_complete(path).map_err(io)? {
            return Err(Fail::new("corrupt_image", "This JPEG is cut off before its end."));
        }
        if matches!(decoder.color_type(), image::ColorType::Rgb8 | image::ColorType::L8) {
            return Ok(Pic::Jpeg(path.to_path_buf(), w, h));
        }
    }
    let mut img = DynamicImage::from_decoder(decoder).map_err(bad)?;
    img.apply_orientation(orientation);
    Ok(Pic::Decoded(img))
}

fn load_image(path: &Path) -> Result<DynamicImage, Fail> {
    match load_pic(path)? {
        Pic::Decoded(i) => Ok(i),
        Pic::Jpeg(p, ..) => {
            let reader = image::ImageReader::open(&p).and_then(|r| r.with_guessed_format()).map_err(|e| Fail::new("io", e.to_string()))?;
            reader.decode().map_err(|e| Fail::new("corrupt_image", e.to_string()))
        }
    }
}

const FIT_DPI_POINTS: f32 = 0.75; // a picture "fits" its page at 96 dpi
const MAX_PAGE_POINTS: f32 = 14_400.0;

/// Page size and the box (x, y, w, h) for the picture, in points, for a picture of `iw` x `ih` pixels.
fn layout_for(iw: u32, ih: u32, l: &ImagesLayout) -> ((f32, f32), (f32, f32, f32, f32)) {
    let (iw, ih) = (iw as f32, ih as f32);
    match l.paper {
        PaperSize::Fit => {
            let m = l.margin_pt;
            let shrink = ((MAX_PAGE_POINTS - 2.0 * m) / (iw.max(ih) * FIT_DPI_POINTS)).min(1.0);
            let (w, h) = (iw * FIT_DPI_POINTS * shrink, ih * FIT_DPI_POINTS * shrink);
            ((w + 2.0 * m, h + 2.0 * m), (m, m, w, h))
        }
        PaperSize::A4 | PaperSize::Letter => {
            let (mut pw, mut ph): (f32, f32) = if l.paper == PaperSize::A4 { (595.276, 841.89) } else { (612.0, 792.0) };
            let landscape = match l.orientation {
                Orientation::Landscape => true,
                Orientation::Portrait => false,
                Orientation::Auto => iw > ih,
            };
            if landscape {
                std::mem::swap(&mut pw, &mut ph);
            }
            let m = l.margin_pt.clamp(0.0, pw.min(ph) * 0.4);
            let scale = ((pw - 2.0 * m) / iw).min((ph - 2.0 * m) / ih);
            let (w, h) = (iw * scale, ih * scale);
            ((pw, ph), ((pw - w) / 2.0, (ph - h) / 2.0, w, h))
        }
    }
}

fn images_to_pdf(pdfium: &Pdfium, images: &[PathBuf], layout: ImagesLayout, out: &Path) -> Result<u32, Fail> {
    if images.is_empty() {
        return Err(Fail::new("invalid_request", "Choose at least one picture."));
    }
    if images.len() as u32 > MAX_PAGES {
        return Err(Fail::new("unsupported", format!("A PDF can have at most {MAX_PAGES} pages here.")));
    }
    if !layout.margin_pt.is_finite() || layout.margin_pt < 0.0 || layout.margin_pt > 500.0 {
        return Err(Fail::new("invalid_request", "The margin is out of range."));
    }
    let mut doc = pdfium.create_new_pdf().map_err(|_| Fail::new("engine_failed", "A new PDF couldn't be started."))?;
    for (i, path) in images.iter().enumerate() {
        let pic = load_pic(path).map_err(|f| f.on_input(i))?;
        let (pw, ph) = pic.size();
        let ((w, h), (x, y, bw, bh)) = layout_for(pw, ph, &layout);
        let mut page = doc
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::Custom(PdfPoints::new(w), PdfPoints::new(h)))
            .map_err(|_| Fail::new("engine_failed", "A page couldn't be added."))?;
        match &pic {
            Pic::Decoded(img) => draw::place_image(&mut page, &doc, img, x, y, bw, bh),
            Pic::Jpeg(p, ..) => draw::place_jpeg(&mut page, &doc, p, x, y, bw, bh),
        }
        .map_err(|m| Fail::new("engine_failed", format!("A picture couldn't be placed ({m}).")).on_input(i))?;
    }
    doc.save_to_file(out).map_err(|e| match e {
        PdfiumError::IoError(e) => Fail::new("io", e.to_string()),
        _ => Fail::new("engine_failed", "The new PDF couldn't be written."),
    })?;
    Ok(images.len() as u32)
}

fn write_png(out: &Path, rgb: &[u8], w: u32, h: u32) -> Result<(), Fail> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};
    let io = |e: std::io::Error| Fail::new("io", e.to_string());
    let tmp = out.with_extension("png.part");
    {
        let file = std::fs::File::create(&tmp).map_err(io)?;
        let enc = PngEncoder::new_with_quality(std::io::BufWriter::new(file), CompressionType::Fast, FilterType::Sub);
        enc.write_image(rgb, w, h, ExtendedColorType::Rgb8).map_err(|e| Fail::new("io", e.to_string()))?;
    }
    std::fs::rename(&tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })
}

#[cfg(test)]
mod tests {
    use super::{fit, permissions_from_bits};

    #[test]
    fn permission_bits() {
        let all = permissions_from_bits(0xFFFF_FFFF);
        assert!(all.print && all.copy && all.modify && all.annotate && all.fill_forms && all.assemble);
        let none = permissions_from_bits(0xFFFF_F0C0); // only the reserved bits set
        assert!(!none.print && !none.copy && !none.modify && !none.annotate && !none.fill_forms && !none.assemble);
        let print_only = permissions_from_bits(0xFFFF_F0C0 | 0x4);
        assert!(print_only.print && !print_only.copy);
    }

    #[test]
    fn fit_keeps_aspect_and_obeys_bounds() {
        assert_eq!(fit(595.0, 842.0, 595), (595, 842));
        assert_eq!(fit(595.0, 842.0, 1), (16, 23), "min width");
        let (w, h) = fit(595.0, 842.0, 100_000);
        assert_eq!(w, 4096.min(w));
        assert!(u64::from(w) * u64::from(h) <= 24_000_000 + 8192);
        // A very tall page is limited by height, not width.
        let (w, h) = fit(100.0, 100_000.0, 2000);
        assert!(h <= 8192 && w >= 1);
        // A 200-inch square page at max width is 4096 square: under the pixel cap.
        assert_eq!(fit(14400.0, 14400.0, 4096), (4096, 4096));
    }
}
