//! PDF engine: opens PDFs and renders pages through PDFium.
//!
//! PDFium is a large C++ library that parses untrusted files, so it never runs
//! in the app's own process. Every call starts a short-lived worker process
//! (see [`worker`]), with a timeout and a memory cap, that loads the PDFium
//! library, does one thing and exits. If PDFium crashes, the app sees an error
//! for that one call and carries on.

pub mod annotate;
mod draw;
mod host;
pub mod ops;
pub(crate) mod sandbox;
pub mod worker;

pub use host::{AssembleError, AssembleSource, HostConfig, PdfHost, Rendered, WorkerProgram};
pub use ops::{ImagesToPdfOptions, PageSpec, PdfMergeOptions, PdfPagesOptions, PdfSplitOptions, PdfToImagesOptions, SplitMode};
pub use worker::{ImagesLayout, Orientation, PageRef, PaperSize};

use super::{Availability, Choice, Engine, EngineInfo, OperationSpec, OptionKind, OptionSpec};
use crate::error::Result;
use crate::formats::{self, FileDescriptor, FormatInfo, FormatKind};
use crate::request::{JobRequest, Operation, Review};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Widest preview the engine will draw. Callers asking for more get this.
pub const MAX_RENDER_WIDTH: u32 = 4096;
pub const MIN_RENDER_WIDTH: u32 = 16;
/// Bounds on the drawn bitmap so a 200-inch page can't ask for gigabytes.
pub const MAX_RENDER_HEIGHT: u32 = 8192;
pub const MAX_RENDER_PIXELS: u64 = 24_000_000;
/// Documents with more pages than this are refused rather than listed.
pub const MAX_PAGES: u32 = 50_000;
/// Limits for drawing a page to save as a picture: far larger than for a preview, but still bounded.
pub const EXPORT_MAX_SIDE: u32 = 14_400;
pub const EXPORT_MAX_PIXELS: u64 = 64_000_000;

/// The id of the interactive "view pages" operation.
pub const OP_VIEW: &str = "pdf_view";

/// Size of one page as displayed (after the page's own rotation), in PDF points (1/72 inch).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageInfo {
    pub width_pt: f32,
    pub height_pt: f32,
}

