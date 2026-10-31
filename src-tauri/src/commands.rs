//! Commands the React UI can call. Each is a thin step around the API client:
//! the webview never sees the API address or token, and never touches file bytes.

use crate::client::{ApiClient, ClientError, UploadFile};
use crate::AppState;
use file_api::types::{JobResponse, WireStatus};
use file_core::fs_safe::{self, Committed, ConflictPolicy};
use file_core::{JobRequest, Operation, Review};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub type CmdResult<T> = Result<T, ClientError>;

fn internal<E>(_: E) -> ClientError {
    ClientError::new("INTERNAL_ERROR", "Something went wrong inside the app.")
}

impl From<file_core::Error> for ClientError {
    fn from(e: file_core::Error) -> Self {
        ClientError::new(&e.code().to_uppercase(), e.user_message())
    }
}

// --------------------------------------------------------------- tickets

enum Phase {
    Uploading,
    Submitted(String), // API job id
    Failed(ClientError),
    Cancelled,
}

/// Desktop-side handle for a job. Exists from the moment the user presses
/// Start, i.e. before the API has assigned a job id.
pub struct Ticket {
    id: String,
    operation: &'static str,
    output_dir: PathBuf,
    conflict: ConflictPolicy,
    phase: Mutex<Phase>,
    sent: Arc<AtomicU64>,
    total: u64,
    cancel: CancellationToken,
    downloaded: tokio::sync::Mutex<Option<DownloadSummary>>,
    saved: Mutex<Vec<PathBuf>>,
}

#[derive(Serialize)]
pub struct UploadProgress {
    pub sent: u64,
    pub total: u64,
}

#[derive(Serialize)]
pub struct DesktopStatus {
    pub job_id: String,
    pub operation: String,
    /// uploading | processing | failed | cancelled
    pub phase: &'static str,
    pub upload: UploadProgress,
    pub job: Option<JobResponse>,
    pub error: Option<ClientError>,
}

#[derive(Clone, Serialize)]
pub struct DownloadSummary {
    /// Top-level files/folders now in the output folder.
    pub outputs: Vec<PathBuf>,
    pub files_saved: u64,
    pub files_skipped: u64,
    pub bytes_saved: u64,
}

fn ticket(state: &AppState, id: &str) -> CmdResult<Arc<Ticket>> {
    state.tickets.lock().unwrap().get(id).cloned().ok_or_else(|| ClientError::new("JOB_NOT_FOUND", "That job isn't available any more."))
}

// ---------------------------------------------------------------- helpers

fn parse_request(request: &Value) -> CmdResult<JobRequest> {
    serde_json::from_value(request.clone()).map_err(|e| ClientError::new("INVALID_REQUEST", format!("Invalid request: {e}")))
}

/// UI operation tag -> (API operation name, options JSON without the tag).
fn api_operation(request: &Value) -> CmdResult<(&'static str, Value)> {
    let mut opts = request.get("operation").cloned().unwrap_or(Value::Null);
    let tag = opts.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(o) = opts.as_object_mut() {
        o.remove("type");
    }
    let op = match tag.as_str() {
        "compress" => "compress",
        "extract" => "extract",
        "convert_image" => "convert",
        "resize_image" => "resize",
        "pdf_merge" => "pdf_merge",
        "pdf_split" => "pdf_split",
        "pdf_pages" => "pdf_pages",
        "images_to_pdf" => "images_to_pdf",
        "pdf_to_images" => "pdf_to_images",
        "office_to_pdf" => "office_to_pdf",
        "pdf_protect" => "pdf_protect",
        "pdf_unlock" => "pdf_unlock",
        "pdf_compress" => "pdf_compress",
        _ => return Err(ClientError::new("INVALID_REQUEST", "Unknown operation.")),
    };
    Ok((op, opts))
}

fn head_hex(path: &Path) -> String {
    file_core::formats::read_head(path).map(|h| file_core::formats::hex_encode(&h)).unwrap_or_default()
}

