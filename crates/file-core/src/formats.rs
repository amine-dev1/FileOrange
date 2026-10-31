//! The catalog of file formats the app knows about, and content-based detection.
//!
//! Detection reads the file's leading bytes, never its extension: a PNG renamed
//! to `.jpg` is still a PNG, and a text file renamed to `.png` is not an image.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::Path;

pub const JPEG: &str = "jpeg";
pub const PNG: &str = "png";
pub const WEBP: &str = "webp";
pub const ZIP: &str = "zip";
pub const PDF: &str = "pdf";
/// Legacy Office containers (.doc, .xls, .ppt) share this signature; which is which needs a look inside.
pub const OLE2: &str = "ole2";
pub const RTF: &str = "rtf";
pub const DOCX: &str = "docx";
pub const XLSX: &str = "xlsx";
pub const PPTX: &str = "pptx";
pub const ODT: &str = "odt";
pub const ODS: &str = "ods";
pub const ODP: &str = "odp";
pub const DOC: &str = "doc";
pub const XLS: &str = "xls";
pub const PPT: &str = "ppt";

/// Enough bytes to recognise every format above.
pub const HEAD_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormatKind {
    Image,
    Archive,
    Pdf,
    Document,
    Audio,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormatInfo {
    /// Stable id used on the wire, e.g. "jpeg".
    pub id: String,
    /// What users see, e.g. "JPG".
    pub label: String,
    pub extensions: Vec<String>,
    pub mime: String,
    pub kind: FormatKind,
}

impl FormatInfo {
    pub fn new(id: &str, label: &str, extensions: &[&str], mime: &str, kind: FormatKind) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            extensions: extensions.iter().map(|e| e.to_string()).collect(),
            mime: mime.into(),
            kind,
        }
    }
}

/// Formats the bundled engines handle today.
pub fn bundled_formats() -> Vec<FormatInfo> {
    vec![
        FormatInfo::new(JPEG, "JPG", &["jpg", "jpeg"], "image/jpeg", FormatKind::Image),
        FormatInfo::new(PNG, "PNG", &["png"], "image/png", FormatKind::Image),
        FormatInfo::new(WEBP, "WEBP", &["webp"], "image/webp", FormatKind::Image),
        FormatInfo::new(ZIP, "ZIP", &["zip"], "application/zip", FormatKind::Archive),
        FormatInfo::new(PDF, "PDF", &["pdf"], "application/pdf", FormatKind::Pdf),
    ]
}

/// Office documents, catalogued by the Office engine.
pub fn office_formats() -> Vec<FormatInfo> {
    use FormatKind::Document as D;
    vec![
        FormatInfo::new(DOCX, "Word (DOCX)", &["docx"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document", D),
        FormatInfo::new(DOC, "Word 97-2003 (DOC)", &["doc"], "application/msword", D),
        FormatInfo::new(ODT, "OpenDocument Text (ODT)", &["odt"], "application/vnd.oasis.opendocument.text", D),
        FormatInfo::new(RTF, "Rich Text (RTF)", &["rtf"], "application/rtf", D),
        FormatInfo::new(XLSX, "Excel (XLSX)", &["xlsx"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", D),
        FormatInfo::new(XLS, "Excel 97-2003 (XLS)", &["xls"], "application/vnd.ms-excel", D),
        FormatInfo::new(ODS, "OpenDocument Spreadsheet (ODS)", &["ods"], "application/vnd.oasis.opendocument.spreadsheet", D),
        FormatInfo::new(PPTX, "PowerPoint (PPTX)", &["pptx"], "application/vnd.openxmlformats-officedocument.presentationml.presentation", D),
        FormatInfo::new(PPT, "PowerPoint 97-2003 (PPT)", &["ppt"], "application/vnd.ms-powerpoint", D),
        FormatInfo::new(ODP, "OpenDocument Presentation (ODP)", &["odp"], "application/vnd.oasis.opendocument.presentation", D),
    ]
}

/// Identify a format from the first bytes of a file. `None` = not recognised.
pub fn detect(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(JPEG)
    } else if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(PNG)
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some(WEBP)
    } else if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") || head.starts_with(b"PK\x07\x08") {
        Some(ZIP)
    } else if head.starts_with(b"%PDF-") {
        Some(PDF)
    } else if head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        Some(OLE2)
    } else if head.starts_with(b"{\\rtf") {
        Some(RTF)
    } else {
        None
    }
}

