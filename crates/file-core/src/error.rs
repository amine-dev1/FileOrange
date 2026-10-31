use std::io;
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("i/o error{}: {source}", path_suffix(.path))]
    Io {
        path: Option<PathBuf>,
        #[source]
        source: io::Error,
    },
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("cancelled")]
    Cancelled,
    #[error("archive needs a password")]
    PasswordRequired,
    #[error("wrong password")]
    WrongPassword,
    #[error("damaged archive: {0}")]
    CorruptArchive(String),
    #[error("damaged or unreadable image: {0}")]
    CorruptImage(String),
    #[error("damaged or unreadable PDF: {0}")]
    CorruptPdf(String),
    #[error("PDF has no page {page}")]
    PageOutOfRange { page: u32 },
    /// The PDF worker process crashed, timed out or answered nonsense.
    #[error("PDF worker failed: {0}")]
    PdfWorker(String),
    /// LibreOffice couldn't be started, took too long or produced nothing.
    #[error("Office conversion failed: {0}")]
    OfficeConversion(String),
    /// qpdf or the PDF rewriter couldn't process a file.
    #[error("PDF tool failed: {0}")]
    PdfTool(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("unsupported file type: {0}")]
    UnsupportedFormat(String),
    #[error("no conversion from {from} to {to}")]
    UnsupportedConversion { from: String, to: String },
    #[error("engine unavailable: {engine} ({reason})")]
    EngineUnavailable { engine: String, reason: String },
    #[error("unsafe archive entry: {0}")]
    UnsafeEntry(String),
    #[error("archive would expand beyond the {limit} byte limit")]
    ExpansionLimit { limit: u64 },
    #[error("would overwrite a source file: {0}")]
    WouldOverwriteSource(PathBuf),
    #[error("destination exists and is not a file: {0}")]
    DestinationNotFile(PathBuf),
}

fn path_suffix(path: &Option<PathBuf>) -> String {
    path.as_ref()
        .map(|p| format!(" at {}", p.display()))
        .unwrap_or_default()
}

impl From<io::Error> for Error {
    fn from(source: io::Error) -> Self {
        Error::Io { path: None, source }
    }
}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        use zip::result::ZipError as Z;
        match e {
            Z::Io(e) => e.into(),
            Z::InvalidPassword => Error::WrongPassword,
            Z::UnsupportedArchive(msg) if msg.to_lowercase().contains("password") => {
                Error::PasswordRequired
            }
            Z::UnsupportedArchive(msg) => Error::Unsupported(msg.to_string()),
            other => Error::CorruptArchive(other.to_string()),
        }
    }
}

impl From<image::ImageError> for Error {
    fn from(e: image::ImageError) -> Self {
        use image::ImageError as I;
        match e {
            // A decoder hitting end-of-file means the image is cut off, not that the disk failed.
            I::IoError(e) if e.kind() == io::ErrorKind::UnexpectedEof => Error::CorruptImage(e.to_string()),
            I::IoError(e) => e.into(),
            I::Unsupported(e) => Error::Unsupported(e.to_string()),
            I::Limits(e) => Error::Unsupported(format!("image is too large to process ({e})")),
            other => Error::CorruptImage(other.to_string()),
        }
    }
}

impl Error {
    /// Attach the path an I/O error happened on; other variants pass through.
    pub fn at(self, path: &Path) -> Self {
        match self {
            Error::Io { path: None, source } => Error::Io {
                path: Some(path.to_path_buf()),
                source,
            },
            other => other,
        }
    }

