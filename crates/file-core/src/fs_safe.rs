//! Output-path rules shared by every engine: no silent overwrites, no writes
//! outside the chosen folder, and atomic "temp file then move into place".

use crate::error::{Error, IoContext, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;

/// What to do when an output file already exists. Decided by the user in the
/// review step; the backend never picks `Replace` on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// Keep both: write `name (1).ext`.
    #[default]
    Rename,
    Replace,
    Skip,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
    Write(PathBuf),
    /// An existing file is in the way and the policy says leave it alone.
    Skip,
}

pub enum Committed {
    Written(PathBuf),
    Skipped,
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

fn canonical_eq(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// `report.pdf` -> `report (1).pdf`, `report (2).pdf`, ...
pub fn unique_path(desired: &Path) -> PathBuf {
    let dir = desired.parent().unwrap_or_else(|| Path::new(""));
    let stem = desired
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = desired.extension().map(|e| e.to_string_lossy().into_owned());
    for n in 1..100_000u32 {
        let name = match &ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(name);
        if !exists(&candidate) {
            return candidate;
        }
    }
    // Practically unreachable; fall back to something that still won't clobber.
    dir.join(format!("{stem} ({})", uuid::Uuid::new_v4()))
}

/// Decide where `desired` should really be written. `protected` lists source
/// files that must never be overwritten, whatever the policy.
pub fn resolve_destination(
    desired: &Path,
    policy: ConflictPolicy,
    protected: &[PathBuf],
) -> Result<Resolved> {
    if !exists(desired) {
        return Ok(Resolved::Write(desired.to_path_buf()));
    }
    let is_source = protected.iter().any(|p| canonical_eq(p, desired));
    match policy {
        ConflictPolicy::Rename => Ok(Resolved::Write(unique_path(desired))),
        ConflictPolicy::Skip => Ok(Resolved::Skip),
        ConflictPolicy::Replace => {
            if is_source {
                Err(Error::WouldOverwriteSource(desired.to_path_buf()))
            } else if !fs::symlink_metadata(desired).map(|m| m.is_file()).unwrap_or(false) {
                Err(Error::DestinationNotFile(desired.to_path_buf()))
            } else {
                Ok(Resolved::Write(desired.to_path_buf()))
            }
        }
    }
}

/// A temp file in the destination directory (same volume, so the final move is
/// a rename). It is deleted on drop unless committed.
pub fn temp_in(dir: &Path) -> Result<NamedTempFile> {
    tempfile::Builder::new()
        .prefix(".filetool-")
        .suffix(".part")
        .tempfile_in(dir)
        .at(dir)
}

/// Move a finished temp file to `desired`, honouring the conflict policy.
/// Safe against a file appearing between the check and the move.
pub fn commit(
    mut tmp: NamedTempFile,
    desired: &Path,
    policy: ConflictPolicy,
    protected: &[PathBuf],
) -> Result<Committed> {
    for _ in 0..100 {
        match resolve_destination(desired, policy, protected)? {
            Resolved::Skip => return Ok(Committed::Skipped),
            Resolved::Write(path) => {
                if policy == ConflictPolicy::Replace && exists(&path) {
                    tmp.persist(&path).map_err(|e| Error::from(e.error).at(&path))?;
                    return Ok(Committed::Written(path));
                }
                match tmp.persist_noclobber(&path) {
                    Ok(_) => return Ok(Committed::Written(path)),
                    Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                        tmp = e.file;
                    }
                    Err(e) => return Err(Error::from(e.error).at(&path)),
                }
            }
        }
    }
    Err(Error::InvalidRequest(
        "couldn't find a free file name for the output".into(),
    ))
}

/// Check that a directory exists and we can create files in it.
pub fn check_writable_dir(dir: &Path) -> Result<()> {
    let meta = fs::metadata(dir).at(dir)?;
    if !meta.is_dir() {
        return Err(Error::InvalidRequest(format!(
            "“{}” is not a folder.",
            dir.display()
        )));
    }
    temp_in(dir).map(drop)
}

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn component_ok(c: &str) -> bool {
    if c.is_empty() || c.len() > 255 {
        return false;
    }
    if c.chars()
        .any(|ch| ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    // Windows silently strips these, which would alias other names.
    if c.ends_with('.') || c.ends_with(' ') {
        return false;
    }
    let base = c.split('.').next().unwrap_or("").to_ascii_uppercase();
    !RESERVED.contains(&base.as_str())
}

/// Turn an archive entry name into a relative path that is guaranteed to stay
/// inside whatever folder it is joined onto. Rejects (rather than rewrites)
/// anything suspicious: absolute paths, `..`, drive letters, device names.
pub fn safe_relative_path(name: &str) -> Result<PathBuf> {
    let unsafe_entry = || Error::UnsafeEntry(name.to_string());
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(unsafe_entry());
    }
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(unsafe_entry()),
            p if component_ok(p) => out.push(p),
            _ => return Err(unsafe_entry()),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(unsafe_entry());
    }
    // Defence in depth: nothing but plain names may remain.
    if out.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(unsafe_entry());
    }
    Ok(out)
}

