//! Image engine: JPG / PNG / WebP conversion.
//!
//! * JPEG, PNG and lossless WebP are written by the `image` crate.
//! * Lossy WebP is written by libwebp (through the `webp` crate); the RIFF
//!   container is then completed by hand with the colour profile and EXIF.
//! * Orientation is always applied to the pixels, so no viewer can rotate an
//!   image twice or not at all. If photo information is kept, its orientation
//!   tag is reset to "normal".
//! * A colour profile is always kept (dropping it changes how colours look);
//!   privacy-sensitive EXIF is kept only when the user asks.

use crate::error::{Error, IoContext, Result};
use crate::formats::{self, FileDescriptor, FormatInfo};
use crate::fs_safe::{self, Committed, ConflictPolicy, Resolved};
use crate::job::{FileResult, JobContext};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

pub const MAX_DIMENSION: u32 = 32_768;
/// A hard limit of the WebP format.
pub const MAX_WEBP_DIMENSION: u32 = 16_383;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    Jpeg,
    Png,
    Webp,
}

impl OutputFormat {
    pub fn extension(self) -> &'static str {
        match self {
            OutputFormat::Jpeg => "jpg",
            OutputFormat::Png => "png",
            OutputFormat::Webp => "webp",
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            OutputFormat::Jpeg => formats::JPEG,
            OutputFormat::Png => formats::PNG,
            OutputFormat::Webp => formats::WEBP,
        }
    }
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            formats::JPEG => Some(OutputFormat::Jpeg),
            formats::PNG => Some(OutputFormat::Png),
            formats::WEBP => Some(OutputFormat::Webp),
            _ => None,
        }
    }
}

/// What to write: a fixed format, or the format each picture already has (resizing and compressing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageTarget {
    Jpeg,
    Png,
    Webp,
    Keep,
}

impl ImageTarget {
    pub fn fixed(self) -> Option<OutputFormat> {
        match self {
            ImageTarget::Jpeg => Some(OutputFormat::Jpeg),
            ImageTarget::Png => Some(OutputFormat::Png),
            ImageTarget::Webp => Some(OutputFormat::Webp),
            ImageTarget::Keep => None,
        }
    }
    pub fn resolve(self, input: OutputFormat) -> OutputFormat {
        self.fixed().unwrap_or(input)
    }
    /// The format id, or "keep".
    pub fn id(self) -> &'static str {
        self.fixed().map(OutputFormat::id).unwrap_or("keep")
    }
}

