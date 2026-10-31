//! Typed job requests, validation, review (dry run) and dispatch to engines.

use crate::engine::{self, Registry};
use crate::error::{Error, IoContext, Result};
use crate::formats::{self, FileDescriptor};
use crate::fs_safe::{self, ConflictPolicy};
use crate::engine::image::ImageOptions;
use crate::engine::office::OfficeToPdfOptions;
use crate::engine::pdf::{ImagesToPdfOptions, PdfMergeOptions, PdfPagesOptions, PdfSplitOptions, PdfToImagesOptions};
use crate::job::JobContext;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::PathBuf;

/// A password that never shows up in logs or serialized output.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The only way to read the value; call sites are the few places that need it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompressOptions {
    pub archive_name: Option<String>,
    #[serde(default = "yes")]
    pub include_folders: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExtractOptions {
    pub password: Option<Secret>,
    /// Put each archive's files in a folder named after it.
    #[serde(default = "yes")]
    pub subfolder: bool,
    pub max_total_bytes: Option<u64>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Operation {
    Compress(CompressOptions),
    Extract(ExtractOptions),
    ConvertImage(ImageOptions),
    PdfMerge(PdfMergeOptions),
    PdfSplit(PdfSplitOptions),
    /// Reorder, rotate, delete or extract pages: the result is exactly the pages listed.
    PdfPages(PdfPagesOptions),
    /// One PDF page per picture.
    ImagesToPdf(ImagesToPdfOptions),
    /// Save PDF pages as pictures.
    PdfToImages(PdfToImagesOptions),
    /// Word, Excel, PowerPoint and OpenDocument files to PDF, by LibreOffice.
    OfficeToPdf(OfficeToPdfOptions),
}

impl Operation {
    pub fn name(&self) -> &'static str {
        match self {
            Operation::Compress(_) => "compress",
            Operation::Extract(_) => "extract",
            Operation::ConvertImage(_) => "convert_image",
            Operation::PdfMerge(_) => "pdf_merge",
            Operation::PdfSplit(_) => "pdf_split",
            Operation::PdfPages(_) => "pdf_pages",
            Operation::ImagesToPdf(_) => "images_to_pdf",
            Operation::PdfToImages(_) => "pdf_to_images",
            Operation::OfficeToPdf(_) => "office_to_pdf",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct JobRequest {
    pub inputs: Vec<PathBuf>,
    pub output_dir: PathBuf,
    #[serde(default)]
    pub conflict: ConflictPolicy,
    pub operation: Operation,
}

/// Everything checked again in Rust, whatever the UI already did.
pub fn validate(req: &JobRequest) -> Result<()> {
    validate_with(engine::global(), req)
}

pub fn validate_with(registry: &Registry, req: &JobRequest) -> Result<()> {
    let bad = |m: &str| Err(Error::InvalidRequest(m.into()));
    if req.inputs.is_empty() {
        return bad("Choose at least one file.");
    }
    for p in req.inputs.iter().chain(std::iter::once(&req.output_dir)) {
        if !p.is_absolute() {
            return bad("File locations must be full paths.");
        }
    }
    let mut files = Vec::new();
    for p in &req.inputs {
        let meta = fs::metadata(p).at(p)?;
        let is_dir_ok = matches!(&req.operation, Operation::Compress(o) if o.include_folders);
        if !(meta.is_file() || (meta.is_dir() && is_dir_ok)) {
            return Err(Error::InvalidRequest(format!("“{}” can't be used for this operation.", p.display())));
        }
        if meta.is_file() {
            files.push(FileDescriptor {
                name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                size: meta.len(),
                format: formats::detect_file(p).map(String::from),
            });
        }
    }
    fs_safe::check_writable_dir(&req.output_dir)?;
    // Engine availability, option ranges and conversion pairs. Not strict: a file
    // whose content isn't recognised is reported by the job, so a batch keeps going.
    registry.engine_for(req.operation.name())?.preflight(&req.operation, &files, false)
}

pub fn run(req: &JobRequest, ctx: &JobContext) -> Result<()> {
    run_with(engine::global(), req, ctx)
}

pub fn run_with(registry: &Registry, req: &JobRequest, ctx: &JobContext) -> Result<()> {
    registry.engine_for(req.operation.name())?.run(req, ctx)
}

// ------------------------------------------------------------------ review

#[derive(Debug, Default, Serialize)]
pub struct Review {
    /// Existing files that the chosen policy would rename, replace or skip.
    pub conflicts: Vec<PathBuf>,
    pub warnings: Vec<String>,
    /// Problems that make the job impossible; the UI should block Start.
    pub errors: Vec<String>,
    pub needs_password: bool,
    pub total_bytes: u64,
}

pub const MAX_CONFLICTS: usize = 200;

/// A dry run for the review screen. Writes nothing.
pub fn review(req: &JobRequest) -> Result<Review> {
    review_with(engine::global(), req)
}

pub fn review_with(registry: &Registry, req: &JobRequest) -> Result<Review> {
    validate_with(registry, req)?;
    registry.engine_for(req.operation.name())?.review(req)
}