/// Expand inputs into uploads. Folders are walked (symlinks skipped) and their
/// files named by relative path so the server can rebuild the tree.
fn collect_uploads(inputs: &[PathBuf]) -> CmdResult<Vec<UploadFile>> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<UploadFile>) -> std::io::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = format!("{prefix}/{}", e.file_name().to_string_lossy());
            let ft = e.file_type()?;
            if ft.is_dir() {
                walk(&e.path(), &name, out)?;
            } else if ft.is_file() {
                out.push(UploadFile { head_hex: head_hex(&e.path()), path: e.path(), name, size: e.metadata()?.len() });
            }
        }
        Ok(())
    }
    let mut out = vec![];
    for p in inputs {
        let meta = std::fs::metadata(p).map_err(|e| ClientError::from(file_core::Error::from(e).at(p)))?;
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if meta.is_dir() {
            walk(p, &name, &mut out).map_err(|e| ClientError::from(file_core::Error::from(e).at(p)))?;
        } else {
            out.push(UploadFile { head_hex: head_hex(p), path: p.clone(), name, size: meta.len() });
        }
    }
    Ok(out)
}

// --------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct ApiStatus {
    pub connected: bool,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn api_status(state: tauri::State<'_, AppState>) -> CmdResult<ApiStatus> {
    Ok(match state.api.health().await {
        Ok(h) => ApiStatus { connected: true, version: Some(h.version) },
        Err(_) => ApiStatus { connected: false, version: None },
    })
}

/// What this build of the app can actually do: engines, operations, formats, conversion pairs, options, limits.
#[tauri::command]
pub async fn get_capabilities(state: tauri::State<'_, AppState>) -> CmdResult<file_core::Capabilities> {
    state.api.capabilities().await
}

/// Pre-flight dry run on local paths (conflicts, warnings). Reads, never writes.
#[tauri::command]
pub async fn review_job(request: Value) -> CmdResult<Review> {
    let req = parse_request(&request)?;
    tauri::async_runtime::spawn_blocking(move || file_core::request::review(&req))
        .await
        .map_err(internal)?
        .map_err(Into::into)
}

/// Validate, then upload to the local API in the background. Returns a ticket id at once.
#[tauri::command]
pub async fn start_job(state: tauri::State<'_, AppState>, request: Value) -> CmdResult<String> {
    let req = parse_request(&request)?;
    let (op, options) = api_operation(&request)?;
    let (output_dir, conflict, inputs) = (req.output_dir.clone(), req.conflict, req.inputs.clone());
    let is_compress = matches!(req.operation, Operation::Compress(_));
    let files = tauri::async_runtime::spawn_blocking(move || {
        file_core::request::validate(&req)?;
        collect_uploads(&inputs)
    })
    .await
    .map_err(internal)??;
    if files.is_empty() {
        return Err(ClientError::new("INVALID_REQUEST", "There are no files to process."));
    }
    if !is_compress && files.len() != request["inputs"].as_array().map_or(0, Vec::len) {
        return Err(ClientError::new("INVALID_REQUEST", "Folders can only be added when compressing."));
    }

    // Ask the API first, so an impossible job (wrong file type, missing engine,
    // bad option) is refused before a single byte is copied.
    let verdict = state.api.preview(op, &options, &files).await?;
    if !verdict.ok {
        let first = &verdict.errors[0];
        let more = if verdict.errors.len() > 1 { format!(" (and {} more problem(s))", verdict.errors.len() - 1) } else { String::new() };
        return Err(ClientError::new(&first.code, format!("{}{more}", first.message)));
    }

    let t = Arc::new(Ticket {
        id: format!("task_{}", uuid::Uuid::new_v4().simple()),
        operation: op,
        output_dir,
        conflict,
        phase: Mutex::new(Phase::Uploading),
        sent: Arc::new(AtomicU64::new(0)),
        total: files.iter().map(|f| f.size).sum(),
        cancel: CancellationToken::new(),
        downloaded: Default::default(),
        saved: Default::default(),
    });
    state.tickets.lock().unwrap().insert(t.id.clone(), t.clone());

    let api = state.api.clone();
    let t2 = t.clone();
    tauri::async_runtime::spawn(async move {
        let result = api.create_job(op, &options, files, t2.sent.clone(), t2.cancel.clone()).await;
        let mut phase = t2.phase.lock().unwrap();
        // A cancel that raced the upload wins.
        if t2.cancel.is_cancelled() {
            if let Ok(created) = &result {
                let api = api.clone();
                let id = created.job_id.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = api.cancel(&id).await;
                });
            }
            *phase = Phase::Cancelled;
            return;
        }
        *phase = match result {
            Ok(created) => Phase::Submitted(created.job_id),
            Err(e) if e.code == "CANCELLED" => Phase::Cancelled,
            Err(e) => Phase::Failed(e),
        };
    });
    Ok(t.id.clone())
}