    /// Stable machine-readable code for the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Io { source, .. } => match source.kind() {
                io::ErrorKind::PermissionDenied => "permission_denied",
                io::ErrorKind::NotFound => "not_found",
                io::ErrorKind::StorageFull => "disk_full",
                io::ErrorKind::ReadOnlyFilesystem => "read_only",
                _ => "io",
            },
            Error::InvalidRequest(_) => "invalid_request",
            Error::Cancelled => "cancelled",
            Error::PasswordRequired => "password_required",
            Error::WrongPassword => "wrong_password",
            Error::CorruptArchive(_) => "corrupt_archive",
            Error::CorruptImage(_) => "corrupt_image",
            Error::CorruptPdf(_) => "corrupt_pdf",
            Error::PageOutOfRange { .. } => "page_out_of_range",
            Error::PdfWorker(_) => "pdf_worker_failed",
            Error::OfficeConversion(_) => "office_conversion_failed",
            Error::PdfTool(_) => "pdf_tool_failed",
            Error::Unsupported(_) => "unsupported",
            Error::UnsupportedFormat(_) => "unsupported_format",
            Error::UnsupportedConversion { .. } => "unsupported_conversion",
            Error::EngineUnavailable { .. } => "engine_unavailable",
            Error::UnsafeEntry(_) => "unsafe_entry",
            Error::ExpansionLimit { .. } => "expansion_limit",
            Error::WouldOverwriteSource(_) => "would_overwrite_source",
            Error::DestinationNotFile(_) => "destination_not_file",
        }
    }

    /// Plain-language message safe to show to a user.
    pub fn user_message(&self) -> String {
        match self {
            Error::Io { path, source } => {
                let what = path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .map(|n| format!("“{}”", n.to_string_lossy()))
                    .unwrap_or_else(|| "a file or folder".into());
                match source.kind() {
                    io::ErrorKind::PermissionDenied => format!(
                        "Access to {what} was denied. Check that it isn't read-only or open in another program."
                    ),
                    io::ErrorKind::NotFound => {
                        format!("{what} couldn't be found. It may have been moved or deleted.")
                    }
                    io::ErrorKind::StorageFull => {
                        "There isn't enough space in the selected folder.".into()
                    }
                    io::ErrorKind::ReadOnlyFilesystem => {
                        "The selected folder is read-only.".into()
                    }
                    _ => format!("Couldn't read or write {what} ({source})."),
                }
            }
            Error::InvalidRequest(m) => m.clone(),
            Error::Cancelled => "The job was cancelled.".into(),
            Error::PasswordRequired => "This file is password-protected. Enter the password to open it.".into(),
            Error::WrongPassword => "The password is incorrect.".into(),
            Error::CorruptArchive(_) => "This archive is damaged or isn't a valid ZIP file.".into(),
            Error::CorruptImage(_) => "This image is damaged or incomplete.".into(),
            Error::CorruptPdf(_) => "This PDF is damaged or isn't a valid PDF file.".into(),
            Error::PageOutOfRange { page } => format!("This PDF has no page {page}."),
            Error::PdfWorker(_) => {
                "The PDF engine stopped while reading this file. It may be damaged, or too complex to open safely.".into()
            }
            Error::OfficeConversion(m) => format!("This document couldn't be converted: {m}."),
            Error::PdfTool(m) => format!("This PDF couldn't be processed: {m}."),
            Error::Unsupported(m) => format!("This isn't supported yet: {m}."),
            Error::UnsupportedFormat(name) => format!("“{name}” isn't a file type this operation can use."),
            Error::UnsupportedConversion { from, to } => format!("Converting {} to {} isn't supported.", from.to_uppercase(), to.to_uppercase()),
            Error::EngineUnavailable { engine, reason } => format!("{engine} isn't available: {reason}"),
            Error::UnsafeEntry(name) => format!(
                "This archive contains an unsafe path (“{name}”) that would write outside the destination folder, so it was not extracted."
            ),
            Error::ExpansionLimit { .. } => {
                "This archive would expand to an unusually large size, so it was not extracted. It may be a decompression bomb.".into()
            }
            Error::WouldOverwriteSource(_) => {
                "That would overwrite one of the original files. Choose a different folder or keep both files.".into()
            }
            Error::DestinationNotFile(_) => {
                "A folder already exists where the output file should go.".into()
            }
        }
    }
}

pub(crate) trait IoContext<T> {
    fn at(self, path: &Path) -> Result<T>;
}

impl<T> IoContext<T> for io::Result<T> {
    fn at(self, path: &Path) -> Result<T> {
        self.map_err(|e| Error::from(e).at(path))
    }
}
