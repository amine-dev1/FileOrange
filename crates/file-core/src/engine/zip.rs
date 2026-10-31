//! ZIP engine: list, create, and safely extract.

use crate::error::{Error, IoContext, Result};
use crate::fs_safe::{self, Committed, ConflictPolicy, Resolved};
use crate::job::{FileResult, JobContext};
use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const CHUNK: usize = 256 * 1024;
pub const MAX_ENTRIES: usize = 200_000;
/// Default cap on the total size an archive may expand to.
pub const DEFAULT_MAX_EXTRACT_BYTES: u64 = 20 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------- listing

#[derive(Debug, Clone, Serialize)]
pub struct EntryInfo {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
    pub encrypted: bool,
    pub symlink: bool,
    /// False if extracting this entry would escape the destination folder.
    pub safe: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveListing {
    pub entries: Vec<EntryInfo>,
    pub file_count: u64,
    pub total_uncompressed: u64,
    pub total_compressed: u64,
    pub needs_password: bool,
    pub unsafe_entries: u64,
    /// Extremely high compression ratio on a large archive (possible zip bomb).
    pub suspicious_ratio: bool,
}

fn open_archive(path: &Path) -> Result<ZipArchive<BufReader<File>>> {
    let f = File::open(path).at(path)?;
    ZipArchive::new(BufReader::new(f)).map_err(|e| Error::from(e).at(path))
}

pub fn list(path: &Path) -> Result<ArchiveListing> {
    let mut za = open_archive(path)?;
    if za.len() > MAX_ENTRIES {
        return Err(Error::ExpansionLimit { limit: MAX_ENTRIES as u64 });
    }
    let mut out = ArchiveListing {
        entries: Vec::with_capacity(za.len()),
        file_count: 0,
        total_uncompressed: 0,
        total_compressed: 0,
        needs_password: false,
        unsafe_entries: 0,
        suspicious_ratio: false,
    };
    for i in 0..za.len() {
        let e = za.by_index_raw(i)?;
        let safe = fs_safe::safe_relative_path(e.name()).is_ok();
        let info = EntryInfo {
            name: e.name().to_string(),
            size: e.size(),
            compressed_size: e.compressed_size(),
            is_dir: e.is_dir(),
            encrypted: e.encrypted(),
            symlink: e.is_symlink(),
            safe,
        };
        if !info.is_dir {
            out.file_count += 1;
        }
        out.total_uncompressed = out.total_uncompressed.saturating_add(info.size);
        out.total_compressed = out.total_compressed.saturating_add(info.compressed_size);
        out.needs_password |= info.encrypted;
        out.unsafe_entries += (!safe) as u64;
        out.entries.push(info);
    }
    out.suspicious_ratio = out.total_uncompressed > 256 * 1024 * 1024
        && out.total_uncompressed / out.total_compressed.max(1) > 200;
    Ok(out)
}

// ------------------------------------------------------------- compression

struct Planned {
    path: PathBuf,
    entry_name: String,
    size: u64,
    is_dir: bool,
    modified: Option<SystemTime>,
}

fn walk_err(e: walkdir::Error) -> Error {
    let path = e.path().map(Path::to_path_buf);
    match e.into_io_error() {
        Some(io) => {
            let err = Error::from(io);
            match path {
                Some(p) => err.at(&p),
                None => err,
            }
        }
        None => Error::InvalidRequest("A folder contains a loop and can't be compressed.".into()),
    }
}

fn unique_name(taken: &mut HashSet<String>, name: &str) -> String {
    let mut candidate = name.to_string();
    let mut n = 1;
    while !taken.insert(candidate.to_lowercase()) {
        candidate = match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({n}).{ext}"),
            _ => format!("{name} ({n})"),
        };
        n += 1;
    }
    candidate
}