#[tauri::command]
pub async fn get_job_status(state: tauri::State<'_, AppState>, job_id: String) -> CmdResult<DesktopStatus> {
    let t = ticket(&state, &job_id)?;
    let (phase_name, api_id, error) = {
        match &*t.phase.lock().unwrap() {
            Phase::Uploading => ("uploading", None, None),
            Phase::Submitted(id) => ("processing", Some(id.clone()), None),
            Phase::Failed(e) => ("failed", None, Some(e.clone())),
            Phase::Cancelled => ("cancelled", None, None),
        }
    };
    let job = match api_id {
        Some(id) => Some(state.api.status(&id).await?),
        None => None,
    };
    Ok(DesktopStatus {
        job_id: t.id.clone(),
        operation: t.operation.to_string(),
        phase: phase_name,
        upload: UploadProgress { sent: t.sent.load(Ordering::Relaxed), total: t.total },
        job,
        error,
    })
}

#[tauri::command]
pub async fn cancel_job(state: tauri::State<'_, AppState>, job_id: String) -> CmdResult<()> {
    let t = ticket(&state, &job_id)?;
    t.cancel.cancel(); // stops an in-flight upload
    let api_id = match &*t.phase.lock().unwrap() {
        Phase::Submitted(id) => Some(id.clone()),
        _ => None,
    };
    if let Some(id) = api_id {
        state.api.cancel(&id).await?;
    }
    Ok(())
}

/// Save a completed job's results into the chosen output folder, honouring the
/// conflict policy. Safe to call twice: the second call returns the first summary.
#[tauri::command]
pub async fn download_result(state: tauri::State<'_, AppState>, job_id: String) -> CmdResult<DownloadSummary> {
    let t = ticket(&state, &job_id)?;
    let mut done = t.downloaded.lock().await;
    if let Some(s) = &*done {
        return Ok(s.clone());
    }
    let api_id = match &*t.phase.lock().unwrap() {
        Phase::Submitted(id) => id.clone(),
        _ => return Err(ClientError::new("JOB_NOT_COMPLETED", "This job has no result.")),
    };
    let status = state.api.status(&api_id).await?;
    if status.status != WireStatus::Completed {
        return Err(ClientError::new("JOB_NOT_COMPLETED", "This job has no result."));
    }
    let summary = save_result(&state.api, &api_id, &t.output_dir, t.conflict).await?;
    *t.saved.lock().unwrap() = summary.outputs.clone();
    *done = Some(summary.clone());
    Ok(summary)
}

