#![allow(dead_code)]
use file_core::{CancelToken, JobContext, JobRequest, JobStatus};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub fn write(path: &Path, bytes: &[u8]) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
    path.to_path_buf()
}

/// Deterministic incompressible-ish data.
pub fn noise(len: usize) -> Vec<u8> {
    let mut x: u64 = 0x9E3779B97F4A7C15;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

pub fn run(req: &JobRequest) -> JobStatus {
    let ctx = JobContext::silent();
    file_core::request::validate(req).unwrap();
    let r = file_core::request::run(req, &ctx);
    let _ = r.as_ref().map_err(|e| eprintln!("job error: {e}"));
    let mut s = ctx.snapshot();
    s.error_code = r.err().map(|e| e.code().to_string());
    s
}

pub fn run_with_cancel_after_first_progress(req: &JobRequest) -> (JobStatus, Option<String>) {
    let token = CancelToken::default();
    let t2 = token.clone();
    let seen = Arc::new(Mutex::new(false));
    let ctx = JobContext::new("t", "t", token, move |s| {
        if s.bytes_processed > 0 {
            *seen.lock().unwrap() = true;
            t2.cancel();
        }
    });
    let r = file_core::request::run(req, &ctx);
    (ctx.snapshot(), r.err().map(|e| e.code().to_string()))
}

pub fn req(json: serde_json::Value) -> JobRequest {
    serde_json::from_value(json).unwrap()
}

pub fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

/// Build a zip with arbitrary (possibly hostile) entry names.
pub fn raw_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let f = fs::File::create(path).unwrap();
    let mut z = zip::ZipWriter::new(f);
    for (n, data) in entries {
        z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(data).unwrap();
    }
    z.finish().unwrap();
}

pub fn png(path: &Path, w: u32, h: u32, alpha: bool) -> PathBuf {
    let mut img = image::RgbaImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        *p = image::Rgba([(x * 255 / w) as u8, (y * 255 / h) as u8, 128, if alpha && x < w / 2 { 0 } else { 255 }]);
    }
    img.save(path).unwrap();
    path.to_path_buf()
}

/// A synthetic photo-like image: smooth gradient plus mild texture (compresses like a real photo).
pub fn photo(w: u32, h: u32) -> image::RgbImage {
    image::RgbImage::from_fn(w, h, |x, y| {
        let t = ((x * 7 + y * 13) % 17) as u8;
        image::Rgb([(x * 255 / w) as u8 / 2 + t, (y * 255 / h) as u8 / 2 + t, ((x + y) * 255 / (w + h)) as u8])
    })
}

/// Big-endian EXIF with only Orientation = `o`.
pub fn exif_orientation(o: u16) -> Vec<u8> {
    let mut v = vec![b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1];
    v.extend_from_slice(&o.to_be_bytes());
    v.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    v
}

/// A 128-byte stand-in ICC profile whose header names the given colour space.
pub fn fake_icc(space: &[u8; 4]) -> Vec<u8> {
    let mut p = vec![0u8; 128];
    p[..4].copy_from_slice(&128u32.to_be_bytes());
    p[16..20].copy_from_slice(space);
    p[36..40].copy_from_slice(b"acsp");
    p
}

/// Write a JPEG carrying optional EXIF and ICC.
pub fn jpeg_with(path: &Path, img: &image::RgbImage, exif: Option<Vec<u8>>, icc: Option<Vec<u8>>) -> PathBuf {
    use image::ImageEncoder;
    let mut bytes = Vec::new();
    {
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 95);
        if let Some(e) = exif { enc.set_exif_metadata(e).unwrap(); }
        if let Some(i) = icc { enc.set_icc_profile(i).unwrap(); }
        enc.write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
    }
    write(path, &bytes)
}

/// Write a PNG carrying optional EXIF and ICC.
pub fn png_with(path: &Path, img: &image::RgbaImage, exif: Option<Vec<u8>>, icc: Option<Vec<u8>>) -> PathBuf {
    use image::ImageEncoder;
    let mut bytes = Vec::new();
    {
        let mut enc = image::codecs::png::PngEncoder::new(&mut bytes);
        if let Some(e) = exif { enc.set_exif_metadata(e).unwrap(); }
        if let Some(i) = icc { enc.set_icc_profile(i).unwrap(); }
        enc.write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8).unwrap();
    }
    write(path, &bytes)
}