/// A single file name with no directory part (used for user-typed archive names).
pub fn safe_file_name(name: &str) -> Result<String> {
    let p = safe_relative_path(name.trim())?;
    if p.components().count() != 1 {
        return Err(Error::InvalidRequest(
            "The file name can't contain folders.".into(),
        ));
    }
    Ok(p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_absolute() {
        for bad in [
            "../../outside.txt",
            "a/../../b",
            "/etc/passwd",
            "\\windows\\system32",
            "C:/x.txt",
            "dir/C:evil",
            "nul.txt",
            "a/COM1",
            "trailing.",
            "..",
            "",
            "./",
        ] {
            assert!(safe_relative_path(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn accepts_normal_names() {
        assert_eq!(safe_relative_path("a/b/c.txt").unwrap(), PathBuf::from("a/b/c.txt"));
        assert_eq!(safe_relative_path("dir\\file.txt").unwrap(), PathBuf::from("dir/file.txt"));
        assert_eq!(safe_relative_path("./x/./y/").unwrap(), PathBuf::from("x/y"));
        assert!(safe_relative_path("résumé 日本語.txt").is_ok());
    }

    #[test]
    fn unique_path_counts_up() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.txt");
        fs::write(&p, "x").unwrap();
        assert_eq!(unique_path(&p), d.path().join("a (1).txt"));
        fs::write(d.path().join("a (1).txt"), "x").unwrap();
        assert_eq!(unique_path(&p), d.path().join("a (2).txt"));
    }

    #[test]
    fn policies() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.txt");
        fs::write(&p, "old").unwrap();
        let none: Vec<PathBuf> = vec![];

        assert_eq!(resolve_destination(&p, ConflictPolicy::Skip, &none).unwrap(), Resolved::Skip);
        assert_eq!(
            resolve_destination(&p, ConflictPolicy::Rename, &none).unwrap(),
            Resolved::Write(d.path().join("a (1).txt"))
        );
        assert_eq!(
            resolve_destination(&p, ConflictPolicy::Replace, &none).unwrap(),
            Resolved::Write(p.clone())
        );
        // A source file can never be replaced.
        assert!(matches!(
            resolve_destination(&p, ConflictPolicy::Replace, &[p.clone()]),
            Err(Error::WouldOverwriteSource(_))
        ));
    }

    #[test]
    fn commit_respects_policy_and_cleans_up() {
        use std::io::Write;
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("out.bin");
        fs::write(&target, "old").unwrap();

        let mut t = temp_in(d.path()).unwrap();
        t.write_all(b"new").unwrap();
        assert!(matches!(
            commit(t, &target, ConflictPolicy::Skip, &[]).unwrap(),
            Committed::Skipped
        ));
        assert_eq!(fs::read(&target).unwrap(), b"old");

        let mut t = temp_in(d.path()).unwrap();
        t.write_all(b"new").unwrap();
        let Committed::Written(p) = commit(t, &target, ConflictPolicy::Rename, &[]).unwrap() else {
            panic!()
        };
        assert_eq!(p, d.path().join("out (1).bin"));
        assert_eq!(fs::read(&target).unwrap(), b"old");

        let mut t = temp_in(d.path()).unwrap();
        t.write_all(b"new").unwrap();
        commit(t, &target, ConflictPolicy::Replace, &[]).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");

        // No stray temp files remain.
        let leftovers: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