async fn save_result(api: &ApiClient, id: &str, out: &Path, policy: ConflictPolicy) -> CmdResult<DownloadSummary> {
    let manifest = api.manifest(id).await?;

    // Re-validate every server-provided path; the client never trusts the wire.
    let rel_of = |p: &str| fs_safe::safe_relative_path(p).map_err(|_| ClientError::new("INVALID_RESPONSE", "The service returned an unsafe file path."));
    let mut top_rename: HashMap<String, String> = HashMap::new();
    let top_of = |rel: &Path| rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();

    // Folders that already exist get a fresh name as a whole ("pack (1)"), rather
    // than renaming every file inside them.
    let mut tops_that_are_dirs = std::collections::BTreeSet::new();
    for d in &manifest.directories {
        tops_that_are_dirs.insert(top_of(&rel_of(d)?));
    }
    if policy == ConflictPolicy::Rename {
        for top in &tops_that_are_dirs {
            let target = out.join(top);
            if std::fs::symlink_metadata(&target).is_ok() {
                let unique = fs_safe::unique_path(&target);
                top_rename.insert(top.clone(), unique.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
    }
    let map_rel = |rel: &Path| -> PathBuf {
        let mut comps = rel.components();
        let first = comps.next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
        let mut p = PathBuf::from(top_rename.get(&first).cloned().unwrap_or(first));
        p.extend(comps);
        p
    };

    for d in &manifest.directories {
        let target = out.join(map_rel(&rel_of(d)?));
        tokio::fs::create_dir_all(&target).await.map_err(|e| ClientError::from(file_core::Error::from(e).at(&target)))?;
    }

    let (mut saved, mut skipped, mut bytes_saved) = (0u64, 0u64, 0u64);
    let mut outputs: Vec<PathBuf> = vec![];
    for f in &manifest.files {
        let rel = rel_of(&f.path)?;
        let target = out.join(map_rel(&rel));
        let parent = target.parent().unwrap_or(out).to_path_buf();
        tokio::fs::create_dir_all(&parent).await.map_err(|e| ClientError::from(file_core::Error::from(e).at(&parent)))?;

        if fs_safe::resolve_destination(&target, policy, &[])? == fs_safe::Resolved::Skip {
            skipped += 1;
            continue;
        }
        // Temp file next to the destination; promoted only when fully written.
        let tmp = fs_safe::temp_in(&parent)?;
        let std_file = tmp.as_file().try_clone().map_err(|e| ClientError::from(file_core::Error::from(e)))?;
        let mut w = tokio::io::BufWriter::new(tokio::fs::File::from_std(std_file));
        let mut res = api.file(id, f.index).await?;
        while let Some(chunk) = res.chunk().await.map_err(ClientError::from)? {
            w.write_all(&chunk).await.map_err(|e| ClientError::from(file_core::Error::from(e).at(&parent)))?;
        }
        w.flush().await.map_err(|e| ClientError::from(file_core::Error::from(e).at(&parent)))?;
        drop(w);
        match fs_safe::commit(tmp, &target, policy, &[])? {
            Committed::Written(p) => {
                saved += 1;
                bytes_saved += f.size;
                let top = out.join(top_of(p.strip_prefix(out).unwrap_or(&p)));
                if !outputs.contains(&top) {
                    outputs.push(top);
                }
            }
            Committed::Skipped => skipped += 1,
        }
    }
    Ok(DownloadSummary { outputs, files_saved: saved, files_skipped: skipped, bytes_saved })
}

/// Show a saved result in Explorer. Only paths this app just wrote are accepted.
#[tauri::command]
pub fn reveal_output(state: tauri::State<'_, AppState>, path: PathBuf) -> CmdResult<()> {
    let known = state.tickets.lock().unwrap().values().any(|t| t.saved.lock().unwrap().contains(&path));
    if !known || !path.exists() {
        return Err(ClientError::new("NOT_FOUND", "That file isn't available any more."));
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(internal)
}

/// Forget finished tickets (history lives in memory only).
#[tauri::command]
pub fn clear_history(state: tauri::State<'_, AppState>) {
    state.tickets.lock().unwrap().retain(|_, t| match &*t.phase.lock().unwrap() {
        Phase::Uploading => true,
        Phase::Submitted(_) => t.downloaded.try_lock().map_or(true, |d| d.is_none()),
        Phase::Failed(_) | Phase::Cancelled => false,
    });
}

#[derive(Serialize)]
pub struct PathInfo {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    /// File size, or the total of all files inside a folder.
    pub size: u64,
    pub file_count: u64,
}

/// Read-only metadata for files the user picked or dropped, so the UI can show
/// names and sizes without any filesystem permission of its own.
#[tauri::command]
pub async fn inspect_paths(paths: Vec<PathBuf>) -> CmdResult<Vec<PathInfo>> {
    fn total(dir: &Path) -> std::io::Result<(u64, u64)> {
        let (mut bytes, mut count) = (0, 0);
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            let ft = e.file_type()?;
            if ft.is_dir() {
                let (b, c) = total(&e.path())?;
                bytes += b;
                count += c;
            } else if ft.is_file() {
                bytes += e.metadata()?.len();
                count += 1;
            }
        }
        Ok((bytes, count))
    }
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                if !path.is_absolute() {
                    return Err(ClientError::new("INVALID_REQUEST", "File locations must be full paths."));
                }
                let at = |e: std::io::Error| ClientError::from(file_core::Error::from(e).at(&path));
                let meta = std::fs::metadata(&path).map_err(at)?;
                let (size, file_count) = if meta.is_dir() { total(&path).map_err(at)? } else { (meta.len(), 1) };
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
                Ok(PathInfo { path, name, is_dir: meta.is_dir(), size, file_count })
            })
            .collect()
    })
    .await
    .map_err(internal)?
}

