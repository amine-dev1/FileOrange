//! API-side job registry: ties an HTTP job id to a file-core job and its
//! private directory, and retires both after the retention period.

use crate::config::ApiConfig;
use crate::types::*;
use file_core::{JobManager, JobState, JobStatus};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

pub struct JobRecord {
    pub id: String,
    /// The principal that created it; nobody else may see it.
    pub owner: String,
    /// Where it came from, for the per-address limits.
    pub ip: Option<std::net::IpAddr>,
    pub operation: &'static str,
    pub dir: PathBuf,
    pub core_id: OnceLock<String>,
    pub finished_at: Mutex<Option<Instant>>,
    /// stored (sanitized) file name -> name the client sent, for display
    pub display_names: HashMap<String, String>,
    pub bundle: tokio::sync::Mutex<Option<PathBuf>>,
}

impl JobRecord {
    pub fn inputs_dir(&self) -> PathBuf {
        self.dir.join("inputs")
    }
    pub fn outputs_dir(&self) -> PathBuf {
        self.dir.join("outputs")
    }
}

pub struct Store {
    pub core: Arc<JobManager>,
    jobs: RwLock<HashMap<String, Arc<JobRecord>>>,
    uploading: AtomicUsize,
    max_stored: usize,
}

/// Holds a capacity slot while an upload is in flight.
pub struct Slot<'a>(&'a Store);
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.uploading.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Store {
    pub fn new(cfg: &ApiConfig, registry: Arc<file_core::Registry>) -> Self {
        Self {
            core: Arc::new(JobManager::with_registry(cfg.max_concurrent_processing, registry)),
            jobs: RwLock::new(HashMap::new()),
            uploading: AtomicUsize::new(0),
            max_stored: cfg.max_stored_jobs,
        }
    }

    pub fn reserve(&self) -> Option<Slot<'_>> {
        let stored = self.jobs.read().unwrap().len();
        let prev = self.uploading.fetch_add(1, Ordering::SeqCst);
        if stored + prev >= self.max_stored {
            self.uploading.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Slot(self))
    }

    pub fn insert(&self, rec: Arc<JobRecord>) {
        self.jobs.write().unwrap().insert(rec.id.clone(), rec);
    }

    /// How many jobs are still running (not finished) whose record satisfies `pred`.
    pub fn count_active(&self, pred: impl Fn(&JobRecord) -> bool) -> usize {
        let recs: Vec<Arc<JobRecord>> = self.jobs.read().unwrap().values().filter(|r| pred(r)).cloned().collect();
        recs.iter().filter(|r| self.core_status(r).is_some_and(|s| !s.status.is_finished())).count()
    }

    pub fn get(&self, id: &str) -> Option<Arc<JobRecord>> {
        self.jobs.read().unwrap().get(id).cloned()
    }

    pub fn core_status(&self, rec: &JobRecord) -> Option<JobStatus> {
        self.core.get(rec.core_id.get()?)
    }

    /// Remove jobs whose retention has elapsed. Returns the directories to delete.
    pub fn take_expired(&self, retention: std::time::Duration) -> Vec<PathBuf> {
        let mut jobs = self.jobs.write().unwrap();
        let expired: Vec<String> = jobs
            .values()
            .filter(|r| r.finished_at.lock().unwrap().is_some_and(|t| t.elapsed() >= retention))
            .map(|r| r.id.clone())
            .collect();
        expired
            .into_iter()
            .filter_map(|id| jobs.remove(&id))
            .map(|r| {
                if let Some(cid) = r.core_id.get() {
                    self.core.remove(cid);
                }
                r.dir.clone()
            })
            .collect()
    }

    /// Cancel everything and forget it (shutdown).
    pub fn drain(&self) -> Vec<PathBuf> {
        let mut jobs = self.jobs.write().unwrap();
        jobs.drain()
            .map(|(_, r)| {
                if let Some(cid) = r.core_id.get() {
                    let _ = self.core.cancel(cid);
                }
                r.dir.clone()
            })
            .collect()
    }
}

pub fn wire_status(s: JobState) -> WireStatus {
    match s {
        JobState::Queued => WireStatus::Queued,
        JobState::Running => WireStatus::Running,
        JobState::Completed => WireStatus::Completed,
        JobState::Failed => WireStatus::Failed,
        JobState::Cancelled => WireStatus::Cancelled,
    }
}

pub fn to_response(rec: &JobRecord, s: &JobStatus) -> JobResponse {
    use file_core::Outcome;
    let display = |name: &str| rec.display_names.get(name).cloned().unwrap_or_else(|| name.to_string());
    let percent = match (s.status, s.bytes_total, s.files_total) {
        (JobState::Completed, _, _) => 100,
        (_, Some(b), _) if b > 0 => (s.bytes_processed.min(b) * 100 / b) as u8,
        (_, _, f) if f > 0 => (s.files_completed.min(f) * 100 / f) as u8,
        _ => 0,
    };
    JobResponse {
        job_id: rec.id.clone(),
        operation: rec.operation.to_string(),
        status: wire_status(s.status),
        progress: Progress {
            files_completed: s.files_completed,
            files_total: s.files_total,
            percent,
            bytes_processed: s.bytes_processed,
            bytes_total: s.bytes_total,
        },
        current_file: s.current_file.as_deref().map(display),
        results: s
            .results
            .iter()
            .map(|r| FileOutcome {
                input: display(&r.input),
                outcome: match r.outcome {
                    Outcome::Done => WireOutcome::Done,
                    Outcome::Skipped => WireOutcome::Skipped,
                    Outcome::Failed => WireOutcome::Failed,
                },
                // file name only: never reveal where the server keeps things
                output: r.output.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()),
                error_code: r.error_code.as_ref().map(|c| c.to_uppercase()),
                message: r.message.clone(),
            })
            .collect(),
        error: s.error_code.as_ref().map(|c| JobError {
            code: c.to_uppercase(),
            message: s.user_message.clone().unwrap_or_default(),
        }),
        message: s.user_message.clone(),
    }
}
