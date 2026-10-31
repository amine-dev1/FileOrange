//! Word, Excel and PowerPoint (and OpenDocument) to PDF, by running LibreOffice without a window.
//!
//! LibreOffice is a large program that opens untrusted documents, so it is run like the PDF worker: a separate
//! process, started with an argument list (never a shell), with a time limit, killed (with everything it started)
//! on timeout or cancel, in a private profile and a private folder per job. The document is copied into that
//! folder under a plain name first, so nothing is written next to the original and odd file names can't confuse it.
//! The profile switches macros off and link updating off. The result is moved into place with `fs_safe::commit`.
//!
//! LibreOffice ships in the installer (`libreoffice/` beside the app, put there by `scripts/get-libreoffice.mjs`).
//! If that folder is missing, an installed LibreOffice is used as a fallback and reported as `Installed`.

use super::pdf::sandbox;
use super::{Availability, Engine, EngineInfo, OperationSpec};
use crate::error::{Error, IoContext, Result};
use crate::formats::{self, FileDescriptor, FormatInfo};
use crate::fs_safe::{self, Committed};
use crate::job::{CancelToken, FileResult, JobContext};
use crate::request::{JobRequest, Operation, Review, MAX_CONFLICTS};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const OP: &str = "office_to_pdf";
/// Largest document converted.
pub const MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;

/// No options yet: one PDF per document, named after it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OfficeToPdfOptions {}

#[derive(Debug, Clone)]
pub struct OfficeConfig {
    /// Folders that hold a bundled LibreOffice (they contain `program/soffice`).
    pub bundled_dirs: Vec<PathBuf>,
    /// Also look for an installed LibreOffice when no bundled one is found.
    pub search_installed: bool,
    /// Per document.
    pub timeout: Duration,
}

impl OfficeConfig {
    pub fn for_app() -> Self {
        let mut dirs = Vec::new();
        if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            dirs.push(dir.join("libreoffice"));
            dirs.push(dir.join("resources").join("libreoffice"));
        }
        // A developer override, honoured only in debug builds (like ORANGEFILE_PDFIUM).
        if cfg!(debug_assertions) {
            if let Some(p) = std::env::var_os("ORANGEFILE_LIBREOFFICE").map(PathBuf::from) {
                dirs.insert(0, p);
            }
        }
        Self { bundled_dirs: dirs, search_installed: true, timeout: Duration::from_secs(300) }
    }

    pub fn with_bundled_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.bundled_dirs.insert(0, dir.into());
        self
    }

    /// For tests: nothing bundled, nothing installed.
    pub fn nothing() -> Self {
        Self { bundled_dirs: vec![], search_installed: false, timeout: Duration::from_secs(300) }
    }
}

const SOFFICE: &str = if cfg!(windows) { "soffice.exe" } else { "soffice" };

fn candidates_in(dir: &Path) -> [PathBuf; 2] {
    [dir.join("program").join(SOFFICE), dir.join(SOFFICE)]
}

fn installed_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(base) = std::env::var_os(var) {
                v.push(PathBuf::from(base).join("LibreOffice").join("program").join(SOFFICE));
            }
        }
    } else if cfg!(target_os = "macos") {
        v.push("/Applications/LibreOffice.app/Contents/MacOS/soffice".into());
    } else {
        v.extend(["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice"].map(PathBuf::from));
    }
    v
}

#[derive(Clone)]
struct Found {
    exe: PathBuf,
    bundled: bool,
    version: String,
}

enum Probe {
    Unknown,
    Ready(Found),
    Failed { reason: String, at: Instant },
}

pub struct OfficeHost {
    cfg: OfficeConfig,
    probe: Mutex<Probe>,
}

impl OfficeHost {
    pub fn new(cfg: OfficeConfig) -> Self {
        Self { cfg, probe: Mutex::new(Probe::Unknown) }
    }

    fn locate(&self) -> Option<(PathBuf, bool)> {
        for d in &self.cfg.bundled_dirs {
            if let Some(p) = candidates_in(d).into_iter().find(|p| p.is_file()) {
                return Some((p, true));
            }
        }
        if self.cfg.search_installed {
            return installed_candidates().into_iter().find(|p| p.is_file()).map(|p| (p, false));
        }
        None
    }

    fn ready(&self) -> std::result::Result<Found, String> {
        let mut state = self.probe.lock().unwrap();
        match &*state {
            Probe::Ready(f) => return Ok(f.clone()),
            Probe::Failed { reason, at } if at.elapsed() < Duration::from_secs(10) => return Err(reason.clone()),
            _ => {}
        }
        let fail = |state: &mut Probe, reason: String| {
            *state = Probe::Failed { reason: reason.clone(), at: Instant::now() };
            Err(reason)
        };
        let Some((exe, bundled)) = self.locate() else {
            return fail(
                &mut state,
                if cfg!(windows) {
                    "LibreOffice (used to convert Word, Excel and PowerPoint files) is missing from this installation. Reinstalling OrangeFile restores it.".into()
                } else {
                    "LibreOffice (used to convert Word, Excel and PowerPoint files) was not found.".into()
                },
            );
        };
        match run_version(&exe) {
            Ok(version) => {
                let f = Found { exe, bundled, version };
                *state = Probe::Ready(f.clone());
                Ok(f)
            }
            Err(e) => fail(&mut state, format!("LibreOffice was found but couldn't start ({e}).")),
        }
    }