#[tauri::command]
pub async fn list_archive(path: PathBuf) -> CmdResult<file_core::archive::ArchiveListing> {
    tauri::async_runtime::spawn_blocking(move || file_core::archive::list(&path))
        .await
        .map_err(internal)?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    //! Drives the real client against a real in-process API server.
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    struct Fixture {
        _root: tempfile::TempDir,
        server: file_api::RunningServer,
        api: ApiClient,
        out: PathBuf,
        src: PathBuf,
    }

    async fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let server = file_api::start(file_api::ApiConfig::local(root.path().join("jobs"))).await.unwrap();
        let api = ApiClient::new(server.base_url(), server.token.clone());
        let (out, src) = (root.path().join("out"), root.path().join("src"));
        fs::create_dir_all(&out).unwrap();
        fs::create_dir_all(&src).unwrap();
        Fixture { _root: root, server, api, out, src }
    }

    async fn run_job(f: &Fixture, op: &str, options: Value, uploads: Vec<UploadFile>) -> String {
        let created = f.api.create_job(op, &options, uploads, Default::default(), CancellationToken::new()).await.unwrap();
        let t = Instant::now();
        loop {
            let s = f.api.status(&created.job_id).await.unwrap();
            if s.status.is_finished() {
                assert_eq!(s.status, WireStatus::Completed, "{s:?}");
                return created.job_id;
            }
            assert!(t.elapsed() < Duration::from_secs(30));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn upload(path: &Path, name: &str) -> UploadFile {
        UploadFile { head_hex: String::new(), path: path.to_path_buf(), name: name.into(), size: fs::metadata(path).unwrap().len() }
    }

    #[tokio::test]
    async fn bad_token_is_rejected_by_the_server() {
        let f = fixture().await;
        let bad = ApiClient::new(f.server.base_url(), "x".repeat(64));
        let e = bad.status("job_x").await.unwrap_err();
        assert_eq!(e.code, "UNAUTHORIZED");
        assert!(f.api.health().await.is_ok());
    }

    #[tokio::test]
    async fn compress_upload_download_and_conflict_policies() {
        let f = fixture().await;
        let a = f.src.join("a.txt");
        fs::write(&a, b"hello").unwrap();
        let sent = Arc::new(AtomicU64::new(0));
        let created = f.api.create_job("compress", &serde_json::json!({"archive_name": "bundle"}), vec![upload(&a, "a.txt")], sent.clone(), CancellationToken::new()).await.unwrap();
        assert_eq!(sent.load(Ordering::Relaxed), 5, "upload progress counts bytes sent");
        let id = created.job_id;
        while !f.api.status(&id).await.unwrap().status.is_finished() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let s = save_result(&f.api, &id, &f.out, ConflictPolicy::Rename).await.unwrap();
        assert_eq!((s.files_saved, s.files_skipped), (1, 0));
        assert!(f.out.join("bundle.zip").exists());
        // second run: keep both
        save_result(&f.api, &id, &f.out, ConflictPolicy::Rename).await.unwrap();
        assert!(f.out.join("bundle (1).zip").exists());
        // skip leaves existing alone
        let before = fs::read(f.out.join("bundle.zip")).unwrap();
        let s = save_result(&f.api, &id, &f.out, ConflictPolicy::Skip).await.unwrap();
        assert_eq!((s.files_saved, s.files_skipped), (0, 1));
        assert_eq!(fs::read(f.out.join("bundle.zip")).unwrap(), before);
        // replace overwrites
        fs::write(f.out.join("bundle.zip"), b"old").unwrap();
        save_result(&f.api, &id, &f.out, ConflictPolicy::Replace).await.unwrap();
        assert_eq!(fs::read(f.out.join("bundle.zip")).unwrap(), before);
        // no temp files left
        assert!(fs::read_dir(&f.out).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")));
    }

    #[tokio::test]
    async fn extracted_folders_get_a_fresh_name_when_one_exists() {
        let f = fixture().await;
        let zip_path = f.src.join("pack.zip");
        {
            use std::io::Write;
            let mut z = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
            z.start_file("docs/one.txt", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"1").unwrap();
            z.start_file("two.txt", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"2").unwrap();
            z.finish().unwrap();
        }
        let id = run_job(&f, "extract", serde_json::json!({}), vec![upload(&zip_path, "pack.zip")]).await;
        let s1 = save_result(&f.api, &id, &f.out, ConflictPolicy::Rename).await.unwrap();
        assert_eq!(s1.files_saved, 2);
        assert_eq!(fs::read(f.out.join("pack/docs/one.txt")).unwrap(), b"1");
        let s2 = save_result(&f.api, &id, &f.out, ConflictPolicy::Rename).await.unwrap();
        assert_eq!(fs::read(f.out.join("pack (1)/docs/one.txt")).unwrap(), b"1", "whole folder renamed, not each file");
        assert!(s2.outputs.contains(&f.out.join("pack (1)")));
    }

    #[tokio::test]
    async fn folder_upload_keeps_structure_and_cancel_during_upload_leaves_nothing() {
        let f = fixture().await;
        fs::create_dir_all(f.src.join("proj/sub")).unwrap();
        fs::write(f.src.join("proj/sub/x.txt"), b"x").unwrap();
        fs::write(f.src.join("proj/y.txt"), b"y").unwrap();
        let uploads = collect_uploads(&[f.src.join("proj")]).unwrap();
        let names: Vec<_> = uploads.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(names, vec!["proj/sub/x.txt", "proj/y.txt"]);
        let id = run_job(&f, "compress", serde_json::json!({}), uploads).await;
        save_result(&f.api, &id, &f.out, ConflictPolicy::Rename).await.unwrap();
        let z = zip::ZipArchive::new(fs::File::open(f.out.join("proj.zip")).unwrap()).unwrap();
        let mut n: Vec<_> = z.file_names().map(str::to_string).collect();
        n.sort();
        assert!(n.contains(&"proj/sub/x.txt".to_string()) && n.contains(&"proj/y.txt".to_string()), "{n:?}");

        // a cancelled upload reports CANCELLED
        let token = CancellationToken::new();
        token.cancel();
        let err = f.api.create_job("compress", &serde_json::json!({}), vec![upload(&f.src.join("proj/y.txt"), "y.txt")], Default::default(), token).await.unwrap_err();
        assert_eq!(err.code, "CANCELLED");
    }

    #[tokio::test]
    async fn server_errors_surface_with_plain_codes() {
        let f = fixture().await;
        let png = f.src.join("fake.png");
        fs::write(&png, b"this is not really an image at all").unwrap();
        let err = f.api.create_job("convert", &serde_json::json!({"format": "jpeg"}), vec![upload(&png, "fake.png")], Default::default(), CancellationToken::new()).await.unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_FORMAT");
        // unsafe path from a (hypothetical misbehaving) server is refused by the client
        assert!(fs_safe::safe_relative_path("../evil").is_err());
    }

    #[test]
    fn request_translation() {
        let req = serde_json::json!({"inputs": ["/a"], "output_dir": "/o", "operation": {"type": "convert_image", "format": "webp", "quality": 80}});
        let (op, opts) = api_operation(&req).unwrap();
        assert_eq!(op, "convert");
        assert_eq!(opts, serde_json::json!({"format": "webp", "quality": 80}));
        assert!(api_operation(&serde_json::json!({"operation": {"type": "format_c_drive"}})).is_err());
    }

    #[test]
    fn pdf_requests_translate_and_parse() {
        for (op, name) in [
            (serde_json::json!({"type": "pdf_merge", "output_name": "m"}), "pdf_merge"),
            (serde_json::json!({"type": "pdf_split", "mode": "ranges", "ranges": "1-2"}), "pdf_split"),
            (serde_json::json!({"type": "pdf_pages", "pages": [{"page": 2, "rotate": 90}, {"page": 1}], "password": "x"}), "pdf_pages"),
            (serde_json::json!({"type": "pdf_pages", "pages": [{"page": 1}], "annotations": [{"kind": "text", "page": 1, "x": 10, "y": 10, "text": "Hi", "size": 12, "color": "#000000", "background": null}]}), "pdf_pages"),
            (serde_json::json!({"type": "images_to_pdf", "paper": "a4", "orientation": "auto", "margin_mm": 10}), "images_to_pdf"),
            (serde_json::json!({"type": "pdf_to_images", "format": "png", "dpi": 150}), "pdf_to_images"),
            (serde_json::json!({"type": "office_to_pdf"}), "office_to_pdf"),
        ] {
            let req = serde_json::json!({"inputs": ["/a.pdf"], "output_dir": "/o", "operation": op});
            let (got, opts) = api_operation(&req).unwrap();
            assert_eq!(got, name);
            assert!(opts.get("type").is_none(), "the tag is not an option");
            parse_request(&req).unwrap();
        }
        // a password must not show in debug output of the parsed request
        let req = serde_json::json!({"inputs": ["/a.pdf"], "output_dir": "/o", "operation": {"type": "pdf_pages", "pages": [{"page": 1}], "password": "hunter2"}});
        assert!(!format!("{:?}", parse_request(&req).unwrap()).contains("hunter2"));
    }
}

// ------------------------------------------------------------------ PDF viewing

/// Open a PDF for viewing. The file is read-only here: nothing is written next to it.
#[tauri::command]
pub async fn pdf_open(state: tauri::State<'_, AppState>, path: PathBuf, password: Option<String>) -> CmdResult<file_api::types::PdfDocumentResponse> {
    if !path.is_absolute() {
        return Err(ClientError::new("INVALID_REQUEST", "File locations must be full paths."));
    }
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| ClientError::from(file_core::Error::from(e).at(&path)))?;
    if !meta.is_file() {
        return Err(ClientError::new("INVALID_REQUEST", "Choose a PDF file, not a folder."));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "document.pdf".into());
    state.api.open_pdf(&path, &name, meta.len(), password.as_deref()).await
}

/// A page as PNG bytes, delivered to the webview as a raw binary response.
#[tauri::command]
pub async fn pdf_page_image(state: tauri::State<'_, AppState>, document_id: String, page: u32, width: u32) -> CmdResult<tauri::ipc::Response> {
    if document_id.len() > 64 || !document_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ClientError::new("INVALID_REQUEST", "Unknown document."));
    }
    Ok(tauri::ipc::Response::new(state.api.pdf_page(&document_id, page, width).await?))
}