/// What the document's author allows. These are the author's request, not enforced
/// by the file itself; OrangeFile shows them and warns, it does not try to bypass them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdfPermissions {
    pub print: bool,
    pub copy: bool,
    pub modify: bool,
    pub annotate: bool,
    pub fill_forms: bool,
    pub assemble: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdfMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    /// As written in the file (e.g. `D:20240102…`); not interpreted.
    pub created: Option<String>,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfInfo {
    pub page_count: u32,
    pub pages: Vec<PageInfo>,
    pub version: Option<String>,
    pub encrypted: bool,
    pub permissions: Option<PdfPermissions>,
    pub has_form: bool,
    pub signature_count: u32,
    pub metadata: PdfMetadata,
    /// Plain-language things to know before editing this file.
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl PdfInfo {
    /// Warnings derived from the facts above. Kept in one place so every caller says the same thing.
    pub fn compute_warnings(&mut self) {
        let mut w = Vec::new();
        if self.signature_count > 0 {
            let n = self.signature_count;
            w.push(format!(
                "This PDF has {n} digital signature{}. Editing it will invalidate {}. OrangeFile can't create or verify digital signatures.",
                if n == 1 { "" } else { "s" },
                if n == 1 { "it" } else { "them" },
            ));
        }
        if let Some(p) = &self.permissions {
            let mut limits = Vec::new();
            if !p.print {
                limits.push("printing");
            }
            if !p.copy {
                limits.push("copying text");
            }
            if !p.modify {
                limits.push("editing");
            }
            if !limits.is_empty() {
                w.push(format!("The author of this PDF has asked to restrict {}.", limits.join(", ")));
            }
        }
        let big = self.pages.iter().filter(|p| p.width_pt.max(p.height_pt) > 5000.0).count();
        if big > 0 {
            w.push("Some pages are very large; their previews are drawn at reduced detail.".into());
        }
        self.warnings = w;
    }
}

/// Registered with the engine registry; the actual work is in [`PdfHost`].
pub struct PdfEngine {
    host: Arc<PdfHost>,
}

impl PdfEngine {
    pub fn new(host: Arc<PdfHost>) -> Self {
        Self { host }
    }

    pub fn host(&self) -> &Arc<PdfHost> {
        &self.host
    }
}

impl Engine for PdfEngine {
    fn info(&self) -> EngineInfo {
        EngineInfo {
            id: "pdf".into(),
            name: "PDF tools (PDFium)".into(),
            version: self.host.version(),
            availability: self.host.availability(),
            license: "BSD-3-Clause AND Apache-2.0".into(),
        }
    }

    fn operations(&self) -> Vec<OperationSpec> {
        let pdf = || vec![formats::PDF.to_string()];
        let text = |id: &str, label: &str, help: &str, max_len: u32| OptionSpec {
            id: id.into(),
            label: label.into(),
            help: Some(help.into()),
            kind: OptionKind::Text { max_len },
            applies_to: vec![],
        };
        let password = || OptionSpec {
            id: "password".into(),
            label: "Password".into(),
            help: Some("Only if a PDF is password-protected. Used for this job only and never saved. The new PDF is not protected.".into()),
            kind: OptionKind::Secret,
            applies_to: vec![],
        };
        let op = |id: &str, label: &str, description: &str, interactive: bool, options: Vec<OptionSpec>| OperationSpec {
            id: id.into(),
            label: label.into(),
            description: description.into(),
            inputs: pdf(),
            outputs: if interactive && id == OP_VIEW { vec![] } else { pdf() },
            pairs: vec![],
            options,
            interactive,
        };
        vec![
            op(OP_VIEW, "View PDF pages", "Open a PDF to see its pages as thumbnails and a large preview.", true, vec![]),
            op(
                "pdf_merge",
                "Merge PDFs",
                "Combine several PDFs into one, in the order you choose.",
                false,
                vec![text("output_name", "File name", "Name of the merged PDF. Default: merged.pdf.", 120), password()],
            ),
            op(
                "pdf_split",
                "Split PDF",
                "Split one PDF into several, by number of pages or by page ranges.",
                false,
                vec![
                    OptionSpec {
                        id: "mode".into(),
                        label: "Split by".into(),
                        help: None,
                        kind: OptionKind::Choice {
                            choices: vec![
                                Choice { value: "every".into(), label: "Pages per file".into() },
                                Choice { value: "ranges".into(), label: "Page ranges".into() },
                            ],
                            default: "every".into(),
                        },
                        applies_to: vec![],
                    },
                    OptionSpec {
                        id: "every".into(),
                        label: "Pages per file".into(),
                        help: Some("1 makes one file per page.".into()),
                        kind: OptionKind::Int { min: 1, max: MAX_PAGES as i64, default: 1 },
                        applies_to: vec![],
                    },
                    text("ranges", "Page ranges", "One new file per range, for example 1-3, 4, 7-. A trailing dash means to the end.", 2000),
                    password(),
                ],
            ),
            OperationSpec {
                id: "images_to_pdf".into(),
                label: "Images to PDF".into(),
                description: "Put pictures on pages, one per picture, in the order you choose.".into(),
                inputs: vec![formats::JPEG.into(), formats::PNG.into(), formats::WEBP.into()],
                outputs: pdf(),
                pairs: vec![],
                options: vec![
                    OptionSpec {
                        id: "paper".into(),
                        label: "Page size".into(),
                        help: None,
                        kind: OptionKind::Choice {
                            choices: vec![
                                Choice { value: "a4".into(), label: "A4".into() },
                                Choice { value: "letter".into(), label: "US Letter".into() },
                                Choice { value: "fit".into(), label: "Same size as the picture".into() },
                            ],
                            default: "a4".into(),
                        },
                        applies_to: vec![],
                    },
                    OptionSpec {
                        id: "orientation".into(),
                        label: "Orientation".into(),
                        help: Some("Automatic follows each picture's shape. Only used for A4 and Letter.".into()),
                        kind: OptionKind::Choice {
                            choices: vec![
                                Choice { value: "auto".into(), label: "Automatic".into() },
                                Choice { value: "portrait".into(), label: "Portrait".into() },
                                Choice { value: "landscape".into(), label: "Landscape".into() },
                            ],
                            default: "auto".into(),
                        },
                        applies_to: vec![],
                    },
                    OptionSpec { id: "margin_mm".into(), label: "Margin (mm)".into(), help: None, kind: OptionKind::Int { min: 0, max: 100, default: 10 }, applies_to: vec![] },
                    text("output_name", "File name", "Name of the PDF. Default: the picture's name, or “images”.", 120),
                ],
                interactive: false,
            },
            OperationSpec {
                id: "pdf_to_images".into(),
                label: "PDF pages to images".into(),
                description: "Save pages of a PDF as pictures at the resolution you choose.".into(),
                inputs: pdf(),
                outputs: vec![formats::PNG.into(), formats::JPEG.into(), formats::WEBP.into()],
                pairs: [formats::PNG, formats::JPEG, formats::WEBP].iter().map(|to| super::ConversionPair { from: formats::PDF.into(), to: (*to).into(), notes: if *to == formats::PNG { vec![] } else { vec!["Lossy: quality is reduced slightly.".into()] } }).collect(),
                options: vec![
                    OptionSpec { id: "dpi".into(), label: "Resolution (dpi)".into(), help: Some("150 is good for screens, 300 for printing. Very large pages are drawn smaller than asked.".into()), kind: OptionKind::Int { min: ops::MIN_DPI as i64, max: ops::MAX_DPI as i64, default: 150 }, applies_to: vec![] },
                    text("pages", "Pages", "For example 1-3, 5, 9-. Leave empty for every page.", 2000),
                    OptionSpec { id: "quality".into(), label: "Quality".into(), help: Some("Higher looks better but makes bigger files.".into()), kind: OptionKind::Int { min: 1, max: 100, default: 90 }, applies_to: vec![super::AppliesTo { format: formats::JPEG.into(), when: None }, super::AppliesTo { format: formats::WEBP.into(), when: None }] },
                    password(),
                ],
                interactive: false,
            },
            op("pdf_annotate", "Annotate PDF", "Highlight, underline, draw, add notes, text, shapes and pictures, then save a copy.", true, vec![]),
            op("pdf_reorder", "Reorder pages", "Move pages into a new order and save a copy.", true, vec![]),
            op("pdf_rotate", "Rotate pages", "Turn pages by 90, 180 or 270 degrees and save a copy.", true, vec![]),
            op("pdf_delete_pages", "Delete pages", "Leave pages out and save a copy.", true, vec![]),
            op("pdf_extract_pages", "Extract pages", "Save chosen pages as a new PDF.", true, vec![]),
        ]
    }

    fn formats(&self) -> Vec<FormatInfo> {
        vec![FormatInfo::new(formats::PDF, "PDF", &["pdf"], "application/pdf", FormatKind::Pdf)]
    }

    fn handles(&self, op_name: &str) -> bool {
        // `pdf_pages` is the one job type behind reorder, rotate, delete and extract.
        op_name == "pdf_pages" || self.operations().iter().any(|o| o.id == op_name)
    }

    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()> {
        ops::preflight(op, files, strict)
    }

    fn review(&self, req: &JobRequest) -> Result<Review> {
        ops::review(&self.host, req)
    }

    fn run(&self, req: &JobRequest, ctx: &crate::job::JobContext) -> Result<()> {
        ops::run(&self.host, req, ctx)
    }

    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }
}

/// Is this worker-reported availability one the UI can use? (Convenience for tests.)
pub fn is_usable(a: &Availability) -> bool {
    a.is_available()
}