fn plan(inputs: &[PathBuf], include_folders: bool) -> Result<Vec<Planned>> {
    let mut taken = HashSet::new();
    let mut out = Vec::new();
    for input in inputs {
        let meta = fs::metadata(input).at(input)?;
        let base = input
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::InvalidRequest("Pick a file or folder, not a drive.".into()))?;
        let top = unique_name(&mut taken, &base);
        if meta.is_file() {
            out.push(Planned {
                path: input.clone(),
                entry_name: top,
                size: meta.len(),
                is_dir: false,
                modified: meta.modified().ok(),
            });
        } else if meta.is_dir() {
            if !include_folders {
                return Err(Error::InvalidRequest(format!(
                    "“{base}” is a folder. Turn on “Include folders” to add it."
                )));
            }
            for entry in WalkDir::new(input).follow_links(false).sort_by_file_name() {
                let entry = entry.map_err(walk_err)?;
                let rel = entry.path().strip_prefix(input).unwrap_or(entry.path());
                let name = std::iter::once(top.clone())
                    .chain(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()))
                    .collect::<Vec<_>>()
                    .join("/");
                let ft = entry.file_type();
                if ft.is_dir() {
                    out.push(Planned { path: entry.path().to_path_buf(), entry_name: name, size: 0, is_dir: true, modified: None });
                } else if ft.is_file() {
                    let meta = entry.metadata().map_err(walk_err)?;
                    out.push(Planned {
                        path: entry.path().to_path_buf(),
                        entry_name: name,
                        size: meta.len(),
                        is_dir: false,
                        modified: meta.modified().ok(),
                    });
                } // symlinks and special files are not followed or stored
            }
        } else {
            return Err(Error::InvalidRequest(format!("“{base}” can't be compressed.")));
        }
    }
    Ok(out)
}

fn zip_time(t: Option<SystemTime>) -> Option<zip::DateTime> {
    zip::DateTime::try_from(time::OffsetDateTime::from(t?)).ok()
}

/// Where the archive for these inputs will be written (before conflict handling).
pub fn archive_path(inputs: &[PathBuf], output_dir: &Path, name: Option<&str>) -> Result<PathBuf> {
    let mut file = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => fs_safe::safe_file_name(n)?,
        None if inputs.len() == 1 => inputs[0]
            .file_stem()
            .or(inputs[0].file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "archive".into()),
        None => "archive".into(),
    };
    if !file.to_lowercase().ends_with(".zip") {
        file.push_str(".zip");
    }
    Ok(output_dir.join(file))
}

pub fn compress(
    inputs: &[PathBuf],
    output_dir: &Path,
    archive_name: Option<&str>,
    include_folders: bool,
    policy: ConflictPolicy,
    ctx: &JobContext,
) -> Result<()> {
    let desired = archive_path(inputs, output_dir, archive_name)?;
    let protected: Vec<PathBuf> = inputs.iter().filter_map(|p| p.canonicalize().ok()).collect();
    let display = desired.file_name().unwrap().to_string_lossy().into_owned();

    if fs_safe::resolve_destination(&desired, policy, &protected)? == Resolved::Skip {
        ctx.add_result(FileResult::skipped(display, "A file with this name already exists, so it was skipped."));
        return Ok(());
    }

    let planned = plan(inputs, include_folders)?;
    ctx.set_totals(
        planned.iter().filter(|p| !p.is_dir).count() as u64,
        Some(planned.iter().map(|p| p.size).sum()),
    );

    let tmp = fs_safe::temp_in(output_dir)?;
    let tmp_canon = tmp.path().canonicalize().ok();
    {
        // `&File` is Write + Seek, so the temp file stays owned here and is
        // deleted automatically if anything below returns early.
        let mut zw = ZipWriter::new(tmp.as_file());
        let mut buf = vec![0u8; CHUNK];
        for p in &planned {
            ctx.check_cancelled()?;
            let mut opts = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(if p.is_dir { 0o755 } else { 0o644 });
            if let Some(t) = zip_time(p.modified) {
                opts = opts.last_modified_time(t);
            }
            if p.is_dir {
                zw.add_directory(format!("{}/", p.entry_name), opts)?;
                continue;
            }
            // Never put the archive we're writing inside itself.
            if p.path.file_name() == tmp.path().file_name()
                && p.path.canonicalize().ok() == tmp_canon
            {
                continue;
            }
            ctx.begin_file(&p.entry_name);
            let mut src = File::open(&p.path).at(&p.path)?;
            zw.start_file(p.entry_name.clone(), opts.large_file(p.size >= u32::MAX as u64))?;
            loop {
                ctx.check_cancelled()?;
                let n = src.read(&mut buf).at(&p.path)?;
                if n == 0 {
                    break;
                }
                zw.write_all(&buf[..n]).at(output_dir)?;
                ctx.add_bytes(n as u64);
            }
            ctx.file_processed();
        }
        zw.finish()?;
    }
    ctx.check_cancelled()?;
    match fs_safe::commit(tmp, &desired, policy, &protected)? {
        Committed::Written(path) => {
            ctx.add_output(path.clone());
            ctx.add_result(FileResult::done(display, path, None));
        }
        Committed::Skipped => {
            ctx.add_result(FileResult::skipped(display, "A file with this name already exists, so it was skipped."));
        }
    }
    Ok(())
}

