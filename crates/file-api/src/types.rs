//! Wire types shared by the server and its clients (the desktop app).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl WireStatus {
    pub fn is_finished(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireOutcome {
    Done,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    pub files_completed: u64,
    pub files_total: u64,
    pub percent: u8,
    pub bytes_processed: u64,
    pub bytes_total: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOutcome {
    /// The name the client uploaded (display only).
    pub input: String,
    pub outcome: WireOutcome,
    /// Name of the produced file or folder, never a server path.
    pub output: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateJobResponse {
    pub job_id: String,
    pub status: WireStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobResponse {
    pub job_id: String,
    pub operation: String,
    pub status: WireStatus,
    pub progress: Progress,
    pub current_file: Option<String>,
    pub results: Vec<FileOutcome>,
    pub error: Option<JobError>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultFile {
    pub index: usize,
    /// Relative, `/`-separated path inside the result.
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultManifest {
    pub files: Vec<ResultFile>,
    /// Relative paths of (possibly empty) folders to recreate.
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub status: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewFile {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    /// The first bytes of the file, hex-encoded (32 bytes are enough). Content, not extension, decides the format.
    #[serde(default)]
    pub head_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewRequest {
    pub operation: String,
    #[serde(default)]
    pub options: serde_json::Value,
    pub files: Vec<PreviewFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewIssue {
    pub code: String,
    pub message: String,
    pub file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewEngine {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResponse {
    pub ok: bool,
    pub operation: String,
    pub engine: Option<PreviewEngine>,
    pub errors: Vec<PreviewIssue>,
    pub warnings: Vec<String>,
}

/// `POST /session`: a signed token to send as `Authorization: Bearer …` on every other request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub token: String,
    /// Seconds until it stops working. Ask for a fresh one (sending this one) before then.
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeLimits {
    pub max_file_bytes: u64,
    pub max_request_bytes: u64,
    pub max_files: u64,
    pub daily_bytes: Option<u64>,
    pub max_active_jobs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeUsage {
    pub bytes_today: u64,
    pub jobs_this_hour: u32,
}

/// `GET /me`: what the caller may do and has used today.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeResponse {
    /// `local` for the desktop engine, `anonymous` for a visitor to a hosted server.
    pub tier: String,
    pub limits: MeLimits,
    pub usage: MeUsage,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LinkRequest {
    /// A single result file by its index; absent for the whole result (one file, or a ZIP of several).
    pub index: Option<usize>,
}

/// `POST /jobs/{id}/link`: a short-lived address a browser can open to download, with no header needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkResponse {
    pub url: String,
    pub expires_in: u64,
}

/// An open PDF: what the editor needs to lay out pages and show warnings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfDocumentResponse {
    pub id: String,
    /// The name the client uploaded (display only).
    pub name: String,
    pub size: u64,
    pub info: file_core::pdf::PdfInfo,
}