/// Which Office document a file really is, from its content: ZIP-based formats by the parts inside, legacy
/// binary formats by the streams named in their directory, RTF by its signature. `None` = not one we convert.
pub fn detect_office_file(path: &Path) -> Option<&'static str> {
    let head = read_head(path).ok()?;
    match detect(&head)? {
        RTF => Some(RTF),
        ZIP => sniff_zip_office(path),
        OLE2 => sniff_ole2(path),
        _ => None,
    }
}

fn sniff_zip_office(path: &Path) -> Option<&'static str> {
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(File::open(path).ok()?)).ok()?;
    if zip.len() > 100_000 {
        return None;
    }
    // OpenDocument: a `mimetype` entry says exactly what it is.
    if let Ok(mut m) = zip.by_name("mimetype") {
        let mut s = String::new();
        let _ = (&mut m).take(200).read_to_string(&mut s);
        return match s.trim() {
            "application/vnd.oasis.opendocument.text" => Some(ODT),
            "application/vnd.oasis.opendocument.spreadsheet" => Some(ODS),
            "application/vnd.oasis.opendocument.presentation" => Some(ODP),
            _ => None,
        };
    }
    let mut has = |n: &str| zip.by_name(n).is_ok();
    if has("word/document.xml") {
        Some(DOCX)
    } else if has("xl/workbook.xml") {
        Some(XLSX)
    } else if has("ppt/presentation.xml") {
        Some(PPTX)
    } else {
        None
    }
}

/// Legacy Office files are compound files whose directory names a stream per application, in UTF-16.
fn sniff_ole2(path: &Path) -> Option<&'static str> {
    const SCAN_LIMIT: u64 = 64 * 1024 * 1024;
    let wide = |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(u16::to_le_bytes).collect() };
    let (word, book, book2, ppt) = (wide("WordDocument"), wide("Workbook"), wide("Book"), wide("PowerPoint Document"));
    let mut data = Vec::new();
    File::open(path).ok()?.take(SCAN_LIMIT).read_to_end(&mut data).ok()?;
    let has = |needle: &[u8]| data.windows(needle.len()).any(|w| w == needle);
    if has(&word) {
        Some(DOC)
    } else if has(&ppt) {
        Some(PPT)
    } else if has(&book) || has(&book2) {
        Some(XLS)
    } else {
        None
    }
}

/// Read a file's head (up to [`HEAD_LEN`] bytes).
pub fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(HEAD_LEN);
    File::open(path)?.take(HEAD_LEN as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn detect_file(path: &Path) -> Option<&'static str> {
    read_head(path).ok().and_then(|h| detect(&h))
}

/// What the caller knows about one input before any work starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDescriptor {
    pub name: String,
    pub size: u64,
    /// Detected format id, `None` if the content was not recognised.
    pub format: Option<String>,
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || s.len() > HEAD_LEN * 4 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_by_content() {
        assert_eq!(detect(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(JPEG));
        assert_eq!(detect(b"\x89PNG\r\n\x1a\n\0\0"), Some(PNG));
        assert_eq!(detect(b"RIFF\x10\0\0\0WEBPVP8 "), Some(WEBP));
        assert_eq!(detect(b"PK\x03\x04rest"), Some(ZIP));
        assert_eq!(detect(b"%PDF-1.7\n%\xe2\xe3"), Some(PDF));
        assert_eq!(detect(b"%PDF"), None, "the header needs its dash");
        assert_eq!(detect(b"GIF89a"), None);
        assert_eq!(detect(b"RIFF\x10\0\0\0WAVEfmt "), None, "other RIFF files are not WebP");
        assert_eq!(detect(b"just text"), None);
        assert_eq!(detect(b""), None);
    }

    #[test]
    fn hex_roundtrip_and_limits() {
        assert_eq!(hex_decode(&hex_encode(b"\xff\xd8\xff")), Some(vec![0xff, 0xd8, 0xff]));
        assert_eq!(hex_decode("zz"), None);
        assert_eq!(hex_decode("abc"), None);
        assert_eq!(hex_decode(&"00".repeat(HEAD_LEN * 2 + 1)), None);
    }
}