/// Largest picture file the editor will load to place on a page.
const MAX_PICTURE_BYTES: u64 = 40 * 1024 * 1024;

/// A JPG, PNG or WebP file's bytes, so the editor can show the picture it is about to place on a page.
/// The content is checked, not the name; nothing else is ever returned through here.
#[tauri::command]
pub async fn read_picture(path: PathBuf) -> CmdResult<tauri::ipc::Response> {
    if !path.is_absolute() {
        return Err(ClientError::new("INVALID_REQUEST", "File locations must be full paths."));
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<u8>> {
        let meta = std::fs::metadata(&path).map_err(|e| ClientError::from(file_core::Error::from(e).at(&path)))?;
        if !meta.is_file() || meta.len() > MAX_PICTURE_BYTES {
            return Err(ClientError::new("INVALID_REQUEST", "Choose a picture file smaller than 40 MB."));
        }
        if !matches!(file_core::formats::detect_file(&path), Some(file_core::formats::JPEG | file_core::formats::PNG | file_core::formats::WEBP)) {
            return Err(ClientError::new("UNSUPPORTED_FORMAT", "Choose a JPG, PNG or WebP picture."));
        }
        std::fs::read(&path).map_err(|e| ClientError::from(file_core::Error::from(e).at(&path)))
    })
    .await
    .map_err(internal)??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn pdf_close(state: tauri::State<'_, AppState>, document_id: String) -> CmdResult<()> {
    if document_id.len() > 64 || !document_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Ok(());
    }
    state.api.close_pdf(&document_id).await
}
