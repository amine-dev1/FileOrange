//! Engine registry: the one place that knows which operations, formats and
//! conversion pairs this build of the app can actually perform.
//!
//! Each engine lives in its own module behind the [`Engine`] trait. The UI and
//! the API never assume a capability; they ask the registry.

pub mod image;
pub mod office;
pub mod pdfsize;
pub mod qpdf;
pub mod pdf;
pub mod zip;

use crate::error::{Error, Result};
use crate::formats::{bundled_formats, FileDescriptor, FormatInfo};
use crate::job::JobContext;
use crate::request::{JobRequest, Operation, Review};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};

// ------------------------------------------------------------------ report types

/// Whether an engine can be used right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Availability {
    /// Ships inside the app.
    Bundled,
    /// A separately installed engine that was found and verified. Its location is never reported.
    Installed,
    Unavailable { reason: String },
}

impl Availability {
    pub fn is_available(&self) -> bool {
        !matches!(self, Availability::Unavailable { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub availability: Availability,
    /// SPDX-style license expression of the engine and its main libraries.
    pub license: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversionPair {
    pub from: String,
    pub to: String,
    /// What the user should know about this particular conversion.
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OptionKind {
    Bool { default: bool },
    Int { min: i64, max: i64, default: i64 },
    Choice { choices: Vec<Choice>, default: String },
    /// `#RRGGBB`
    Color { default: String },
    Text { max_len: u32 },
    /// Entered by the user, never stored or logged.
    Secret,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionCondition {
    pub option: String,
    pub equals: String,
}

/// Where an option is meaningful. An option with an empty list applies everywhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliesTo {
    /// Output format id.
    pub format: String,
    /// Only while another option has this value.
    pub when: Option<OptionCondition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionSpec {
    pub id: String,
    pub label: String,
    pub help: Option<String>,
    pub kind: OptionKind,
    #[serde(default)]
    pub applies_to: Vec<AppliesTo>,
}

/// One thing an engine can do, e.g. "convert images" or "extract archives".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationSpec {
    /// Wire id, e.g. "convert_image".
    pub id: String,
    pub label: String,
    pub description: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    /// Exact input/output pairs. Empty for operations that are not conversions.
    #[serde(default)]
    pub pairs: Vec<ConversionPair>,
    #[serde(default)]
    pub options: Vec<OptionSpec>,
    /// Works on a document the user is looking at (open, preview, edit) rather than as a
    /// batch job. Interactive operations are not accepted by `POST /jobs`.
    #[serde(default)]
    pub interactive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationReport {
    #[serde(flatten)]
    pub spec: OperationSpec,
    pub engine: String,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineReport {
    #[serde(flatten)]
    pub info: EngineInfo,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    pub max_archive_entries: u64,
    pub default_max_extract_bytes: u64,
    pub max_image_dimension: u64,
    pub max_webp_dimension: u64,
    pub max_pdf_render_width: u64,
    // Filled in by the API, which owns request-level limits.
    #[serde(default)]
    pub max_file_bytes: Option<u64>,
    #[serde(default)]
    pub max_request_bytes: Option<u64>,
    #[serde(default)]
    pub max_files: Option<u64>,
    #[serde(default)]
    pub max_concurrent_jobs: Option<u64>,
    #[serde(default)]
    pub retention_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub schema: u32,
    pub engines: Vec<EngineReport>,
    pub operations: Vec<OperationReport>,
    pub formats: Vec<FormatInfo>,
    pub limits: Limits,
}

// ------------------------------------------------------------------ the adapter

/// What every engine must provide. Engines never talk to the UI or the network.
pub trait Engine: Send + Sync {
    fn info(&self) -> EngineInfo;
    fn operations(&self) -> Vec<OperationSpec>;
    /// Formats this engine reads or writes (for the catalog).
    fn formats(&self) -> Vec<FormatInfo>;

    /// Check an operation against what is known about the inputs, without touching disk.
    /// `strict` rejects inputs whose content is not a supported input format; non-strict
    /// leaves those for the job to report one by one (batches keep going).
    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()>;

    /// Dry run on real paths: conflicts, warnings, blocking problems. Writes nothing.
    fn review(&self, req: &JobRequest) -> Result<Review>;

    /// Do the work. Honours cancellation and reports progress through `ctx`.
    fn run(&self, req: &JobRequest, ctx: &JobContext) -> Result<()>;

    /// Does this engine run the operation named `op_name` (`Operation::name`)? By default: is it one of its operation ids.
    fn handles(&self, op_name: &str) -> bool {
        self.operations().iter().any(|o| o.id == op_name)
    }

    /// Lets the API reach an engine's own interface (e.g. the PDF host) through the registry.
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        None
    }
}

// ------------------------------------------------------------------ the registry

pub struct Registry {
    engines: Vec<Arc<dyn Engine>>,
}

impl Registry {
    pub fn new(engines: Vec<Arc<dyn Engine>>) -> Self {
        Self { engines }
    }

    /// The engines that ship inside the app.
    pub fn bundled() -> Self {
        Self::bundled_with(Arc::new(pdf::PdfHost::new(pdf::HostConfig::for_app())))
    }

    /// Like [`Registry::bundled`], with a configured PDF host (worker program, library folders).
    pub fn bundled_with(pdf: Arc<pdf::PdfHost>) -> Self {
        Self::bundled_with_office(pdf, Arc::new(office::OfficeHost::new(office::OfficeConfig::for_app())))
    }

    /// Both external engines configured (where PDFium and LibreOffice are).
    pub fn bundled_with_office(pdf: Arc<pdf::PdfHost>, office: Arc<office::OfficeHost>) -> Self {
        Self::bundled_with_hosts(pdf, office, Arc::new(qpdf::QpdfHost::new(qpdf::QpdfConfig::for_app())))
    }

    /// Every external program configured (PDFium, LibreOffice, qpdf).
    pub fn bundled_with_hosts(pdf: Arc<pdf::PdfHost>, office: Arc<office::OfficeHost>, qpdf: Arc<qpdf::QpdfHost>) -> Self {
        Self::new(vec![
            Arc::new(zip::ZipEngine),
            Arc::new(image::ImageEngine),
            Arc::new(pdf::PdfEngine::new(pdf)),
            Arc::new(office::OfficeEngine::new(office)),
            Arc::new(qpdf::QpdfEngine::new(qpdf.clone())),
            Arc::new(pdfsize::PdfSizeEngine::new(qpdf)),
        ])
    }

    pub fn office_host(&self) -> Option<Arc<office::OfficeHost>> {
        self.engines.iter().find_map(|e| e.as_any()?.downcast_ref::<office::OfficeEngine>().map(|o| o.host().clone()))
    }

    /// The PDF host, if a PDF engine is registered (even an unavailable one).
    pub fn pdf_host(&self) -> Option<Arc<pdf::PdfHost>> {
        self.engines.iter().find_map(|e| e.as_any()?.downcast_ref::<pdf::PdfEngine>().map(|p| p.host().clone()))
    }

    /// The engine that handles an operation id, or why it cannot be used.
    pub fn engine_for(&self, operation_id: &str) -> Result<&Arc<dyn Engine>> {
        for e in &self.engines {
            if e.handles(operation_id) {
                let info = e.info();
                return match info.availability {
                    Availability::Unavailable { reason } => Err(Error::EngineUnavailable { engine: info.name, reason }),
                    _ => Ok(e),
                };
            }
        }
        Err(Error::Unsupported(format!("no engine handles “{operation_id}”")))
    }

    pub fn operation(&self, operation_id: &str) -> Option<OperationSpec> {
        self.engines.iter().flat_map(|e| e.operations()).find(|o| o.id == operation_id)
    }

    /// Is `from` → `to` a pair this build can perform for the operation?
    pub fn check_pair(&self, operation_id: &str, from: &str, to: &str) -> Result<()> {
        let op = self.operation(operation_id).ok_or_else(|| Error::Unsupported(format!("no engine handles “{operation_id}”")))?;
        if op.pairs.iter().any(|p| p.from == from && p.to == to) {
            Ok(())
        } else {
            Err(Error::UnsupportedConversion { from: from.into(), to: to.into() })
        }
    }

    pub fn capabilities(&self) -> Capabilities {
        let mut formats: Vec<FormatInfo> = Vec::new();
        for f in self.engines.iter().flat_map(|e| e.formats()) {
            if !formats.iter().any(|x| x.id == f.id) {
                formats.push(f);
            }
        }
        let mut engines = Vec::new();
        let mut operations = Vec::new();
        for e in &self.engines {
            let info = e.info();
            let ops = e.operations();
            let reason = match &info.availability {
                Availability::Unavailable { reason } => Some(reason.clone()),
                _ => None,
            };
            engines.push(EngineReport { info: info.clone(), operations: ops.iter().map(|o| o.id.clone()).collect() });
            operations.extend(ops.into_iter().map(|spec| OperationReport {
                spec,
                engine: info.id.clone(),
                available: reason.is_none(),
                unavailable_reason: reason.clone(),
            }));
        }
        Capabilities { schema: 1, engines, operations, formats, limits: core_limits() }
    }
}

pub fn core_limits() -> Limits {
    Limits {
        max_archive_entries: zip::MAX_ENTRIES as u64,
        default_max_extract_bytes: zip::DEFAULT_MAX_EXTRACT_BYTES,
        max_image_dimension: image::MAX_DIMENSION as u64,
        max_webp_dimension: image::MAX_WEBP_DIMENSION as u64,
        max_pdf_render_width: pdf::MAX_RENDER_WIDTH as u64,
        ..Limits::default()
    }
}

static GLOBAL: OnceLock<Arc<Registry>> = OnceLock::new();

/// The registry used by the app. Tests build their own with [`Registry::new`].
pub fn global() -> &'static Arc<Registry> {
    GLOBAL.get_or_init(|| Arc::new(Registry::bundled()))
}

/// Install the registry [`global`] returns (e.g. one whose PDF host knows where the installer put PDFium).
/// Must be called before anything uses `global()`; returns false if a registry was already in place.
pub fn set_global(registry: Arc<Registry>) -> bool {
    GLOBAL.set(registry).is_ok()
}

/// Catalog of formats, kept here so tools that only need names don't build engines.
pub fn catalog() -> Vec<FormatInfo> {
    bundled_formats()
}