// -------------------------------------------------------------- extraction

pub struct ExtractParams<'a> {
    pub archive: &'a Path,
    pub output_dir: &'a Path,
    pub subfolder: bool,
    pub policy: ConflictPolicy,
    pub password: Option<&'a str>,
    pub max_total_bytes: u64,
}

/// The folder an archive will be extracted into (before it is created).
pub fn extract_root(archive: &Path, output_dir: &Path, subfolder: bool, policy: ConflictPolicy) -> PathBuf {
    if !subfolder {
        return output_dir.to_path_buf();
    }
    let stem = archive
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| fs_safe::safe_file_name(s).is_ok())
        .unwrap_or_else(|| "extracted".into());
    let desired = output_dir.join(stem);
    match policy {
        ConflictPolicy::Rename if fs::symlink_metadata(&desired).is_ok() => fs_safe::unique_path(&desired),
        _ => desired,
    }
}

pub struct ExtractSummary {
    pub root: PathBuf,
    pub written: u64,
    pub skipped: u64,
}

fn inside(root: &Path, dir: &Path) -> Result<()> {
    let canon = dir.canonicalize().at(dir)?;
    if canon.starts_with(root) {
        Ok(())
    } else {
        Err(Error::UnsafeEntry(dir.display().to_string()))
    }
}

pub fn extract(p: &ExtractParams, ctx: &JobContext) -> Result<ExtractSummary> {
    let mut za = open_archive(p.archive)?;
    if za.len() > MAX_ENTRIES {
        return Err(Error::ExpansionLimit { limit: MAX_ENTRIES as u64 });
    }

    // Validate every entry before writing anything.
    let mut rels: Vec<Option<PathBuf>> = Vec::with_capacity(za.len());
    let mut declared: u64 = 0;
    for i in 0..za.len() {
        let e = za.by_index_raw(i)?;
        let rel = fs_safe::safe_relative_path(e.name())?;
        if e.encrypted() && p.password.is_none() && !e.is_dir() {
            return Err(Error::PasswordRequired);
        }
        declared = declared.saturating_add(e.size());
        rels.push(if e.is_symlink() { None } else { Some(rel) });
    }
    if declared > p.max_total_bytes {
        return Err(Error::ExpansionLimit { limit: p.max_total_bytes });
    }

    let root = extract_root(p.archive, p.output_dir, p.subfolder, p.policy);
    fs::create_dir_all(&root).at(&root)?;
    let root_canon = root.canonicalize().at(&root)?;
    let protected = vec![p.archive.canonicalize().at(p.archive)?];

    let mut written = 0u64;
    let mut skipped = 0u64;
    let mut actual_total = 0u64;
    let mut buf = vec![0u8; CHUNK];

    for (i, rel) in rels.iter().enumerate() {
        ctx.check_cancelled()?;
        let Some(rel) = rel else {
            skipped += 1; // symlinks are never recreated
            ctx.file_processed();
            continue;
        };
        let target = root.join(rel);

        let (is_dir, size, encrypted, modified) = {
            let e = za.by_index_raw(i)?;
            (e.is_dir(), e.size(), e.encrypted(), e.last_modified())
        };

        if is_dir {
            fs::create_dir_all(&target).at(&target)?;
            inside(&root_canon, &target)?;
            continue;
        }

        let parent = target.parent().unwrap_or(&root).to_path_buf();
        fs::create_dir_all(&parent).at(&parent)?;
        inside(&root_canon, &parent)?;

        ctx.begin_file(&rel.to_string_lossy());
        if fs_safe::resolve_destination(&target, p.policy, &protected)? == Resolved::Skip {
            skipped += 1;
            ctx.add_bytes(size);
            ctx.file_processed();
            continue;
        }

        let mut tmp = fs_safe::temp_in(&parent)?;
        {
            let mut entry = match (encrypted, p.password) {
                (true, Some(pw)) => za.by_index_decrypt(i, pw.as_bytes())?,
                _ => za.by_index(i)?,
            };
            let mut out = std::io::BufWriter::new(tmp.as_file_mut());
            loop {
                ctx.check_cancelled()?;
                let n = match entry.read(&mut buf) {
                    Ok(n) => n,
                    Err(e) if encrypted && e.kind() == std::io::ErrorKind::InvalidData => {
                        return Err(Error::WrongPassword)
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                        return Err(Error::CorruptArchive(e.to_string()))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        return Err(Error::CorruptArchive("archive is truncated".into()))
                    }
                    Err(e) => return Err(Error::from(e).at(p.archive)),
                };
                if n == 0 {
                    break;
                }
                // Declared sizes can lie; enforce the cap on bytes really written.
                actual_total += n as u64;
                if actual_total > p.max_total_bytes {
                    return Err(Error::ExpansionLimit { limit: p.max_total_bytes });
                }
                out.write_all(&buf[..n]).at(&parent)?;
                ctx.add_bytes(n as u64);
            }
            out.flush().at(&parent)?;
        }
        if let Some(t) = modified.and_then(|d| time::OffsetDateTime::try_from(d).ok()) {
            let _ = tmp.as_file().set_modified(SystemTime::from(t)); // best effort
        }
        match fs_safe::commit(tmp, &target, p.policy, &protected)? {
            Committed::Written(_) => written += 1,
            Committed::Skipped => skipped += 1,
        }
        ctx.file_processed();
    }
    Ok(ExtractSummary { root, written, skipped })
}

