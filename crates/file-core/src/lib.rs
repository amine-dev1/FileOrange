//! Local file processing engines and the job framework behind the desktop app.
//! Contains no UI or Tauri code, so everything here is unit-testable.

pub mod engine;
pub mod error;
pub mod formats;
pub mod fs_safe;
pub mod job;
pub mod request;

// Stable paths for code written before engines moved into `engine/`.
pub use engine::image as image_conv;
pub use engine::pdf;
pub use engine::zip as archive;

pub use error::{Error, Result};
pub use engine::{Availability, Capabilities, Engine, Registry};
pub use fs_safe::ConflictPolicy;
pub use job::{CancelToken, FileResult, JobContext, JobId, JobManager, JobState, JobStatus, Outcome};
pub use request::{JobRequest, Operation, Review};
