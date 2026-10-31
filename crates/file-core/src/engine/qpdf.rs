//! Add or remove a PDF password, with qpdf.
//!
//! qpdf (Apache-2.0) is run like LibreOffice: a separate program, started with an argument list (never a shell), with a
//! time limit, killed with everything it started on timeout or cancel, in a private folder per job. Passwords are never
//! put on the command line (other programs on the machine could read it there): they go into an argument file in that
//! private folder, readable only by us, which qpdf reads with `@file` and which is deleted with the folder.
//!
//! qpdf ships beside the app (`qpdf/bin/qpdf[.exe]`) when it is bundled; otherwise an installed qpdf is used and reported
//! as `Installed` (the server image installs it from the system packages).

use super::pdf::sandbox;
use super::{AppliesTo, Availability, Engine, EngineInfo, OperationSpec, OptionKind, OptionSpec};
use crate::error::{Error, IoContext, Result};
use crate::formats::{self, FileDescriptor, FormatInfo};
use crate::fs_safe::{self, Committed};
use crate::job::{CancelToken, FileResult, JobContext};
use crate::request::{JobRequest, Operation, Review, Secret, MAX_CONFLICTS};
use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const OP_PROTECT: &str = "pdf_protect";
pub const OP_UNLOCK: &str = "pdf_unlock";
/// Longest password accepted. qpdf takes more, but nobody types this much and it keeps argument files small.
pub const MAX_PASSWORD_CHARS: usize = 128;

#[derive(Debug, Clone, Deserialize)]
pub struct PdfProtectOptions {
    /// Needed to open the PDF.
    pub password: Secret,
    /// Allowed with the password. Viewers are asked to respect these; they are not a guarantee against determined copying.
    #[serde(default = "yes")]
    pub allow_print: bool,
    #[serde(default = "yes")]
    pub allow_copy: bool,
    #[serde(default = "yes")]
    pub allow_edit: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PdfUnlockOptions {
    /// The current password. Removing protection needs it: this never cracks a password.
    pub password: Secret,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone)]
pub struct QpdfConfig {
    /// Folders that hold a bundled qpdf (they contain `bin/qpdf`).
    pub bundled_dirs: Vec<PathBuf>,
    /// Also look for an installed qpdf when no bundled one is found.
    pub search_installed: bool,
    /// Per file.
    pub timeout: Duration,
}

impl QpdfConfig {
    pub fn for_app() -> Self {
        let mut dirs = Vec::new();
        if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            dirs.push(dir.join("qpdf"));
            dirs.push(dir.join("resources").join("qpdf"));
        }
        Self { bundled_dirs: dirs, search_installed: true, timeout: Duration::from_secs(300) }
    }

    /// For tests: nothing bundled, nothing installed.
    pub fn nothing() -> Self {
        Self { bundled_dirs: vec![], search_installed: false, timeout: Duration::from_secs(300) }
    }
}

const EXE: &str = if cfg!(windows) { "qpdf.exe" } else { "qpdf" };