impl From<OutputFormat> for ImageTarget {
    fn from(f: OutputFormat) -> Self {
        match f {
            OutputFormat::Jpeg => ImageTarget::Jpeg,
            OutputFormat::Png => ImageTarget::Png,
            OutputFormat::Webp => ImageTarget::Webp,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResizeMode {
    /// Keep the size.
    #[default]
    None,
    /// Both sides scaled by `resize_percent`.
    Percent,
    /// Made to fit within `max_width` × `max_height`, keeping the proportions. Never enlarged.
    Fit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebpMode {
    /// Smaller files; quality reduced slightly (uses the quality setting).
    #[default]
    Lossy,
    /// Exact pixels; larger files.
    Lossless,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageOptions {
    pub format: ImageTarget,
    /// 1-100. Used for JPG, and for WebP in lossy mode.
    #[serde(default = "default_quality")]
    pub quality: u8,
    /// Keep EXIF (camera, location, ...). Off by default for privacy.
    #[serde(default)]
    pub keep_metadata: bool,
    #[serde(default)]
    pub webp_mode: WebpMode,
    /// `#RRGGBB`. JPG cannot store transparency, so transparent areas take this colour.
    #[serde(default = "default_background")]
    pub background: String,
    #[serde(default)]
    pub resize_mode: ResizeMode,
    /// 1-100, for `ResizeMode::Percent`.
    #[serde(default = "default_percent")]
    pub resize_percent: u32,
    /// For `ResizeMode::Fit`; missing or 0 means no limit on that side.
    #[serde(default)]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub max_height: Option<u32>,
    /// Aim for files no bigger than this many kilobytes (1 KB = 1000 bytes), by lowering the quality as little as needed.
    /// JPG and lossy WebP only; missing or 0 means no target.
    #[serde(default)]
    pub target_kb: Option<u32>,
}

impl ImageOptions {
    /// Plain conversion to `format` with default settings.
    pub fn convert_to(format: OutputFormat) -> Self {
        Self {
            format: format.into(),
            quality: default_quality(),
            keep_metadata: false,
            webp_mode: WebpMode::default(),
            background: default_background(),
            resize_mode: ResizeMode::None,
            resize_percent: default_percent(),
            max_width: None,
            max_height: None,
            target_kb: None,
        }
    }
    fn target_bytes(&self) -> Option<u64> {
        self.target_kb.filter(|&k| k > 0).map(|k| k as u64 * 1000)
    }
}

fn default_percent() -> u32 {
    50
}

/// Largest size target accepted, in KB.
pub const MAX_TARGET_KB: u32 = 1_000_000;

/// The size after resizing, or None when the picture keeps its size.
pub fn resized_dimensions(w: u32, h: u32, o: &ImageOptions) -> Option<(u32, u32)> {
    let (nw, nh) = match o.resize_mode {
        ResizeMode::None => return None,
        ResizeMode::Percent => {
            let p = o.resize_percent.clamp(1, 100) as u64;
            (((w as u64 * p) / 100).max(1) as u32, ((h as u64 * p) / 100).max(1) as u32)
        }
        ResizeMode::Fit => {
            let mw = o.max_width.filter(|&v| v > 0).unwrap_or(u32::MAX) as f64;
            let mh = o.max_height.filter(|&v| v > 0).unwrap_or(u32::MAX) as f64;
            let scale = (mw / w as f64).min(mh / h as f64).min(1.0);
            (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1))
        }
    };
    ((nw, nh) != (w, h)).then_some((nw, nh))
}

fn default_quality() -> u8 {
    85
}

fn default_background() -> String {
    "#FFFFFF".into()
}

fn parse_hex_colour(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.is_ascii() {
        return None;
    }
    let v = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([v(0)?, v(2)?, v(4)?])
}

pub fn output_path(input: &Path, output_dir: &Path, format: OutputFormat) -> PathBuf {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    output_dir.join(format!("{stem}.{}", format.extension()))
}

/// Heads-up messages for the review screen.
pub fn warnings_for(inputs: &[PathBuf], opts: &ImageOptions) -> Vec<String> {
    let found: Vec<Option<&str>> = inputs.iter().map(|p| formats::detect_file(p)).collect();
    let any = |f: &str| found.contains(&Some(f));
    let mut w = Vec::new();
    match opts.format.fixed() {
        None => {}
        Some(OutputFormat::Jpeg) => {
            if any(formats::PNG) || any(formats::WEBP) {
                w.push(format!("JPEG doesn't support transparency. Transparent areas will be filled with {}.", opts.background.to_uppercase()));
            }
            w.push("JPEG is a lossy format: each save reduces image quality slightly.".into());
        }
        Some(OutputFormat::Png) => {
            if any(formats::JPEG) || any(formats::WEBP) {
                w.push("PNG is lossless, so converting a JPEG or WebP won't restore lost quality and the file will probably be larger.".into());
            }
        }
        Some(OutputFormat::Webp) => match opts.webp_mode {
            WebpMode::Lossy => w.push(format!("Lossy WebP reduces quality slightly (quality {}). Transparency is kept.", opts.quality)),
            WebpMode::Lossless => w.push("Lossless WebP keeps every pixel exactly, so files are larger than lossy WebP or JPG.".into()),
        },
    }
    if opts.target_bytes().is_some() && (opts.format == ImageTarget::Png || (opts.format == ImageTarget::Keep && any(formats::PNG))) {
        w.push("PNG is lossless, so a size target can't be applied to PNG pictures. Make them smaller, or convert them to JPG or WebP.".into());
    }
    if !opts.keep_metadata && (any(formats::JPEG) || any(formats::WEBP)) {
        w.push("Camera and location details (EXIF) will be removed. The colour profile is kept so colours look the same.".into());
    }
    w
}

fn composite_on(img: &DynamicImage, bg: [u8; 3]) -> DynamicImage {
    let mut rgba = img.to_rgba8();
    for px in rgba.pixels_mut() {
        let a = px[3] as u32;
        for c in 0..3 {
            px[c] = ((px[c] as u32 * a + bg[c] as u32 * (255 - a) + 127) / 255) as u8;
        }
        px[3] = 255;
    }
    DynamicImage::ImageRgba8(rgba).into_rgb8().into()
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_DIMENSION);
    l.max_image_height = Some(MAX_DIMENSION);
    l.max_alloc = Some(2 * 1024 * 1024 * 1024);
    l
}

// ------------------------------------------------------------ metadata helpers

/// Set the EXIF Orientation tag (0x0112) to 1 ("upright"). The pixels were
/// already rotated, so a viewer that honours the tag must not rotate again.
/// Anything unexpected leaves the data untouched.
pub fn reset_exif_orientation(exif: Vec<u8>) -> Vec<u8> {
    fn go(data: &mut [u8]) -> Option<()> {
        let base = if data.starts_with(b"Exif\0\0") { 6 } else { 0 };
        let tiff = data.get(base..)?;
        let le = match tiff.get(..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let u16_at = |b: &[u8], o: usize| -> Option<u16> {
            let v: [u8; 2] = b.get(o..o + 2)?.try_into().ok()?;
            Some(if le { u16::from_le_bytes(v) } else { u16::from_be_bytes(v) })
        };
        let u32_at = |b: &[u8], o: usize| -> Option<u32> {
            let v: [u8; 4] = b.get(o..o + 4)?.try_into().ok()?;
            Some(if le { u32::from_le_bytes(v) } else { u32::from_be_bytes(v) })
        };
        if u16_at(tiff, 2)? != 42 {
            return None;
        }
        let ifd = u32_at(tiff, 4)? as usize;
        let count = u16_at(tiff, ifd)? as usize;
        for i in 0..count.min(256) {
            let e = ifd + 2 + i * 12;
            if u16_at(tiff, e)? == 0x0112 {
                let (typ, n) = (u16_at(tiff, e + 2)?, u32_at(tiff, e + 4)?);
                if typ != 3 || n != 1 {
                    return None;
                }
                let one = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
                data.get_mut(base + e + 8..base + e + 10)?.copy_from_slice(&one);
                return Some(());
            }
        }
        None
    }
    let mut out = exif;
    let mut copy = out.clone();
    if go(&mut copy).is_some() {
        out = copy;
    }
    out
}

/// Keep an ICC profile only if its colour space matches the pixels we write
/// (an RGB profile on grey pixels, or a CMYK profile on converted RGB pixels, would be wrong).
fn usable_icc(icc: Option<Vec<u8>>, output_is_gray: bool) -> Option<Vec<u8>> {
    let icc = icc?;
    let space = icc.get(16..20)?;
    match (space, output_is_gray) {
        (b"RGB ", false) | (b"GRAY", true) => Some(icc),
        _ => None,
    }
}

/// Wrap a lossy WebP bitstream from libwebp in the extended (VP8X) container
/// so it can carry an ICC profile and EXIF. Unchanged if there is nothing to add.
pub fn assemble_webp(encoded: &[u8], width: u32, height: u32, icc: Option<&[u8]>, exif: Option<&[u8]>) -> Result<Vec<u8>> {
    let bad = || Error::CorruptImage("the WebP encoder produced unexpected output".into());
    let exif = exif.map(|e| e.strip_prefix(b"Exif\0\0").unwrap_or(e));
    if icc.is_none() && exif.is_none() {
        return Ok(encoded.to_vec());
    }
    if encoded.len() < 12 || &encoded[..4] != b"RIFF" || &encoded[8..12] != b"WEBP" {
        return Err(bad());
    }
    let mut chunks: Vec<([u8; 4], &[u8])> = Vec::new();
    let mut pos = 12;
    while pos + 8 <= encoded.len() {
        let id: [u8; 4] = encoded[pos..pos + 4].try_into().unwrap();
        let len = u32::from_le_bytes(encoded[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let payload = encoded.get(pos + 8..pos + 8 + len).ok_or_else(bad)?;
        chunks.push((id, payload));
        pos += 8 + len + (len & 1);
    }
    let (mut flags, mut dims) = (0u8, [0u8; 6]);
    let mut body: Vec<([u8; 4], &[u8])> = Vec::new();
    for (id, payload) in chunks {
        match &id {
            b"VP8X" if payload.len() >= 10 => {
                flags = payload[0];
                dims.copy_from_slice(&payload[4..10]);
            }
            b"ICCP" | b"EXIF" | b"XMP " => {} // none expected from libwebp; replaced below
            _ => body.push((id, payload)),
        }
    }
    if dims == [0; 6] {
        let (w, h) = (width.checked_sub(1).ok_or_else(bad)?, height.checked_sub(1).ok_or_else(bad)?);
        dims[..3].copy_from_slice(&w.to_le_bytes()[..3]);
        dims[3..].copy_from_slice(&h.to_le_bytes()[..3]);
    }
    if icc.is_some() {
        flags |= 0x20;
    }
    if exif.is_some() {
        flags |= 0x08;
    }
    let mut out = Vec::with_capacity(encoded.len() + icc.map_or(0, <[u8]>::len) + exif.map_or(0, <[u8]>::len) + 64);
    out.extend_from_slice(b"RIFF\0\0\0\0WEBP");
    let put = |out: &mut Vec<u8>, id: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(id);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        if data.len() & 1 == 1 {
            out.push(0);
        }
    };
    let mut vp8x = [0u8; 10];
    vp8x[0] = flags;
    vp8x[4..].copy_from_slice(&dims);
    put(&mut out, b"VP8X", &vp8x);
    if let Some(icc) = icc {
        put(&mut out, b"ICCP", icc);
    }
    for (id, payload) in body {
        put(&mut out, &id, payload);
    }
    if let Some(exif) = exif {
        put(&mut out, b"EXIF", exif);
    }
    let riff_size = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(out)
}

fn libwebp_version() -> String {
    // SAFETY: a pure function with no arguments that returns the library version.
    let v = unsafe { libwebp_sys::WebPGetEncoderVersion() };
    format!("{}.{}.{}", (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
}

// ------------------------------------------------------------------ integrity

/// Does this JPEG reach its end-of-image marker? The decoder is forgiving and
/// will happily turn a cut-off file into a half-grey picture, so check the
/// structure first: walk the segments, skip entropy-coded data, look for EOI.
pub fn jpeg_is_complete(path: &Path) -> std::io::Result<bool> {
    use std::io::Read;
    let mut r = BufReader::new(File::open(path)?);
    let mut b = [0u8; 1];
    let mut next = |r: &mut BufReader<File>| -> std::io::Result<Option<u8>> { Ok(if r.read(&mut b)? == 0 { None } else { Some(b[0]) }) };
    if next(&mut r)? != Some(0xFF) || next(&mut r)? != Some(0xD8) {
        return Ok(false);
    }
    loop {
        // find the next 0xFF; anything else is entropy-coded data or padding
        match next(&mut r)? {
            None => return Ok(false),
            Some(0xFF) => {}
            Some(_) => continue,
        }
        let marker = loop {
            match next(&mut r)? {
                None => return Ok(false),
                Some(0xFF) => continue, // fill bytes
                Some(m) => break m,
            }
        };
        match marker {
            0x00 | 0x01 | 0xD0..=0xD8 => {}
            0xD9 => return Ok(true),
            _ => {
                let mut len = [0u8; 2];
                if r.read_exact(&mut len).is_err() {
                    return Ok(false);
                }
                let payload = (u16::from_be_bytes(len) as u64).saturating_sub(2);
                if std::io::copy(&mut r.by_ref().take(payload), &mut std::io::sink())? < payload {
                    return Ok(false);
                }
            }
        }
    }
}

// ------------------------------------------------------------------ conversion

fn convert_one(input: &Path, output_dir: &Path, opts: &ImageOptions, policy: ConflictPolicy, ctx: &JobContext) -> Result<FileResult> {
    let display = input.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let protected = vec![input.canonicalize().at(input)?];

    let mut reader = ImageReader::new(BufReader::new(File::open(input).at(input)?)).with_guessed_format().at(input)?;
    let found = match reader.format() {
        Some(ImageFormat::Jpeg) => OutputFormat::Jpeg,
        Some(ImageFormat::Png) => OutputFormat::Png,
        Some(ImageFormat::WebP) => OutputFormat::Webp,
        _ => return Err(Error::Unsupported("only JPG, PNG and WebP images can be converted for now".into())),
    };
    let format = opts.format.resolve(found);
    let desired = output_path(input, output_dir, format);
    if fs_safe::resolve_destination(&desired, policy, &protected)? == Resolved::Skip {
        return Ok(FileResult::skipped(display, "A file with this name already exists, so it was skipped."));
    }
    if found == OutputFormat::Jpeg && !jpeg_is_complete(input).at(input)? {
        return Err(Error::CorruptImage("the JPEG file is cut off before its end".into()));
    }
    reader.limits(limits());
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let exif = if opts.keep_metadata { decoder.exif_metadata().ok().flatten() } else { None };
    let icc = decoder.icc_profile().ok().flatten();
    let mut img = DynamicImage::from_decoder(decoder)?;
    ctx.check_cancelled()?;
    img.apply_orientation(orientation);

    let mut notes = Vec::new();
    if let Some((w, h)) = resized_dimensions(img.width(), img.height(), opts) {
        notes.push(format!("Resized from {}×{} to {w}×{h} px.", img.width(), img.height()));
        img = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
        ctx.check_cancelled()?;
    }

    if format == OutputFormat::Webp && (img.width() > MAX_WEBP_DIMENSION || img.height() > MAX_WEBP_DIMENSION) {
        return Err(Error::Unsupported(format!(
            "WebP images can be at most {MAX_WEBP_DIMENSION} pixels wide or tall, and this one is {}×{}",
            img.width(),
            img.height()
        )));
    }

    let exif = exif.map(reset_exif_orientation);
    let lossy = format == OutputFormat::Jpeg || (format == OutputFormat::Webp && opts.webp_mode == WebpMode::Lossy);
    let bytes = match opts.target_bytes() {
        Some(target) if lossy => {
            let (bytes, quality, fits) = encode_to_fit(&img, format, opts, exif, icc, target, ctx)?;
            let kb = |n: u64| format!("{} KB", n.div_ceil(1000));
            notes.push(if fits {
                format!("Quality {quality} keeps it under {} ({}).", kb(target), kb(bytes.len() as u64))
            } else {
                format!("Couldn't get under {} even at the lowest quality ({}). Try making it smaller as well.", kb(target), kb(bytes.len() as u64))
            });
            bytes
        }
        _ => {
            let mut v = Vec::new();
            encode(&img, format, opts, exif, icc, &mut v)?;
            v
        }
    };

    let tmp = fs_safe::temp_in(output_dir)?;
    {
        let mut w = BufWriter::new(tmp.as_file());
        w.write_all(&bytes).at(output_dir)?;
        w.flush().at(output_dir)?;
    }
    ctx.check_cancelled()?;
    match fs_safe::commit(tmp, &desired, policy, &protected)? {
        Committed::Written(p) => {
            ctx.add_output(p.clone());
            Ok(FileResult::done(display, p, (!notes.is_empty()).then(|| notes.join(" "))))
        }
        Committed::Skipped => Ok(FileResult::skipped(display, "A file with this name already exists, so it was skipped.")),
    }
}

/// Lowest quality tried when aiming for a size.
const MIN_TARGET_QUALITY: u8 = 5;

/// The highest quality (up to the one chosen) whose file fits in `target` bytes. Returns the bytes, the quality, and whether it fits.
fn encode_to_fit(img: &DynamicImage, format: OutputFormat, opts: &ImageOptions, exif: Option<Vec<u8>>, icc: Option<Vec<u8>>, target: u64, ctx: &JobContext) -> Result<(Vec<u8>, u8, bool)> {
    let at = |q: u8| -> Result<Vec<u8>> {
        ctx.check_cancelled()?;
        let mut v = Vec::new();
        let o = ImageOptions { quality: q, ..opts.clone() };
        encode(img, format, &o, exif.clone(), icc.clone(), &mut v)?;
        Ok(v)
    };
    let top = opts.quality.clamp(MIN_TARGET_QUALITY, 100);
    let first = at(top)?;
    if first.len() as u64 <= target {
        return Ok((first, top, true));
    }
    let (mut lo, mut hi) = (MIN_TARGET_QUALITY, top - 1);
    let mut best: Option<(Vec<u8>, u8)> = None;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        let v = at(mid)?;
        if v.len() as u64 <= target {
            best = Some((v, mid));
            lo = mid + 1;
        } else {
            if mid == MIN_TARGET_QUALITY {
                break;
            }
            hi = mid - 1;
        }
    }
    match best {
        Some((v, q)) => Ok((v, q, true)),
        None => Ok((at(MIN_TARGET_QUALITY)?, MIN_TARGET_QUALITY, false)),
    }
}

pub(crate) fn encode(img: &DynamicImage, format: OutputFormat, opts: &ImageOptions, exif: Option<Vec<u8>>, icc: Option<Vec<u8>>, w: &mut impl Write) -> Result<()> {
    fn go<E: ImageEncoder>(mut enc: E, exif: Option<Vec<u8>>, icc: Option<Vec<u8>>, img: &DynamicImage, color: ExtendedColorType) -> Result<()> {
        // A codec that cannot carry these simply skips them.
        if let Some(i) = icc {
            let _ = enc.set_icc_profile(i);
        }
        if let Some(e) = exif {
            let _ = enc.set_exif_metadata(e);
        }
        enc.write_image(img.as_bytes(), img.width(), img.height(), color)?;
        Ok(())
    }
    match format {
        OutputFormat::Jpeg => {
            let bg = parse_hex_colour(&opts.background).unwrap_or([255, 255, 255]);
            let flat = if img.color().has_alpha() { composite_on(img, bg) } else { img.clone() };
            let gray = !flat.color().has_color();
            let flat = if gray { DynamicImage::ImageLuma8(flat.to_luma8()) } else { DynamicImage::ImageRgb8(flat.to_rgb8()) };
            let color = flat.color().into();
            go(JpegEncoder::new_with_quality(w, opts.quality.clamp(1, 100)), exif, usable_icc(icc, gray), &flat, color)
        }
        OutputFormat::Png => {
            use image::ColorType::*;
            // Keep 8/16-bit gray/RGB(A) as-is; normalise anything exotic.
            let img = match img.color() {
                L8 | La8 | Rgb8 | Rgba8 | L16 | La16 | Rgb16 | Rgba16 => img.clone(),
                c if c.has_alpha() => DynamicImage::ImageRgba8(img.to_rgba8()),
                _ => DynamicImage::ImageRgb8(img.to_rgb8()),
            };
            let gray = !img.color().has_color();
            let color = img.color().into();
            go(PngEncoder::new_with_quality(w, CompressionType::Default, FilterType::Adaptive), exif, usable_icc(icc, gray), &img, color)
        }
        OutputFormat::Webp => {
            let alpha = img.color().has_alpha();
            let icc = usable_icc(icc, false);
            match opts.webp_mode {
                WebpMode::Lossless => {
                    let img = if alpha { DynamicImage::ImageRgba8(img.to_rgba8()) } else { DynamicImage::ImageRgb8(img.to_rgb8()) };
                    let color = img.color().into();
                    go(WebPEncoder::new_lossless(w), exif, icc, &img, color)
                }
                WebpMode::Lossy => {
                    let (width, height) = (img.width(), img.height());
                    let quality = opts.quality.clamp(1, 100) as f32;
                    let encoded = if alpha {
                        let rgba = img.to_rgba8();
                        webp::Encoder::from_rgba(&rgba, width, height).encode_simple(false, quality).map(|m| m.to_vec())
                    } else {
                        let rgb = img.to_rgb8();
                        webp::Encoder::from_rgb(&rgb, width, height).encode_simple(false, quality).map(|m| m.to_vec())
                    }
                    .map_err(|e| Error::CorruptImage(format!("WebP encoding failed ({e:?})")))?;
                    let out = assemble_webp(&encoded, width, height, icc.as_deref(), exif.as_deref())?;
                    w.write_all(&out)?;
                    Ok(())
                }
            }
        }
    }
}

/// Convert a batch. One bad image never stops the others.
pub fn convert_all(inputs: &[PathBuf], output_dir: &Path, opts: &ImageOptions, policy: ConflictPolicy, ctx: &JobContext) -> Result<()> {
    let total_bytes = inputs.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
    ctx.set_totals(inputs.len() as u64, Some(total_bytes));
    for input in inputs {
        ctx.check_cancelled()?;
        let display = input.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        ctx.begin_file(&display);
        let size = fs::metadata(input).map(|m| m.len()).unwrap_or(0);
        match convert_one(input, output_dir, opts, policy, ctx) {
            Ok(r) => ctx.add_result(r),
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(e) => ctx.add_result(FileResult::failed(display, &e)),
        }
        ctx.add_bytes(size);
        ctx.file_processed();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Big-endian TIFF with one IFD0 entry: Orientation = `o`.
    fn exif_with_orientation(o: u16, le: bool) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(if le { b"II" } else { b"MM" });
        let w16 = |n: u16| if le { n.to_le_bytes() } else { n.to_be_bytes() };
        let w32 = |n: u32| if le { n.to_le_bytes() } else { n.to_be_bytes() };
        v.extend_from_slice(&w16(42));
        v.extend_from_slice(&w32(8));
        v.extend_from_slice(&w16(1));
        v.extend_from_slice(&w16(0x0112));
        v.extend_from_slice(&w16(3));
        v.extend_from_slice(&w32(1));
        v.extend_from_slice(&w16(o));
        v.extend_from_slice(&[0, 0]);
        v.extend_from_slice(&w32(0));
        v
    }

    fn orientation_of(exif: &[u8], le: bool) -> u16 {
        let b: [u8; 2] = exif[8 + 2 + 8..8 + 2 + 10].try_into().unwrap();
        if le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) }
    }

    #[test]
    fn orientation_tag_is_reset_in_both_byte_orders() {
        for le in [true, false] {
            let out = reset_exif_orientation(exif_with_orientation(6, le));
            assert_eq!(orientation_of(&out, le), 1, "le={le}");
        }
        // with the "Exif\0\0" prefix
        let mut p = b"Exif\0\0".to_vec();
        p.extend(exif_with_orientation(8, false));
        let out = reset_exif_orientation(p);
        assert_eq!(&out[..6], b"Exif\0\0");
        assert_eq!(orientation_of(&out[6..], false), 1);
    }

    #[test]
    fn malformed_exif_is_left_alone() {
        for bad in [vec![], b"junk".to_vec(), b"II*\0\xff\xff\xff\xff".to_vec(), exif_with_orientation(6, true)[..12].to_vec()] {
            assert_eq!(reset_exif_orientation(bad.clone()), bad);
        }
    }

    #[test]
    fn jpeg_completeness_check_finds_cut_off_files() {
        use image::ImageEncoder;
        let img = image::RgbImage::from_fn(64, 64, |x, y| image::Rgb([(x * 4) as u8, (y * 4) as u8, 90]));
        let mut ok = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut ok, 90).write_image(img.as_raw(), 64, 64, ExtendedColorType::Rgb8).unwrap();
        let d = tempfile::tempdir().unwrap();
        let check = |bytes: &[u8]| {
            let p = d.path().join("t.jpg");
            fs::write(&p, bytes).unwrap();
            jpeg_is_complete(&p).unwrap()
        };
        assert!(check(&ok));
        let mut with_trailer = ok.clone();
        with_trailer.extend_from_slice(b"trailing vendor data");
        assert!(check(&with_trailer), "data after the end marker is fine");
        for cut in [2, 10, ok.len() / 2, ok.len() - 3] {
            assert!(!check(&ok[..cut]), "cut at {cut}");
        }
        assert!(!check(b""));
        assert!(!check(b"not a jpeg"));
    }

    #[test]
    fn hex_colours_parse_strictly() {
        assert_eq!(parse_hex_colour("#FFFFFF"), Some([255, 255, 255]));
        assert_eq!(parse_hex_colour("#1a2B3c"), Some([0x1a, 0x2b, 0x3c]));
        for bad in ["FFFFFF", "#FFF", "#GGGGGG", "#12345678", "", "#é1234"] {
            assert_eq!(parse_hex_colour(bad), None, "{bad}");
        }
    }

    #[test]
    fn icc_profile_must_match_the_pixels() {
        let mut rgb = vec![0u8; 128];
        rgb[16..20].copy_from_slice(b"RGB ");
        let mut gray = vec![0u8; 128];
        gray[16..20].copy_from_slice(b"GRAY");
        let mut cmyk = vec![0u8; 128];
        cmyk[16..20].copy_from_slice(b"CMYK");
        assert!(usable_icc(Some(rgb.clone()), false).is_some());
        assert!(usable_icc(Some(rgb), true).is_none());
        assert!(usable_icc(Some(gray.clone()), true).is_some());
        assert!(usable_icc(Some(gray), false).is_none());
        assert!(usable_icc(Some(cmyk), false).is_none());
        assert!(usable_icc(Some(vec![1, 2, 3]), false).is_none());
        assert!(usable_icc(None, false).is_none());
    }

    #[test]
    fn webp_container_gets_icc_and_exif_with_correct_sizes() {
        // a minimal simple-format file: RIFF + "VP8 " chunk with an odd-length payload
        let payload = [1u8, 2, 3, 4, 5];
        let mut simple = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        simple.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        simple.extend_from_slice(&payload);
        simple.push(0);
        let total = (simple.len() - 8) as u32;
        simple[4..8].copy_from_slice(&total.to_le_bytes());

        let icc = vec![7u8; 33];
        let exif = exif_with_orientation(1, true);
        let out = assemble_webp(&simple, 100, 50, Some(&icc), Some(&exif)).unwrap();
        assert_eq!(&out[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()) as usize, out.len() - 8, "RIFF size");
        assert_eq!(&out[12..16], b"VP8X");
        assert_eq!(out[20] & 0x28, 0x28, "ICC + EXIF flags");
        assert_eq!(u32::from_le_bytes([out[24], out[25], out[26], 0]), 99, "canvas width - 1");
        assert_eq!(u32::from_le_bytes([out[27], out[28], out[29], 0]), 49, "canvas height - 1");
        let iccp = out.windows(4).position(|w| w == b"ICCP").unwrap();
        let vp8 = out.windows(4).position(|w| w == b"VP8 ").unwrap();
        let exif_pos = out.windows(4).position(|w| w == b"EXIF").unwrap();
        assert!(iccp < vp8 && vp8 < exif_pos, "chunk order: VP8X, ICCP, image, EXIF");
        assert_eq!(out.len() % 2, 0, "chunks are padded to even sizes");
        // nothing to add -> untouched
        assert_eq!(assemble_webp(&simple, 100, 50, None, None).unwrap(), simple);
        assert!(assemble_webp(b"not riff data at all", 1, 1, Some(&icc), None).is_err());
    }
}

// ------------------------------------------------------------------ engine adapter

use crate::engine::{AppliesTo, Availability, ConversionPair, Engine, EngineInfo, OperationSpec, OptionCondition, OptionKind, OptionSpec};
use crate::request::{JobRequest, Operation, Review, MAX_CONFLICTS};

pub struct ImageEngine;

fn keep_metadata_option() -> OptionSpec {
    OptionSpec {
        id: "keep_metadata".into(),
        label: "Keep photo information".into(),
        help: Some("Camera details and location (EXIF). Off by default for privacy. The colour profile is always kept.".into()),
        kind: OptionKind::Bool { default: false },
        applies_to: vec![],
    }
}

fn pair_notes(from: &str, to: &str) -> Vec<String> {
    let mut n = Vec::new();
    match to {
        formats::JPEG => {
            n.push("JPG is lossy: each save reduces quality slightly.".into());
            if from != formats::JPEG {
                n.push("Transparent areas are filled with a solid background colour (white by default).".into());
            }
        }
        formats::WEBP => n.push("WebP can be lossy (smaller files) or lossless (exact pixels). Transparency is kept.".into()),
        formats::PNG if from != formats::PNG => n.push("PNG is lossless, so the file is usually larger and lost quality does not come back.".into()),
        _ => {}
    }
    if from == to {
        n.push("Same format: the image is re-encoded (useful to remove metadata or change quality).".into());
    }
    n
}

impl Engine for ImageEngine {
    fn info(&self) -> EngineInfo {
        EngineInfo {
            id: "image".into(),
            name: "Images (JPG, PNG, WEBP)".into(),
            version: format!("image crate {} + libwebp {}", env!("FC_VER_IMAGE"), libwebp_version()),
            availability: Availability::Bundled,
            license: "MIT OR Apache-2.0 (image crate); BSD-3-Clause (libwebp)".into(),
        }
    }

    fn formats(&self) -> Vec<FormatInfo> {
        formats::bundled_formats().into_iter().filter(|f| f.kind == formats::FormatKind::Image).collect()
    }

    fn operations(&self) -> Vec<OperationSpec> {
        let ids = [formats::JPEG, formats::PNG, formats::WEBP];
        let pairs = ids.iter().flat_map(|f| ids.iter().map(move |t| ConversionPair { from: (*f).into(), to: (*t).into(), notes: pair_notes(f, t) })).collect();
        let lossy = OptionCondition { option: "webp_mode".into(), equals: "lossy".into() };
        let convert = OperationSpec {
            interactive: false,
            id: "convert_image".into(),
            label: "Convert images".into(),
            description: "Convert between JPG, PNG and WEBP. Originals are never changed.".into(),
            inputs: ids.iter().map(|s| s.to_string()).collect(),
            outputs: ids.iter().map(|s| s.to_string()).collect(),
            pairs,
            options: vec![
                OptionSpec {
                    id: "webp_mode".into(),
                    label: "WebP mode".into(),
                    help: Some("Lossy makes smaller files. Lossless keeps every pixel exactly.".into()),
                    kind: OptionKind::Choice {
                        choices: vec![
                            crate::engine::Choice { value: "lossy".into(), label: "Lossy (smaller)".into() },
                            crate::engine::Choice { value: "lossless".into(), label: "Lossless (exact)".into() },
                        ],
                        default: "lossy".into(),
                    },
                    applies_to: vec![AppliesTo { format: formats::WEBP.into(), when: None }],
                },
                OptionSpec {
                    id: "quality".into(),
                    label: "Quality".into(),
                    help: Some("Higher looks better but makes bigger files.".into()),
                    kind: OptionKind::Int { min: 1, max: 100, default: 85 },
                    applies_to: vec![
                        AppliesTo { format: formats::JPEG.into(), when: None },
                        AppliesTo { format: formats::WEBP.into(), when: Some(lossy) },
                    ],
                },
                OptionSpec {
                    id: "background".into(),
                    label: "Background for transparent areas".into(),
                    help: Some("JPG can't store transparency, so transparent areas are filled with this colour.".into()),
                    kind: OptionKind::Color { default: "#FFFFFF".into() },
                    applies_to: vec![AppliesTo { format: formats::JPEG.into(), when: None }],
                },
                keep_metadata_option(),
            ],
        };
        let resize = OperationSpec {
            interactive: false,
            id: "resize_image".into(),
            label: "Resize and compress images".into(),
            description: "Make pictures smaller: change their size, aim for a file size, and keep or change the format.".into(),
            inputs: ids.iter().map(|s| s.to_string()).collect(),
            outputs: ids.iter().map(|s| s.to_string()).collect(),
            pairs: convert.pairs.clone(),
            options: vec![
                OptionSpec {
                    id: "resize_mode".into(),
                    label: "Size".into(),
                    help: None,
                    kind: OptionKind::Choice {
                        choices: vec![
                            crate::engine::Choice { value: "none".into(), label: "Keep the size".into() },
                            crate::engine::Choice { value: "percent".into(), label: "By percentage".into() },
                            crate::engine::Choice { value: "fit".into(), label: "Fit within".into() },
                        ],
                        default: "percent".into(),
                    },
                    applies_to: vec![],
                },
                OptionSpec {
                    id: "resize_percent".into(),
                    label: "Percentage of the original size".into(),
                    help: None,
                    kind: OptionKind::Int { min: 1, max: 100, default: 50 },
                    applies_to: vec![],
                },
                OptionSpec {
                    id: "max_width".into(),
                    label: "Maximum width (px)".into(),
                    help: Some("Proportions are kept, and pictures are never enlarged.".into()),
                    kind: OptionKind::Int { min: 1, max: MAX_DIMENSION as i64, default: 1920 },
                    applies_to: vec![],
                },
                OptionSpec {
                    id: "max_height".into(),
                    label: "Maximum height (px)".into(),
                    help: None,
                    kind: OptionKind::Int { min: 1, max: MAX_DIMENSION as i64, default: 1920 },
                    applies_to: vec![],
                },
                OptionSpec {
                    id: "target_kb".into(),
                    label: "Target file size (KB)".into(),
                    help: Some("JPG and WebP only: the highest quality that fits under this size is used.".into()),
                    kind: OptionKind::Int { min: 1, max: MAX_TARGET_KB as i64, default: 500 },
                    applies_to: vec![
                        AppliesTo { format: formats::JPEG.into(), when: None },
                        AppliesTo { format: formats::WEBP.into(), when: None },
                    ],
                },
                OptionSpec {
                    id: "quality".into(),
                    label: "Quality".into(),
                    help: Some("Higher looks better but makes bigger files. With a target size, this is the most it will use.".into()),
                    kind: OptionKind::Int { min: 1, max: 100, default: 80 },
                    applies_to: vec![AppliesTo { format: formats::JPEG.into(), when: None }, AppliesTo { format: formats::WEBP.into(), when: None }],
                },
                keep_metadata_option(),
            ],
        };
        vec![convert, resize]
    }

    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()> {
        let (Operation::ConvertImage(o) | Operation::ResizeImage(o)) = op else {
            return Err(Error::Unsupported("the image engine does not handle this operation".into()));
        };
        let spec = self.operations().remove(0);
        for f in files {
            match f.format.as_deref() {
                Some(from) if spec.inputs.iter().any(|i| i == from) => {
                    let to = o.format.fixed().map(OutputFormat::id).unwrap_or(from);
                    if !spec.pairs.iter().any(|p| p.from == from && p.to == to) {
                        return Err(Error::UnsupportedConversion { from: from.into(), to: to.into() });
                    }
                }
                _ if strict => return Err(Error::UnsupportedFormat(f.name.clone())),
                _ => {}
            }
        }
        // Options last, so a bad option does not hide which files are the problem.
        if !(1..=100).contains(&o.quality) {
            return Err(Error::InvalidRequest("Quality must be between 1 and 100.".into()));
        }
        if parse_hex_colour(&o.background).is_none() {
            return Err(Error::InvalidRequest("The background colour must look like #RRGGBB.".into()));
        }
        match o.resize_mode {
            ResizeMode::None => {}
            ResizeMode::Percent if !(1..=100).contains(&o.resize_percent) => {
                return Err(Error::InvalidRequest("The percentage must be between 1 and 100.".into()));
            }
            ResizeMode::Percent => {}
            ResizeMode::Fit => {
                let side = |v: Option<u32>| v.filter(|&x| x > 0);
                if side(o.max_width).is_none() && side(o.max_height).is_none() {
                    return Err(Error::InvalidRequest("Give a maximum width, a maximum height, or both.".into()));
                }
                if [o.max_width, o.max_height].into_iter().flatten().any(|v| v > MAX_DIMENSION) {
                    return Err(Error::InvalidRequest(format!("Sizes can be at most {MAX_DIMENSION} pixels.")));
                }
            }
        }
        if o.target_kb.is_some_and(|k| k > MAX_TARGET_KB) {
            return Err(Error::InvalidRequest(format!("The target size can be at most {MAX_TARGET_KB} KB.")));
        }
        Ok(())
    }

    fn review(&self, req: &JobRequest) -> Result<Review> {
        let (Operation::ConvertImage(o) | Operation::ResizeImage(o)) = &req.operation else {
            return Err(Error::Unsupported("the image engine does not handle this operation".into()));
        };
        let mut r = Review::default();
        for p in &req.inputs {
            let Some(format) = o.format.fixed().or_else(|| formats::detect_file(p).and_then(OutputFormat::from_id)) else { continue };
            let out = output_path(p, &req.output_dir, format);
            if fs::symlink_metadata(&out).is_ok() && r.conflicts.len() < MAX_CONFLICTS {
                r.conflicts.push(out);
            }
            r.total_bytes += fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        }
        r.warnings = warnings_for(&req.inputs, o);
        Ok(r)
    }

    fn run(&self, req: &JobRequest, ctx: &JobContext) -> Result<()> {
        match &req.operation {
            Operation::ConvertImage(o) | Operation::ResizeImage(o) => convert_all(&req.inputs, &req.output_dir, o, req.conflict, ctx),
            _ => Err(Error::Unsupported("the image engine does not handle this operation".into())),
        }
    }
}
