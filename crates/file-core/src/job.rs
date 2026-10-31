//! Job state, progress reporting, cancellation and the background runner.

use crate::error::{Error, Result};
use crate::engine::{self, Registry};
use crate::request::{self, JobRequest};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub type JobId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn is_finished(self) -> bool {
        matches!(self, JobState::Completed | JobState::Failed | JobState::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Done,
    Skipped,
    Failed,
}

/// The result for one input (or, for archives, one archive).
#[derive(Debug, Clone, Serialize)]
pub struct FileResult {
    pub input: String,
    pub outcome: Outcome,
    pub output: Option<PathBuf>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

impl FileResult {
    pub fn done(input: impl Into<String>, output: PathBuf, message: Option<String>) -> Self {
        Self { input: input.into(), outcome: Outcome::Done, output: Some(output), error_code: None, message }
    }
    pub fn skipped(input: impl Into<String>, message: impl Into<String>) -> Self {
        Self { input: input.into(), outcome: Outcome::Skipped, output: None, error_code: None, message: Some(message.into()) }
    }
    pub fn failed(input: impl Into<String>, err: &Error) -> Self {
        Self {
            input: input.into(),
            outcome: Outcome::Failed,
            output: None,
            error_code: Some(err.code().into()),
            message: Some(err.user_message()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub job_id: JobId,
    pub operation: String,
    pub status: JobState,
    pub current_file: Option<String>,
    pub files_completed: u64,
    pub files_total: u64,
    pub bytes_processed: u64,
    pub bytes_total: Option<u64>,
    pub output_paths: Vec<PathBuf>,
    pub results: Vec<FileResult>,
    pub error_code: Option<String>,
    pub user_message: Option<String>,
}

/// Shared flag so a cancel request can be made from any thread.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

type Sink = Box<dyn Fn(&JobStatus) + Send + Sync>;

struct Inner {
    status: Mutex<JobStatus>,
    cancel: CancelToken,
    sink: Sink,
    last_emit: Mutex<Option<Instant>>,
}

/// Handle given to engines for reporting progress and observing cancellation.
#[derive(Clone)]
pub struct JobContext {
    inner: Arc<Inner>,
}

const EMIT_INTERVAL: Duration = Duration::from_millis(100);

impl JobContext {
    pub fn new(
        job_id: impl Into<JobId>,
        operation: &str,
        cancel: CancelToken,
        sink: impl Fn(&JobStatus) + Send + Sync + 'static,
    ) -> Self {
        let status = JobStatus {
            job_id: job_id.into(),
            operation: operation.to_string(),
            status: JobState::Queued,
            current_file: None,
            files_completed: 0,
            files_total: 0,
            bytes_processed: 0,
            bytes_total: None,
            output_paths: vec![],
            results: vec![],
            error_code: None,
            user_message: None,
        };
        Self {
            inner: Arc::new(Inner {
                status: Mutex::new(status),
                cancel,
                sink: Box::new(sink),
                last_emit: Mutex::new(None),
            }),
        }
    }

    /// A context that reports nowhere; handy for tests and one-off calls.
    pub fn silent() -> Self {
        Self::new("local", "local", CancelToken::default(), |_| {})
    }

    pub fn cancel_token(&self) -> CancelToken {
        self.inner.cancel.clone()
    }

    pub fn check_cancelled(&self) -> Result<()> {
        if self.inner.cancel.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }

    pub fn snapshot(&self) -> JobStatus {
        self.inner.status.lock().unwrap().clone()
    }

    fn update(&self, force: bool, f: impl FnOnce(&mut JobStatus)) {
        f(&mut self.inner.status.lock().unwrap());
        let due = {
            let mut last = self.inner.last_emit.lock().unwrap();
            let due = force || last.map_or(true, |t| t.elapsed() >= EMIT_INTERVAL);
            if due {
                *last = Some(Instant::now());
            }
            due
        };
        if due {
            (self.inner.sink)(&self.snapshot());
        }
    }

    pub fn set_totals(&self, files: u64, bytes: Option<u64>) {
        self.update(true, |s| {
            s.files_total = files;
            s.bytes_total = bytes;
        });
    }

    pub fn begin_file(&self, name: &str) {
        self.update(false, |s| s.current_file = Some(name.to_string()));
    }

    pub fn add_bytes(&self, n: u64) {
        self.update(false, |s| s.bytes_processed += n);
    }

    /// Count one file as processed (without recording a per-file result).
    pub fn file_processed(&self) {
        self.update(false, |s| s.files_completed += 1);
    }

    pub fn add_result(&self, result: FileResult) {
        self.update(false, |s| s.results.push(result));
    }

    pub fn add_output(&self, path: PathBuf) {
        self.update(false, |s| {
            if !s.output_paths.contains(&path) {
                s.output_paths.push(path);
            }
        });
    }

    fn set_state(&self, state: JobState) {
        self.update(true, |s| s.status = state);
    }

    fn finish(&self, outcome: Result<()>) {
        self.update(true, |s| {
            s.current_file = None;
            let failed = s.results.iter().filter(|r| r.outcome == Outcome::Failed).count();
            match outcome {
                Ok(()) if failed > 0 && failed == s.results.len() => {
                    s.status = JobState::Failed;
                    s.error_code = Some("all_failed".into());
                    s.user_message = Some("None of the files could be processed. See the details below.".into());
                }
                Ok(()) => {
                    s.status = JobState::Completed;
                    if failed > 0 {
                        s.user_message = Some(format!("{failed} file(s) could not be processed."));
                    }
                }
                Err(Error::Cancelled) => {
                    s.status = JobState::Cancelled;
                    s.user_message = Some("The job was cancelled. Original files were not changed.".into());
                }
                Err(e) => {
                    s.status = JobState::Failed;
                    s.error_code = Some(e.code().into());
                    s.user_message = Some(e.user_message());
                }
            }
        });
    }
}

/// Counting gate that bounds how many heavy jobs run at once.
struct Gate {
    permits: Mutex<usize>,
    cv: Condvar,
}

struct Permit(Arc<Gate>);

impl Drop for Permit {
    fn drop(&mut self) {
        *self.0.permits.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

impl Gate {
    /// Waits for a permit, giving up early if the job is cancelled meanwhile.
    fn acquire(self: &Arc<Self>, cancel: &CancelToken) -> Option<Permit> {
        let mut permits = self.permits.lock().unwrap();
        loop {
            if cancel.is_cancelled() {
                return None;
            }
            if *permits > 0 {
                *permits -= 1;
                return Some(Permit(self.clone()));
            }
            permits = self.cv.wait_timeout(permits, Duration::from_millis(100)).unwrap().0;
        }
    }
}

pub struct JobManager {
    jobs: Mutex<HashMap<JobId, JobContext>>,
    gate: Arc<Gate>,
    registry: Arc<Registry>,
}

impl JobManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self::with_registry(max_concurrent, engine::global().clone())
    }

    /// A manager that runs jobs on the given engines (tests inject fakes).
    pub fn with_registry(max_concurrent: usize, registry: Arc<Registry>) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            gate: Arc::new(Gate { permits: Mutex::new(max_concurrent.max(1)), cv: Condvar::new() }),
            registry,
        }
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    /// Validate and queue a job. `on_update` is called (from the worker thread)
    /// on every state change and, at a throttled rate, on progress.
    pub fn start(
        &self,
        request: JobRequest,
        on_update: impl Fn(&JobStatus) + Send + Sync + 'static,
    ) -> Result<JobId> {
        request::validate_with(&self.registry, &request)?;
        let id = uuid::Uuid::new_v4().to_string();
        let ctx = JobContext::new(id.clone(), request.operation.name(), CancelToken::default(), on_update);
        self.jobs.lock().unwrap().insert(id.clone(), ctx.clone());
        ctx.set_state(JobState::Queued);

        let gate = self.gate.clone();
        let registry = self.registry.clone();
        std::thread::Builder::new()
            .name(format!("job-{id}"))
            .spawn(move || {
                let Some(_permit) = gate.acquire(&ctx.cancel_token()) else {
                    ctx.finish(Err(Error::Cancelled));
                    return;
                };
                ctx.set_state(JobState::Running);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    request::run_with(&registry, &request, &ctx)
                }))
                .unwrap_or_else(|_| Err(Error::InvalidRequest("Something went wrong inside the app.".into())));
                ctx.finish(result);
            })?;
        Ok(id)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        match self.jobs.lock().unwrap().get(id) {
            Some(ctx) => {
                ctx.cancel_token().cancel();
                Ok(())
            }
            None => Err(Error::InvalidRequest("Unknown job.".into())),
        }
    }

    pub fn get(&self, id: &str) -> Option<JobStatus> {
        self.jobs.lock().unwrap().get(id).map(|c| c.snapshot())
    }

    pub fn list(&self) -> Vec<JobStatus> {
        self.jobs.lock().unwrap().values().map(|c| c.snapshot()).collect()
    }

    /// Forget one finished job. Returns false if it is unknown or still active.
    pub fn remove(&self, id: &str) -> bool {
        let mut jobs = self.jobs.lock().unwrap();
        match jobs.get(id) {
            Some(c) if c.snapshot().status.is_finished() => jobs.remove(id).is_some(),
            _ => false,
        }
    }

    /// Drop finished jobs from memory (history clearing).
    pub fn clear_finished(&self) {
        self.jobs.lock().unwrap().retain(|_, c| !c.snapshot().status.is_finished());
    }
}