fn installed_candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = ["/usr/bin/qpdf", "/usr/local/bin/qpdf", "/opt/homebrew/bin/qpdf"].map(PathBuf::from).to_vec();
    if let Some(path) = std::env::var_os("PATH") {
        v.extend(std::env::split_paths(&path).map(|d| d.join(EXE)));
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

pub struct QpdfHost {
    cfg: QpdfConfig,
    probe: Mutex<Probe>,
}

/// How a qpdf run ended, when it ran to the end.
pub enum Outcome {
    Ok,
    /// Exit code 3: written, with warnings (common with slightly damaged files that qpdf repaired).
    Warnings,
    /// The password given doesn't open the file.
    WrongPassword,
    Failed(String),
}

impl QpdfHost {
    pub fn new(cfg: QpdfConfig) -> Self {
        Self { cfg, probe: Mutex::new(Probe::Unknown) }
    }

    fn locate(&self) -> Option<(PathBuf, bool)> {
        for d in &self.cfg.bundled_dirs {
            let p = d.join("bin").join(EXE);
            if p.is_file() {
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
        let reason = match self.locate() {
            None => "qpdf (used to add and remove PDF passwords) was not found.".to_string(),
            Some((exe, bundled)) => match version_of(&exe) {
                Ok(version) => {
                    let f = Found { exe, bundled, version };
                    *state = Probe::Ready(f.clone());
                    return Ok(f);
                }
                Err(e) => format!("qpdf was found but couldn't start ({e})."),
            },
        };
        *state = Probe::Failed { reason: reason.clone(), at: Instant::now() };
        Err(reason)
    }

    pub fn available(&self) -> bool {
        self.ready().is_ok()
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

    /// Run qpdf with these arguments, given through an argument file in `work` (so passwords never appear in a process list).
    pub fn run(&self, args: &[String], work: &Path, cancel: &CancelToken) -> Result<Outcome> {
        let found = self.ready().map_err(|reason| Error::EngineUnavailable { engine: "PDF passwords (qpdf)".into(), reason })?;
        let argfile = work.join("args");
        {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
            let mut f = opts.open(&argfile).at(&argfile)?;
            for a in args {
                // One argument per line; qpdf reads them literally.
                if a.contains('\n') || a.contains('\r') {
                    return Err(Error::InvalidRequest("A password can't contain line breaks.".into()));
                }
                writeln!(f, "{a}").at(&argfile)?;
            }
        }
        let mut cmd = Command::new(&found.exe);
        cmd.arg(format!("@{}", argfile.display())).current_dir(work).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        sandbox::prepare(&mut cmd, 0);
        sandbox::own_group(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| Error::PdfTool(format!("qpdf couldn't be started ({e})")))?;
        let _guard = sandbox::attach(&child, 0);
        let mut stderr = child.stderr.take().expect("piped");
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = std::io::Read::read_to_string(&mut std::io::Read::take(&mut stderr, 16 * 1024), &mut s);
            s
        });
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
                    return Err(Error::PdfTool("it took too long, so it was stopped".into()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(Error::PdfTool(format!("waiting for qpdf failed ({e})"))),
            }
        };
        let _ = fs::remove_file(&argfile);
        let err = reader.join().unwrap_or_default();
        Ok(match status.code() {
            Some(0) => Outcome::Ok,
            Some(3) => Outcome::Warnings,
            _ if err.contains("invalid password") => Outcome::WrongPassword,
            _ => Outcome::Failed(first_line(&err)),
        })
    }
}

fn first_line(s: &str) -> String {
    // qpdf starts its messages with the file path; keep only what it says about the file.
    let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let msg = line.rsplit_once("): ").map(|(_, m)| m).or_else(|| line.split_once(": ").map(|(_, m)| m)).unwrap_or(line);
    msg.chars().take(200).collect()
}

fn version_of(exe: &Path) -> std::result::Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    sandbox::prepare(&mut cmd, 0);
    sandbox::own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let _guard = sandbox::attach(&child, 0);
    let mut out = child.stdout.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                sandbox::kill_tree(&mut child);
                return Err("it didn't answer in time".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let text = reader.join().unwrap_or_default();
    let line = text.lines().find(|l| l.to_lowercase().starts_with("qpdf version")).ok_or("it gave no version")?;
    Ok(line.trim().trim_start_matches("qpdf version").trim().to_string())
}

// ------------------------------------------------------------------ the engine

pub struct QpdfEngine {
    host: Arc<QpdfHost>,
}

impl QpdfEngine {
    pub fn new(host: Arc<QpdfHost>) -> Self {
        Self { host }
    }
    pub fn host(&self) -> &Arc<QpdfHost> {
        &self.host
    }
}

fn display(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub(crate) fn stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).filter(|s| !s.is_empty()).unwrap_or_else(|| "document".into())
}

fn out_name(op: &Operation, input: &Path) -> String {
    match op {
        Operation::PdfProtect(_) => format!("{} (protected).pdf", stem(input)),
        _ => format!("{} (unlocked).pdf", stem(input)),
    }
}

fn check_password(p: &Secret, what: &str) -> Result<()> {
    let n = p.expose().chars().count();
    if n == 0 {
        return Err(Error::InvalidRequest(format!("Enter {what}.")));
    }
    if n > MAX_PASSWORD_CHARS {
        return Err(Error::InvalidRequest(format!("The password can be at most {MAX_PASSWORD_CHARS} characters.")));
    }
    if p.expose().contains(['\n', '\r']) {
        return Err(Error::InvalidRequest("A password can't contain line breaks.".into()));
    }
    Ok(())
}

impl Engine for QpdfEngine {
    fn info(&self) -> EngineInfo {
        EngineInfo {
            id: "qpdf".into(),
            name: "PDF passwords (qpdf)".into(),
            version: self.host.version(),
            availability: self.host.availability(),
            license: "Apache-2.0".into(),
        }
    }

    fn operations(&self) -> Vec<OperationSpec> {
        let pdf = || vec![formats::PDF.to_string()];
        let allow = |id: &str, label: &str| OptionSpec { id: id.into(), label: label.into(), help: None, kind: OptionKind::Bool { default: true }, applies_to: vec![] };
        vec![
            OperationSpec {
                id: OP_PROTECT.into(),
                label: "Add a password to a PDF".into(),
                description: "Protect a PDF with a password (AES-256). Your original is never changed.".into(),
                inputs: pdf(),
                outputs: pdf(),
                pairs: vec![],
                options: vec![
                    OptionSpec { id: "password".into(), label: "Password".into(), help: Some("Needed to open the PDF. It isn't stored anywhere.".into()), kind: OptionKind::Secret, applies_to: vec![] },
                    allow("allow_print", "Allow printing"),
                    allow("allow_copy", "Allow copying text and pictures"),
                    allow("allow_edit", "Allow changes"),
                ],
                interactive: false,
            },
            OperationSpec {
                id: OP_UNLOCK.into(),
                label: "Remove a PDF password".into(),
                description: "Save an unprotected copy of a PDF whose password you know.".into(),
                inputs: pdf(),
                outputs: pdf(),
                pairs: vec![],
                options: vec![OptionSpec {
                    id: "password".into(),
                    label: "Current password".into(),
                    help: Some("You need to know it: this never guesses or cracks a password.".into()),
                    kind: OptionKind::Secret,
                    applies_to: vec![AppliesTo { format: formats::PDF.into(), when: None }],
                }],
                interactive: false,
            },
        ]
    }

    fn formats(&self) -> Vec<FormatInfo> {
        vec![]
    }

    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()> {
        match op {
            Operation::PdfProtect(o) => check_password(&o.password, "a password")?,
            Operation::PdfUnlock(o) => check_password(&o.password, "the current password")?,
            _ => return Err(Error::Unsupported("the qpdf engine does not handle this operation".into())),
        }
        for f in files {
            match f.format.as_deref() {
                Some(formats::PDF) => {}
                Some(_) => return Err(Error::UnsupportedFormat(f.name.clone())),
                None if strict => return Err(Error::UnsupportedFormat(f.name.clone())),
                None => {}
            }
        }
        Ok(())
    }

    fn review(&self, req: &JobRequest) -> Result<Review> {
        let mut r = Review::default();
        for p in &req.inputs {
            r.total_bytes += fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            if formats::detect_file(p) != Some(formats::PDF) {
                r.errors.push(format!("“{}” isn't a PDF.", display(p)));
            }
            let target = req.output_dir.join(out_name(&req.operation, p));
            if fs::symlink_metadata(&target).is_ok() && r.conflicts.len() < MAX_CONFLICTS {
                r.conflicts.push(target);
            }
        }
        if let Operation::PdfProtect(o) = &req.operation {
            if !(o.allow_print && o.allow_copy && o.allow_edit) {
                r.warnings.push("Restrictions on printing, copying and changes are a request to PDF viewers; most respect them, but they can't stop someone determined.".into());
            }
        }
        Ok(r)
    }

    fn run(&self, req: &JobRequest, ctx: &JobContext) -> Result<()> {
        if !matches!(req.operation, Operation::PdfProtect(_) | Operation::PdfUnlock(_)) {
            return Err(Error::Unsupported("the qpdf engine does not handle this operation".into()));
        }
        ctx.set_totals(req.inputs.len() as u64, Some(req.inputs.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum()));
        for input in &req.inputs {
            ctx.check_cancelled()?;
            ctx.begin_file(&display(input));
            let size = fs::metadata(input).map(|m| m.len()).unwrap_or(0);
            match self.one(input, req, ctx) {
                Ok((Committed::Written(p), note)) => {
                    ctx.add_output(p.clone());
                    ctx.add_result(FileResult::done(display(input), p, note));
                }
                Ok((Committed::Skipped, _)) => ctx.add_result(FileResult::skipped(display(input), "A file with this name already exists, so it was skipped.")),
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

impl QpdfEngine {
    fn one(&self, input: &Path, req: &JobRequest, ctx: &JobContext) -> Result<(Committed, Option<String>)> {
        if !fs::metadata(input).at(input)?.is_file() || formats::detect_file(input) != Some(formats::PDF) {
            return Err(Error::UnsupportedFormat(display(input)));
        }
        let desired = req.output_dir.join(out_name(&req.operation, input));
        if fs_safe::resolve_destination(&desired, req.conflict, &req.inputs)? == fs_safe::Resolved::Skip {
            return Ok((Committed::Skipped, None));
        }
        let work = tempfile::Builder::new().prefix(".filetool-qpdf-").tempdir_in(&req.output_dir).at(&req.output_dir)?;
        let local = work.path().join("in.pdf");
        let out = work.path().join("out.pdf");
        fs::copy(input, &local).at(input)?;
        let (args, note) = match &req.operation {
            Operation::PdfProtect(o) => {
                // A different, random owner password: whoever opens the file with the user password can't lift the restrictions.
                let owner = if o.allow_print && o.allow_copy && o.allow_edit { o.password.expose().to_string() } else { uuid::Uuid::new_v4().simple().to_string() };
                let yn = |b: bool| if b { "y" } else { "n" };
                let mut a = vec![
                    "in.pdf".to_string(),
                    "--encrypt".into(),
                    format!("--user-password={}", o.password.expose()),
                    format!("--owner-password={owner}"),
                    "--bits=256".into(),
                    format!("--print={}", if o.allow_print { "full" } else { "none" }),
                    format!("--extract={}", yn(o.allow_copy)),
                    format!("--modify={}", if o.allow_edit { "all" } else { "none" }),
                    "--".into(),
                    "out.pdf".into(),
                ];
                // An already-protected input must be opened first; the same password is tried.
                a.insert(1, format!("--password={}", o.password.expose()));
                (a, None)
            }
            Operation::PdfUnlock(o) => (vec![format!("--password={}", o.password.expose()), "--decrypt".into(), "in.pdf".into(), "out.pdf".into()], None),
            _ => unreachable!(),
        };
        let unlocking = matches!(req.operation, Operation::PdfUnlock(_));
        if unlocking && !is_encrypted(&local) {
            return Err(Error::InvalidRequest("This PDF has no password, so there's nothing to remove.".into()));
        }
        match self.host.run(&args, work.path(), &ctx.cancel_token())? {
            Outcome::Ok | Outcome::Warnings => {}
            Outcome::WrongPassword if unlocking => return Err(Error::WrongPassword),
            Outcome::WrongPassword => return Err(Error::InvalidRequest("This PDF already has a different password. Remove it first with “Remove a PDF password”.".into())),
            Outcome::Failed(why) => return Err(Error::PdfTool(if why.is_empty() { "the file may be damaged".into() } else { why })),
        }
        if !out.is_file() {
            return Err(Error::PdfTool("no file was written".into()));
        }
        let tmp = fs_safe::temp_in(&req.output_dir)?;
        fs::copy(&out, tmp.path()).at(&req.output_dir)?;
        ctx.check_cancelled()?;
        Ok((fs_safe::commit(tmp, &desired, req.conflict, &req.inputs)?, note))
    }
}

/// Does the trailer name an /Encrypt dictionary? Read from the end of the file, where the trailer is.
pub(crate) fn is_encrypted(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else { return false };
    let tail = &bytes[bytes.len().saturating_sub(64 * 1024)..];
    let has = |hay: &[u8]| hay.windows(8).any(|w| w == b"/Encrypt");
    // Cross-reference streams keep the trailer keys in the last objects; old-style trailers are at the very end.
    has(tail) || has(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_keep_what_qpdf_says_about_the_file() {
        assert_eq!(first_line("/tmp/x/in.pdf (offset 12): invalid password\n"), "invalid password");
        assert_eq!(first_line("qpdf: in.pdf: not a PDF file\n"), "in.pdf: not a PDF file");
        assert_eq!(first_line(""), "");
    }

    #[test]
    fn passwords_are_checked() {
        assert!(check_password(&Secret::new(""), "a password").is_err());
        assert!(check_password(&Secret::new("a\nb"), "a password").is_err());
        assert!(check_password(&Secret::new("x".repeat(129)), "a password").is_err());
        assert!(check_password(&Secret::new("Ünïcode ok 123"), "a password").is_ok());
    }
}