/// Extract a batch of archives. A bad archive is recorded and the rest continue;
/// cancellation stops everything.
pub fn extract_all(
    archives: &[PathBuf],
    output_dir: &Path,
    subfolder: bool,
    policy: ConflictPolicy,
    password: Option<&str>,
    max_total_bytes: u64,
    ctx: &JobContext,
) -> Result<()> {
    let mut files_total = 0u64;
    let mut bytes_total = 0u64;
    for a in archives {
        if let Ok(l) = list(a) {
            files_total += l.entries.iter().filter(|e| !e.is_dir).count() as u64;
            bytes_total = bytes_total.saturating_add(l.total_uncompressed);
        }
    }
    ctx.set_totals(files_total, Some(bytes_total));

    for a in archives {
        ctx.check_cancelled()?;
        let name = a.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let params = ExtractParams { archive: a, output_dir, subfolder, policy, password, max_total_bytes };
        match extract(&params, ctx) {
            Ok(s) => {
                ctx.add_output(s.root.clone());
                let note = (s.skipped > 0).then(|| format!("{} item(s) were skipped (already existed or not extractable).", s.skipped));
                if s.written == 0 && s.skipped > 0 {
                    ctx.add_result(FileResult::skipped(name, note.unwrap_or_default()));
                } else {
                    ctx.add_result(FileResult::done(name, s.root, note));
                }
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(e) => ctx.add_result(FileResult::failed(name, &e)),
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ engine adapter

use crate::engine::{AppliesTo, Availability, Engine, EngineInfo, OperationSpec, OptionKind, OptionSpec};
use crate::formats::{self, FileDescriptor, FormatInfo};
use crate::request::{JobRequest, Operation, Review, MAX_CONFLICTS};

pub struct ZipEngine;

impl Engine for ZipEngine {
    fn info(&self) -> EngineInfo {
        EngineInfo {
            id: "zip".into(),
            name: "ZIP archives".into(),
            version: format!("zip crate {}", env!("FC_VER_ZIP")),
            availability: Availability::Bundled,
            license: "MIT".into(),
        }
    }

    fn formats(&self) -> Vec<FormatInfo> {
        formats::bundled_formats().into_iter().filter(|f| f.id == formats::ZIP).collect()
    }

    fn operations(&self) -> Vec<OperationSpec> {
        let none: Vec<AppliesTo> = vec![];
        vec![
            OperationSpec {
                interactive: false,
                id: "compress".into(),
                label: "Compress to ZIP".into(),
                description: "Pack files and folders into one ZIP archive (Deflate).".into(),
                inputs: vec![],
                outputs: vec![formats::ZIP.into()],
                pairs: vec![],
                options: vec![
                    OptionSpec { id: "archive_name".into(), label: "Archive name".into(), help: Some("Leave blank to name it after your files.".into()), kind: OptionKind::Text { max_len: 120 }, applies_to: none.clone() },
                    OptionSpec { id: "include_folders".into(), label: "Include folders".into(), help: None, kind: OptionKind::Bool { default: true }, applies_to: none.clone() },
                ],
            },
            OperationSpec {
                interactive: false,
                id: "extract".into(),
                label: "Extract ZIP".into(),
                description: "Open ZIP archives into a folder. Unsafe paths are refused and expansion is capped.".into(),
                inputs: vec![formats::ZIP.into()],
                outputs: vec![],
                pairs: vec![],
                options: vec![
                    OptionSpec { id: "password".into(), label: "Password".into(), help: Some("Only needed for encrypted archives. Never stored.".into()), kind: OptionKind::Secret, applies_to: none.clone() },
                    OptionSpec { id: "subfolder".into(), label: "Put files in a folder named after the archive".into(), help: None, kind: OptionKind::Bool { default: true }, applies_to: none },
                ],
            },
        ]
    }

    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()> {
        match op {
            Operation::Compress(o) => {
                if let Some(n) = o.archive_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                    fs_safe::safe_file_name(n)?;
                }
                Ok(())
            }
            Operation::Extract(_) => {
                if strict {
                    for f in files.iter().filter(|f| f.format.as_deref() != Some(formats::ZIP)) {
                        return Err(Error::UnsupportedFormat(f.name.clone()));
                    }
                }
                Ok(())
            }
            _ => Err(Error::Unsupported("the ZIP engine does not handle this operation".into())),
        }
    }

    fn review(&self, req: &JobRequest) -> Result<Review> {
        use std::fs;
        let exists = |p: &Path| fs::symlink_metadata(p).is_ok();
        let mut r = Review::default();
        match &req.operation {
            Operation::Compress(o) => {
                let out = archive_path(&req.inputs, &req.output_dir, o.archive_name.as_deref())?;
                if exists(&out) {
                    r.conflicts.push(out);
                }
                r.total_bytes = req.inputs.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
            }
            Operation::Extract(o) => {
                let limit = o.max_total_bytes.unwrap_or(DEFAULT_MAX_EXTRACT_BYTES);
                for a in &req.inputs {
                    let name = a.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    match list(a) {
                        Err(e) => r.errors.push(format!("{name}: {}", e.user_message())),
                        Ok(l) => {
                            r.total_bytes = r.total_bytes.saturating_add(l.total_uncompressed);
                            r.needs_password |= l.needs_password;
                            if l.unsafe_entries > 0 {
                                r.errors.push(format!("{name}: {}", Error::UnsafeEntry(format!("{} entries", l.unsafe_entries)).user_message()));
                            }
                            if l.suspicious_ratio || l.total_uncompressed > limit {
                                r.warnings.push(format!("{name} expands to an unusually large size ({} MB).", l.total_uncompressed / 1_000_000));
                            }
                            let root = extract_root(a, &req.output_dir, o.subfolder, req.conflict);
                            for e in l.entries.iter().filter(|e| !e.is_dir && e.safe) {
                                if let Ok(rel) = fs_safe::safe_relative_path(&e.name) {
                                    let t = root.join(rel);
                                    if exists(&t) && r.conflicts.len() < MAX_CONFLICTS {
                                        r.conflicts.push(t);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => return Err(Error::Unsupported("the ZIP engine does not handle this operation".into())),
        }
        Ok(r)
    }

    fn run(&self, req: &JobRequest, ctx: &JobContext) -> Result<()> {
        match &req.operation {
            Operation::Compress(o) => compress(&req.inputs, &req.output_dir, o.archive_name.as_deref(), o.include_folders, req.conflict, ctx),
            Operation::Extract(o) => extract_all(
                &req.inputs,
                &req.output_dir,
                o.subfolder,
                req.conflict,
                o.password.as_ref().map(|s| s.expose()),
                o.max_total_bytes.unwrap_or(DEFAULT_MAX_EXTRACT_BYTES),
                ctx,
            ),
            _ => Err(Error::Unsupported("the ZIP engine does not handle this operation".into())),
        }
    }
}
