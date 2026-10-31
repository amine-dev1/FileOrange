//! The app side of the PDF engine: finds the PDFium library, starts workers, enforces
//! timeouts and turns worker replies into typed results.

use super::sandbox;
use super::annotate::Annotation;
use super::worker::{AssembleInput, ImagesLayout, PageRef, Reply, Request, WORKER_FLAG};
use super::{PdfInfo, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH};
use crate::engine::Availability;
use crate::error::{Error, Result};
use crate::job::CancelToken;
use crate::request::Secret;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// Largest reply a worker may send (a page list for a very long document).
const MAX_REPLY_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub enum WorkerProgram {
    /// This executable, re-run with `--pdf-worker`. The desktop app and `file-api` handle that flag first thing.
    CurrentExe,
    /// Another executable that runs [`super::worker::main`] (`of-pdf-worker`, or `file-api`, which also understands the flag).
    Exe(PathBuf),
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub worker: WorkerProgram,
    /// Folders searched, in order, for the PDFium library.
    pub library_dirs: Vec<PathBuf>,
    pub timeout: Duration,
    /// Building a new PDF from many pages can legitimately take much longer than reading one.
    pub assemble_timeout: Duration,
    pub memory_limit_bytes: u64,
    /// Workers allowed to run at once.
    pub max_workers: usize,
}

const PLATFORM_LIBRARY: &str = if cfg!(windows) {
    "pdfium.dll"
} else if cfg!(target_os = "macos") {
    "libpdfium.dylib"
} else {
    "libpdfium.so"
};

impl HostConfig {
    /// Defaults for the desktop app: re-run this executable, look beside it for PDFium.
    pub fn for_app() -> Self {
        let mut dirs = Vec::new();
        if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            dirs.push(dir.join("pdfium"));
            dirs.push(dir.join("resources").join("pdfium"));
            dirs.push(dir);
        }
        // A developer override, honoured only in debug builds so that a release build never
        // loads a library somebody pointed it at through the environment.
        if cfg!(debug_assertions) {
            if let Some(p) = std::env::var_os("ORANGEFILE_PDFIUM").map(PathBuf::from) {
                dirs.insert(0, if p.is_dir() { p } else { p.parent().map(Path::to_path_buf).unwrap_or_default() });
            }
        }
        Self {
            worker: WorkerProgram::CurrentExe,
            library_dirs: dirs,
            timeout: Duration::from_secs(60),
            assemble_timeout: Duration::from_secs(15 * 60),
            memory_limit_bytes: 2 * 1024 * 1024 * 1024,
            max_workers: 3,
        }
    }

    /// Searches `dir` first (the installer's resource folder, known to the embedding app).
    pub fn with_library_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.library_dirs.insert(0, dir.into());
        self
    }

    pub fn with_worker(mut self, worker: WorkerProgram) -> Self {
        self.worker = worker;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rendered {
    pub width: u32,
    pub height: u32,
}

enum Probe {
    Unknown,
    Ready(PathBuf),
    Failed { reason: String, at: Instant },
}

struct Permits {
    free: Mutex<usize>,
    cv: Condvar,
}

struct Permit<'a>(&'a Permits);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.free.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

/// One source for [`PdfHost::assemble`].
pub struct AssembleSource<'a> {
    pub file: &'a Path,
    pub password: Option<&'a Secret>,
}

/// Why an assemble call failed, and which source (by position) it was about, when that is known.
#[derive(Debug)]
pub struct AssembleError {
    pub input: Option<usize>,
    pub error: Error,
}

pub struct PdfHost {
    cfg: HostConfig,
    probe: Mutex<Probe>,
    permits: Permits,
}

impl PdfHost {
    pub fn new(cfg: HostConfig) -> Self {
        let n = cfg.max_workers.max(1);
        Self { cfg, probe: Mutex::new(Probe::Unknown), permits: Permits { free: Mutex::new(n), cv: Condvar::new() } }
    }

    /// Where PDFium is, without loading it.
    fn find_library(&self) -> std::result::Result<PathBuf, String> {
        self.cfg
            .library_dirs
            .iter()
            .map(|d| d.join(PLATFORM_LIBRARY))
            .find(|p| p.is_file())
            .ok_or_else(|| format!("The PDF engine file ({PLATFORM_LIBRARY}) is missing from this installation. Reinstalling OrangeFile restores it."))
    }

    /// Can PDFs be opened? The library is test-loaded once in a worker; a failure is retried after a while.
    pub fn availability(&self) -> Availability {
        match self.ensure_ready() {
            Ok(_) => Availability::Bundled,
            Err(reason) => Availability::Unavailable { reason },
        }
    }