    pub fn availability(&self) -> Availability {
        match self.ready() {
            Ok(f) if f.bundled => Availability::Bundled,
            Ok(_) => Availability::Installed,
            Err(reason) => Availability::Unavailable { reason },
        }
    }

    pub fn version(&self) -> String {
        self.ready().map(|f| f.version).unwrap_or_else(|_| "not installed".into())
    }

    /// Convert one document to a PDF. Returns the path of the PDF, inside `work` (a private folder the caller removes).
    fn convert(&self, input: &Path, kind: &str, work: &Path, cancel: &CancelToken) -> Result<PathBuf> {
        let found = self.ready().map_err(|reason| Error::EngineUnavailable { engine: "Office documents (LibreOffice)".into(), reason })?;
        let profile = work.join("profile");
        let out = work.join("out");
        fs::create_dir_all(profile.join("user")).at(&profile)?;
        fs::create_dir_all(&out).at(&out)?;
        fs::write(profile.join("user").join("registrymodifications.xcu"), PROFILE_XCU).at(&profile)?;
        // A plain name, in a folder only we use.
        let local = work.join(format!("document.{kind}"));
        fs::copy(input, &local).at(input)?;

        let mut cmd = Command::new(&found.exe);
        cmd.args(["--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo", "--nofirststartwizard"])
            .arg(format!("-env:UserInstallation={}", file_url(&profile)))
            .args(["--convert-to", "pdf", "--outdir"])
            .arg(&out)
            .arg(&local)
            .current_dir(work)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        sandbox::prepare(&mut cmd, 0);
        sandbox::own_group(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| Error::OfficeConversion(format!("LibreOffice couldn't be started ({e})")))?;
        let _guard = sandbox::attach(&child, 0);

        let deadline = Instant::now() + self.cfg.timeout;
        let status = loop {
            if cancel.is_cancelled() {
                sandbox::kill_tree(&mut child);
                return Err(Error::Cancelled);
            }
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if Instant::now() >= deadline => {
                    sandbox::kill_tree(&mut child);
                    return Err(Error::OfficeConversion("it took too long, so it was stopped".into()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => return Err(Error::OfficeConversion(format!("waiting for LibreOffice failed ({e})"))),
            }
        };
        let pdf = out.join("document.pdf");
        if !status.success() || !pdf.is_file() {
            return Err(Error::OfficeConversion("it may be damaged, password-protected or too complex".into()));
        }
        Ok(pdf)
    }
}

/// Settings written into the private profile before every run: macros off, links not updated.
const PROFILE_XCU: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
</oor:items>
"#;

/// `file:///C:/some%20dir/profile` (Windows) or `file:///tmp/profile` (elsewhere).
fn file_url(p: &Path) -> String {
    let raw = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !raw.starts_with('/') {
        out.push('/');
    }
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn run_version(exe: &Path) -> std::result::Result<String, String> {
    // On Windows soffice.com is the console launcher that answers `--version`; soffice.exe is the window program and may not.
    let com = exe.with_extension("com");
    let exe: &Path = if cfg!(windows) && com.is_file() { &com } else { exe };
    let mut cmd = Command::new(exe);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    sandbox::prepare(&mut cmd, 0);
    sandbox::own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let _guard = sandbox::attach(&child, 0);
    let mut stdout = child.stdout.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                sandbox::kill_tree(&mut child);
                return Err("it didn't answer in time".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let text = reader.join().unwrap_or_default();
    let line = text.lines().find(|l| l.to_lowercase().contains("libreoffice")).ok_or("it gave no version")?;
    Ok(line.trim().to_string())
}

// ------------------------------------------------------------------ the engine

pub struct OfficeEngine {
    host: Arc<OfficeHost>,
}

impl OfficeEngine {
    pub fn new(host: Arc<OfficeHost>) -> Self {
        Self { host }
    }

    pub fn host(&self) -> &Arc<OfficeHost> {
        &self.host
    }
}

const INPUTS: [&str; 10] = [
    formats::DOCX,
    formats::DOC,
    formats::ODT,
    formats::RTF,
    formats::XLSX,
    formats::XLS,
    formats::ODS,
    formats::PPTX,
    formats::PPT,
    formats::ODP,
];

fn out_name(input: &Path) -> String {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).filter(|s| !s.is_empty()).unwrap_or_else(|| "document".into());
    format!("{stem}.pdf")
}

fn display(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

impl Engine for OfficeEngine {
    fn info(&self) -> EngineInfo {
        EngineInfo {
            id: "office".into(),
            name: "Office documents (LibreOffice)".into(),
            version: self.host.version(),
            availability: self.host.availability(),
            license: "MPL-2.0 (and the licences of the libraries inside LibreOffice)".into(),
        }
    }

    fn operations(&self) -> Vec<OperationSpec> {
        vec![OperationSpec {
            id: OP.into(),
            label: "Word, Excel and PowerPoint to PDF".into(),
            description: "Turn documents into PDFs. Layout and fonts can differ slightly from Microsoft Office, because LibreOffice draws them.".into(),
            inputs: INPUTS.iter().map(|s| s.to_string()).collect(),
            outputs: vec![formats::PDF.into()],
            pairs: vec![],
            options: vec![],
            interactive: false,
        }]
    }

    fn formats(&self) -> Vec<FormatInfo> {
        formats::office_formats()
    }

    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()> {
        let Operation::OfficeToPdf(_) = op else {
            return Err(Error::Unsupported("the Office engine does not handle this operation".into()));
        };
        for f in files {
            // From the first bytes alone a .docx is just a ZIP and a .doc just a compound file; the job looks inside.
            match f.format.as_deref() {
                Some(formats::ZIP | formats::OLE2 | formats::RTF) => {}
                Some(_) => return Err(Error::UnsupportedFormat(f.name.clone())),
                None if strict => return Err(Error::UnsupportedFormat(f.name.clone())),
                None => {}
            }
            if f.size > MAX_INPUT_BYTES {
                return Err(Error::InvalidRequest(format!("“{}” is larger than the 1 GB this can convert.", f.name)));
            }
        }
        Ok(())
    }

    fn review(&self, req: &JobRequest) -> Result<Review> {
        let mut r = Review::default();
        for p in &req.inputs {
            r.total_bytes += fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            if formats::detect_office_file(p).is_none() {
                r.errors.push(format!("“{}” isn't a Word, Excel, PowerPoint or OpenDocument file.", display(p)));
            }
            let target = req.output_dir.join(out_name(p));
            if fs::symlink_metadata(&target).is_ok() && r.conflicts.len() < MAX_CONFLICTS {
                r.conflicts.push(target);
            }
        }
        r.warnings.push("The PDF is drawn by LibreOffice, so fonts, spacing and page breaks can differ from how Microsoft Office shows the document. Macros are never run.".into());
        Ok(r)
    }

    fn run(&self, req: &JobRequest, ctx: &JobContext) -> Result<()> {
        if !matches!(req.operation, Operation::OfficeToPdf(_)) {
            return Err(Error::Unsupported("the Office engine does not handle this operation".into()));
        }
        ctx.set_totals(req.inputs.len() as u64, Some(req.inputs.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum()));
        for input in &req.inputs {
            ctx.check_cancelled()?;
            let name = out_name(input);
            ctx.begin_file(&display(input));
            let size = fs::metadata(input).map(|m| m.len()).unwrap_or(0);
            match self.convert_one(input, &name, req, ctx) {
                Ok(Committed::Written(p)) => {
                    ctx.add_output(p.clone());
                    ctx.add_result(FileResult::done(display(input), p, None));
                }
                Ok(Committed::Skipped) => ctx.add_result(FileResult::skipped(display(input), "A file with this name already exists, so it was skipped.")),
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(e) => ctx.add_result(FileResult::failed(display(input), &e)),
            }
            ctx.add_bytes(size);
            ctx.file_processed();
        }
        Ok(())
    }

    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }
}

impl OfficeEngine {
    fn convert_one(&self, input: &Path, name: &str, req: &JobRequest, ctx: &JobContext) -> Result<Committed> {
        let meta = fs::metadata(input).at(input)?;
        if !meta.is_file() {
            return Err(Error::InvalidRequest("Choose a document, not a folder.".into()));
        }
        if meta.len() > MAX_INPUT_BYTES {
            return Err(Error::InvalidRequest("This document is larger than the 1 GB that can be converted.".into()));
        }
        let kind = formats::detect_office_file(input).ok_or_else(|| Error::UnsupportedFormat(display(input)))?;
        let desired = req.output_dir.join(name);
        if fs_safe::resolve_destination(&desired, req.conflict, &req.inputs)? == fs_safe::Resolved::Skip {
            return Ok(Committed::Skipped);
        }
        // Private working folder next to the output (same volume), removed whatever happens.
        let work = tempfile::Builder::new().prefix(".filetool-office-").tempdir_in(&req.output_dir).at(&req.output_dir)?;
        let pdf = self.host.convert(input, kind, work.path(), &ctx.cancel_token())?;
        let tmp = fs_safe::temp_in(&req.output_dir)?;
        fs::copy(&pdf, tmp.path()).at(&req.output_dir)?;
        ctx.check_cancelled()?;
        fs_safe::commit(tmp, &desired, req.conflict, &req.inputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_switches_macros_off() {
        assert!(PROFILE_XCU.contains("DisableMacrosExecution") && PROFILE_XCU.contains("<value>true</value>"));
        assert!(PROFILE_XCU.contains("MacroSecurityLevel") && PROFILE_XCU.contains("<value>3</value>"));
    }

    #[test]
    fn file_urls() {
        assert_eq!(file_url(Path::new("/tmp/my dir/profile")), "file:///tmp/my%20dir/profile");
        assert_eq!(file_url(Path::new(r"C:\Users\Amine Élidrissi\p")), "file:///C:/Users/Amine%20%C3%89lidrissi/p");
    }
}