    fn ensure_ready(&self) -> std::result::Result<PathBuf, String> {
        let mut state = self.probe.lock().unwrap();
        match &*state {
            Probe::Ready(p) => return Ok(p.clone()),
            Probe::Failed { reason, at } if at.elapsed() < Duration::from_secs(5) => return Err(reason.clone()),
            _ => {}
        }
        let lib = match self.find_library() {
            Ok(l) => l,
            Err(reason) => {
                *state = Probe::Failed { reason: reason.clone(), at: Instant::now() };
                return Err(reason);
            }
        };
        match self.call(&Request::Probe { library: lib.clone() }, Duration::from_secs(20), None) {
            Ok(_) => {
                *state = Probe::Ready(lib.clone());
                Ok(lib)
            }
            Err(e) => {
                let reason = format!("PDFium couldn't be started ({}).", e.user_message());
                *state = Probe::Failed { reason: reason.clone(), at: Instant::now() };
                Err(reason)
            }
        }
    }

    /// PDFium build recorded next to the library by the packaging script, if any.
    pub fn version(&self) -> String {
        self.find_library()
            .ok()
            .and_then(|l| std::fs::read_to_string(l.with_file_name("VERSION")).ok())
            .map(|s| s.lines().next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".into())
    }

    fn library(&self) -> Result<PathBuf> {
        self.ensure_ready().map_err(|reason| Error::EngineUnavailable { engine: "PDF tools (PDFium)".into(), reason })
    }

    /// Open a PDF and describe it.
    pub fn info(&self, file: &Path, password: Option<&Secret>) -> Result<PdfInfo> {
        let req = Request::Info { library: self.library()?, file: file.to_path_buf(), password: password.map(|p| p.expose().to_string()) };
        let data = self.call(&req, self.cfg.timeout, None)?;
        serde_json::from_value(data).map_err(|_| Error::PdfWorker("the worker's description of the PDF was malformed".into()))
    }

    /// Draw one page (0-based) as a PNG at `out`, about `width` pixels wide.
    pub fn render(&self, file: &Path, password: Option<&Secret>, page: u32, width: u32, out: &Path) -> Result<Rendered> {
        let req = Request::Render {
            library: self.library()?,
            file: file.to_path_buf(),
            password: password.map(|p| p.expose().to_string()),
            page,
            width: width.clamp(MIN_RENDER_WIDTH, MAX_RENDER_WIDTH),
            out: out.to_path_buf(),
        };
        let data = self.call(&req, self.cfg.timeout, None).map_err(|e| match e {
            Error::PageOutOfRange { .. } => Error::PageOutOfRange { page: page + 1 },
            other => other,
        })?;
        #[derive(serde::Deserialize)]
        struct R {
            width: u32,
            height: u32,
        }
        let r: R = serde_json::from_value(data).map_err(|_| Error::PdfWorker("the worker's reply was malformed".into()))?;
        Ok(Rendered { width: r.width, height: r.height })
    }

    /// Build a new PDF at `out` from `pages` (in order) taken from `sources`. The sources are only read.
    /// Honours `cancel` by stopping the worker. Returns the page count of the result.
    pub fn assemble(
        &self,
        sources: &[AssembleSource],
        pages: &[PageRef],
        annotations: &[Annotation],
        images: &[PathBuf],
        out: &Path,
        cancel: Option<&CancelToken>,
    ) -> std::result::Result<u32, AssembleError> {
        let fail = |error| AssembleError { input: None, error };
        let req = Request::Assemble {
            library: self.library().map_err(fail)?,
            inputs: sources
                .iter()
                .map(|s| AssembleInput { file: s.file.to_path_buf(), password: s.password.map(|p| p.expose().to_string()) })
                .collect(),
            pages: pages.to_vec(),
            out: out.to_path_buf(),
            annotations: annotations.to_vec(),
            images: images.to_vec(),
        };
        let data = self
            .call_raw(&req, self.cfg.assemble_timeout, cancel)
            .map_err(|(error, input)| AssembleError { input: input.map(|i| i as usize), error })?;
        #[derive(serde::Deserialize)]
        struct R {
            pages: u32,
        }
        serde_json::from_value::<R>(data).map(|r| r.pages).map_err(|_| fail(Error::PdfWorker("the worker's reply was malformed".into())))
    }

    /// Make a PDF with one page per picture, in order. `AssembleError::input` says which picture was the problem.
    pub fn images_to_pdf(&self, images: &[PathBuf], layout: ImagesLayout, out: &Path, cancel: Option<&CancelToken>) -> std::result::Result<u32, AssembleError> {
        let req = Request::ImagesToPdf { library: self.library().map_err(|error| AssembleError { input: None, error })?, images: images.to_vec(), layout, out: out.to_path_buf() };
        let data = self.call_raw(&req, self.cfg.assemble_timeout, cancel).map_err(|(error, input)| AssembleError { input: input.map(|i| i as usize), error })?;
        #[derive(serde::Deserialize)]
        struct R {
            pages: u32,
        }
        serde_json::from_value::<R>(data).map(|r| r.pages).map_err(|_| AssembleError { input: None, error: Error::PdfWorker("the worker's reply was malformed".into()) })
    }

    /// Draw one page (0-based) as a PNG at `out` for saving as a picture, about `width` pixels wide (up to the export limits).
    pub fn export_page(&self, file: &Path, password: Option<&Secret>, page: u32, width: u32, out: &Path, cancel: Option<&CancelToken>) -> Result<Rendered> {
        let req = Request::Export { library: self.library()?, file: file.to_path_buf(), password: password.map(|p| p.expose().to_string()), page, width, out: out.to_path_buf() };
        let data = self.call_raw(&req, self.cfg.assemble_timeout, cancel).map_err(|(e, _)| match e {
            Error::PageOutOfRange { .. } => Error::PageOutOfRange { page: page + 1 },
            other => other,
        })?;
        #[derive(serde::Deserialize)]
        struct R {
            width: u32,
            height: u32,
        }
        let r: R = serde_json::from_value(data).map_err(|_| Error::PdfWorker("the worker's reply was malformed".into()))?;
        Ok(Rendered { width: r.width, height: r.height })
    }

    fn acquire(&self) -> Permit<'_> {
        let mut free = self.permits.free.lock().unwrap();
        while *free == 0 {
            free = self.permits.cv.wait(free).unwrap();
        }
        *free -= 1;
        Permit(&self.permits)
    }

    fn command(&self) -> Result<Command> {
        let program = match &self.cfg.worker {
            WorkerProgram::CurrentExe => std::env::current_exe()?,
            WorkerProgram::Exe(p) => p.clone(),
        };
        let mut cmd = Command::new(program);
        // Only the flag, never a file name or password: those go over stdin, and no shell is involved.
        cmd.arg(WORKER_FLAG);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        sandbox::prepare(&mut cmd, self.cfg.memory_limit_bytes);
        Ok(cmd)
    }

    fn call(&self, req: &Request, timeout: Duration, cancel: Option<&CancelToken>) -> Result<serde_json::Value> {
        self.call_raw(req, timeout, cancel).map_err(|(e, _)| e)
    }

    fn call_raw(&self, req: &Request, timeout: Duration, cancel: Option<&CancelToken>) -> std::result::Result<serde_json::Value, (Error, Option<u32>)> {
        let plain = |e: Error| (e, None);
        let _permit = self.acquire();
        let mut child = self.command().map_err(plain)?.spawn().map_err(|e| plain(Error::PdfWorker(format!("the worker couldn't be started: {e}"))))?;
        let _guard = sandbox::attach(&child, self.cfg.memory_limit_bytes);

        // A password could be in this buffer; it's dropped right after being written.
        let payload = serde_json::to_vec(req).map_err(|e| plain(Error::PdfWorker(e.to_string())))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&payload);
        }
        drop(payload);

        let mut stdout = child.stdout.take().expect("stdout is piped");
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = (&mut stdout).take(MAX_REPLY_BYTES).read_to_end(&mut buf);
            buf
        });

        let deadline = Instant::now() + timeout;
        let status = loop {
            if cancel.is_some_and(|c| c.is_cancelled()) {
                let _ = child.kill();
                let _ = child.wait();
                drop(reader);
                return Err(plain(Error::Cancelled));
            }
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(4)),
                Err(e) => return Err(plain(Error::PdfWorker(format!("waiting for the worker failed: {e}")))),
            }
        };
        let Some(status) = status else {
            // Don't wait for the reader: something the worker started could still hold the pipe.
            drop(reader);
            return Err(plain(Error::PdfWorker("the worker took too long and was stopped".into())));
        };
        let out = reader.join().unwrap_or_default();
        let text = String::from_utf8_lossy(&out);
        let reply: Option<Reply> = text.lines().rev().find(|l| !l.trim().is_empty()).and_then(|l| serde_json::from_str(l).ok());
        match reply {
            Some(Reply::Ok { data }) if status.success() => Ok(data),
            Some(Reply::Err { code, message, input }) => Err((map_error(&code, message), input)),
            _ => Err(plain(Error::PdfWorker(format!("the worker ended without an answer ({status})")))),
        }
    }
}

fn map_error(code: &str, message: String) -> Error {
    match code {
        "password_required" => Error::PasswordRequired,
        "wrong_password" => Error::WrongPassword,
        "corrupt_pdf" => Error::CorruptPdf(message),
        "corrupt_image" => Error::CorruptImage(message),
        "unsupported" => Error::Unsupported(message.trim_end_matches('.').to_string()),
        // "Page 4 doesn't exist." from an assemble call; render's message has no number and is filled in by the caller.
        "page_out_of_range" => Error::PageOutOfRange { page: message.strip_prefix("Page ").and_then(|r| r.split_whitespace().next()).and_then(|n| n.parse().ok()).unwrap_or(0) },
        "invalid_request" => Error::InvalidRequest(message),
        "io" => Error::Io { path: None, source: std::io::Error::other(message) },
        _ => Error::PdfWorker(message),
    }
}
