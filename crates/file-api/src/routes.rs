use crate::error::ApiError;
use crate::jobs::{to_response, JobRecord};
use crate::principal::Principal;
use crate::types::*;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::Extension;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use file_core::formats::{self, FileDescriptor};
use file_core::{ConflictPolicy, JobRequest, JobState, JobStatus, Operation};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

fn mb(n: u64) -> String {
    if n >= 1024 * 1024 * 1024 {
        format!("{} GB", n / (1024 * 1024 * 1024))
    } else {
        format!("{} MB", n / (1024 * 1024))
    }
}

pub async fn health() -> Json<Health> {
    Json(Health { status: "ok".into(), version: env!("CARGO_PKG_VERSION").into() })
}

/// Deletes a half-built job directory unless the job was accepted.
struct DirGuard(Option<PathBuf>);
impl DirGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}
impl Drop for DirGuard {
    fn drop(&mut self) {
        if let Some(p) = &self.0 {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

pub(crate) fn multipart_err(e: axum::extract::multipart::MultipartError) -> ApiError {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::too_large("The upload exceeds the size limit.")
    } else {
        ApiError::invalid("The upload couldn't be read.")
    }
}

pub(crate) async fn read_text(mut field: axum::extract::multipart::Field<'_>, cap: usize) -> Result<String, ApiError> {
    let mut buf = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(multipart_err)? {
        if buf.len() + chunk.len() > cap {
            return Err(ApiError::invalid("A form field is too long."));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|_| ApiError::invalid("Form fields must be UTF-8 text."))
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Compress,
    Extract,
    Convert,
    Resize,
    PdfMerge,
    PdfSplit,
    PdfPages,
    ImagesToPdf,
    PdfToImages,
    OfficeToPdf,
}

impl Op {
    fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "compress" => Some(Op::Compress),
            "extract" => Some(Op::Extract),
            "convert" => Some(Op::Convert),
            "resize" => Some(Op::Resize),
            "pdf_merge" => Some(Op::PdfMerge),
            "pdf_split" => Some(Op::PdfSplit),
            "pdf_pages" => Some(Op::PdfPages),
            "images_to_pdf" => Some(Op::ImagesToPdf),
            "pdf_to_images" => Some(Op::PdfToImages),
            "office_to_pdf" => Some(Op::OfficeToPdf),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Op::Compress => "compress",
            Op::Extract => "extract",
            Op::Convert => "convert",
            Op::Resize => "resize",
            Op::PdfMerge => "pdf_merge",
            Op::PdfSplit => "pdf_split",
            Op::PdfPages => "pdf_pages",
            Op::ImagesToPdf => "images_to_pdf",
            Op::PdfToImages => "pdf_to_images",
            Op::OfficeToPdf => "office_to_pdf",
        }
    }
    fn core_type(self) -> &'static str {
        match self {
            Op::Compress => "compress",
            Op::Extract => "extract",
            Op::Convert => "convert_image",
            Op::Resize => "resize_image",
            Op::PdfMerge => "pdf_merge",
            Op::PdfSplit => "pdf_split",
            Op::PdfPages => "pdf_pages",
            Op::ImagesToPdf => "images_to_pdf",
            Op::PdfToImages => "pdf_to_images",
            Op::OfficeToPdf => "office_to_pdf",
        }
    }
}

/// Build the typed core operation from the options JSON, then clamp what the
/// server controls. Shared by job creation and preview so they cannot disagree.
fn build_operation(st: &AppState, op: Op, options: Option<&str>) -> Result<Operation, ApiError> {
    let mut opts: serde_json::Value = match options.map(str::trim).filter(|s| !s.is_empty()) {
        None => serde_json::json!({}),
        Some(s) => serde_json::from_str(s).map_err(|_| ApiError::invalid("options must be valid JSON."))?,
    };
    let obj = opts.as_object_mut().ok_or_else(|| ApiError::invalid("options must be a JSON object."))?;
    obj.insert("type".into(), op.core_type().into());
    let mut operation: Operation = serde_json::from_value(opts).map_err(|e| ApiError::invalid(format!("Invalid options: {e}")))?;
    match &mut operation {
        Operation::Extract(o) => o.max_total_bytes = Some(o.max_total_bytes.unwrap_or(u64::MAX).min(st.cfg.max_extract_bytes)),
        Operation::Compress(o) => o.include_folders = true, // folders arrive as relative paths
        Operation::ConvertImage(_)
        | Operation::ResizeImage(_)
        | Operation::PdfMerge(_)
        | Operation::PdfSplit(_)
        | Operation::PdfPages(_)
        | Operation::ImagesToPdf(_)
        | Operation::PdfToImages(_)
        | Operation::OfficeToPdf(_) => {}
    }
    Ok(operation)
}

fn head_descriptor(original: &str, stored: &str, head: &[u8]) -> FileDescriptor {
    FileDescriptor {
        name: if original.is_empty() { stored.to_string() } else { original.to_string() },
        size: 0,
        format: formats::detect(head).map(String::from),
    }
}

/// The client's file name is display metadata. What we store is a validated
/// bare name inside a random per-file directory.
fn stored_name(original: &str, index: usize) -> String {
    let base = original.rsplit(['/', '\\']).next().unwrap_or("");
    file_core::fs_safe::safe_file_name(base).unwrap_or_else(|_| format!("file-{index}"))
}

pub async fn create_job(State(st): State<AppState>, Extension(who): Extension<Principal>, mut mp: Multipart) -> Result<(StatusCode, HeaderMap, Json<CreateJobResponse>), ApiError> {
    let limits = st.cfg.limits_for(&who);
    // Everything that can say "no" because of who is asking comes before a byte is stored.
    let owner_active = st.store.count_active(|r| r.owner == who.id);
    let ip_active = who.ip.map_or(0, |ip| st.store.count_active(|r| r.ip == Some(ip)));
    let admission = st.quota.admit(&who, &limits, owner_active, ip_active, true)?;
    let _slot = st.store.reserve().ok_or_else(|| {
        ApiError::new(StatusCode::TOO_MANY_REQUESTS, "TOO_MANY_JOBS", "Too many jobs are waiting. Try again shortly.")
    })?;

    let id = format!("job_{}", uuid::Uuid::new_v4().simple());
    let dir = st.cfg.data_dir.join(&id);
    let inputs_dir = dir.join("inputs");
    let outputs_dir = dir.join("outputs");
    tokio::fs::create_dir_all(&inputs_dir).await.map_err(ApiError::internal)?;
    tokio::fs::create_dir_all(&outputs_dir).await.map_err(ApiError::internal)?;
    let mut guard = DirGuard(Some(dir.clone()));

    let mut op: Option<Op> = None;
    let mut options: Option<String> = None;
    let mut operation: Option<Operation> = None;
    let mut inputs: Vec<PathBuf> = vec![];
    let mut display_names = std::collections::HashMap::new();
    let mut total: u64 = 0;
    let mut count: usize = 0;
    let tree_dir = inputs_dir.join("tree");

    while let Some(mut field) = mp.next_field().await.map_err(multipart_err)? {
        match field.name().unwrap_or("") {
            "operation" => {
                let v = read_text(field, 32).await?;
                op = Some(Op::parse(&v).ok_or_else(|| ApiError::invalid("operation must be one of compress, extract, convert, pdf_merge, pdf_split, pdf_pages, images_to_pdf, pdf_to_images or office_to_pdf."))?);
            }
            "options" => {
                if op.is_none() {
                    return Err(ApiError::invalid("Send `operation` before `options` and `files`."));
                }
                options = Some(read_text(field, 64 * 1024).await?);
            }
            "files" => {
                let op = op.ok_or_else(|| ApiError::invalid("Send `operation` and `options` before `files`."))?;
                if count >= limits.max_files {
                    return Err(ApiError::too_large(format!("At most {} files per job.", limits.max_files)));
                }
                // Options are known by now: reject bad options, a missing engine or a
                // wrong file type before any bytes are stored.
                if operation.is_none() {
                    operation = Some(build_operation(&st, op, options.as_deref())?);
                }
                let engine = st.registry.engine_for(op.core_type())?;
                let op_ref = operation.as_ref().expect("built above");
                let index = count;
                count += 1;
                let original = field.file_name().unwrap_or("").to_string();
                let (path, name) = if op == Op::Compress {
                    // Keep the client's folder structure, but only as a validated
                    // relative path under this job's own tree.
                    let rel = file_core::fs_safe::safe_relative_path(&original).unwrap_or_else(|_| PathBuf::from(format!("file-{index}")));
                    let mut p = tree_dir.join(&rel);
                    if std::fs::symlink_metadata(&p).is_ok() {
                        p = file_core::fs_safe::unique_path(&p);
                    }
                    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    (p, name)
                } else {
                    let name = stored_name(&original, index);
                    (inputs_dir.join(index.to_string()).join(&name), name)
                };
                let parent = path.parent().unwrap_or(&inputs_dir).to_path_buf();
                tokio::fs::create_dir_all(&parent)
                    .await
                    .map_err(|_| ApiError::invalid("Two uploaded paths conflict with each other."))?;
                let mut out = tokio::fs::File::create(&path).await.map_err(ApiError::internal)?;

                let mut head: Vec<u8> = Vec::with_capacity(16);
                let mut head_checked = false;
                let mut size: u64 = 0;
                while let Some(chunk) = field.chunk().await.map_err(multipart_err)? {
                    size += chunk.len() as u64;
                    total += chunk.len() as u64;
                    if size > limits.max_file_bytes {
                        return Err(ApiError::too_large(format!("A file is larger than the {} limit for one file.", mb(limits.max_file_bytes))));
                    }
                    if total > limits.max_request_bytes {
                        return Err(ApiError::too_large(format!("These files together are larger than the {} limit for one job.", mb(limits.max_request_bytes))));
                    }
                    admission.add_bytes(chunk.len() as u64)?;
                    if !head_checked {
                        head.extend_from_slice(&chunk[..chunk.len().min(16 - head.len())]);
                        if head.len() >= 16 {
                            head_checked = true;
                            engine.preflight(op_ref, &[head_descriptor(&original, &name, &head)], true)?;
                        }
                    }
                    out.write_all(&chunk).await.map_err(ApiError::internal)?;
                }
                out.flush().await.map_err(ApiError::internal)?;
                if !head_checked {
                    engine.preflight(op_ref, &[head_descriptor(&original, &name, &head)], true)?;
                }
                if !original.is_empty() && original != name {
                    display_names.insert(name.clone(), original);
                }
                if op != Op::Compress {
                    inputs.push(path);
                }
            }
            _ => return Err(ApiError::invalid("Unknown form field.")),
        }
    }

    let op = op.ok_or_else(|| ApiError::invalid("operation is required."))?;
    if count == 0 {
        return Err(ApiError::invalid("Upload at least one file."));
    }
    if op == Op::Compress {
        // Top-level files and folders of the uploaded tree become the archive's roots.
        let mut tops: Vec<PathBuf> = std::fs::read_dir(&tree_dir).map_err(ApiError::internal)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        tops.sort();
        inputs = tops;
    }

    let operation = operation.ok_or_else(|| ApiError::invalid("Upload at least one file."))?;

    let request = JobRequest { inputs, output_dir: outputs_dir.clone(), conflict: ConflictPolicy::Rename, operation };

    let record = Arc::new(JobRecord {
        id: id.clone(),
        owner: who.id.clone(),
        ip: who.ip,
        operation: op.name(),
        dir: dir.clone(),
        core_id: Default::default(),
        finished_at: Default::default(),
        display_names,
        bundle: Default::default(),
    });

    let core = st.store.core.clone();
    let rec = record.clone();
    let core_id = tokio::task::spawn_blocking(move || {
        core.start(request, move |s: &JobStatus| {
            if s.status.is_finished() {
                let mut f = rec.finished_at.lock().unwrap();
                if f.is_none() {
                    *f = Some(Instant::now());
                    // Private inputs are not needed any more; drop them right away.
                    let _ = std::fs::remove_dir_all(rec.inputs_dir());
                }
            }
        })
    })
    .await
    .map_err(ApiError::internal)??;

    let _ = record.core_id.set(core_id);
    st.store.insert(record);
    guard.disarm();

    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("/api/v1/jobs/{id}")) {
        headers.insert(header::LOCATION, v);
    }
    Ok((StatusCode::ACCEPTED, headers, Json(CreateJobResponse { job_id: id, status: WireStatus::Queued })))
}

/// The job, if it exists and belongs to `who`. Someone else's job is indistinguishable from a missing one.
fn lookup(st: &AppState, id: &str, who: &Principal) -> Result<(Arc<JobRecord>, JobStatus), ApiError> {
    let rec = st.store.get(id).filter(|r| r.owner == who.id).ok_or_else(ApiError::job_not_found)?;
    let status = st.store.core_status(&rec).ok_or_else(ApiError::job_not_found)?;
    Ok((rec, status))
}

pub async fn get_job(State(st): State<AppState>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<Json<JobResponse>, ApiError> {
    let (rec, s) = lookup(&st, &id, &who)?;
    Ok(Json(to_response(&rec, &s)))
}

pub async fn cancel_job(State(st): State<AppState>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<Json<JobResponse>, ApiError> {
    let (rec, s) = lookup(&st, &id, &who)?;
    if s.status.is_finished() {
        return Err(ApiError::conflict("JOB_FINISHED", "This job has already finished, so it can't be cancelled."));
    }
    st.store.core.cancel(rec.core_id.get().map(String::as_str).unwrap_or_default())?;
    let s = st.store.core_status(&rec).unwrap_or(s);
    Ok(Json(to_response(&rec, &s)))
}

// ------------------------------------------------------------------ results

fn completed(st: &AppState, id: &str, who: &Principal) -> Result<Arc<JobRecord>, ApiError> {
    let (rec, s) = lookup(st, id, who)?;
    finished_ok(rec, &s)
}

/// Fail unless the job is the caller's and has finished successfully.
pub(crate) fn ensure_completed(st: &AppState, id: &str, who: &Principal) -> Result<(), ApiError> {
    completed(st, id, who).map(|_| ())
}

fn finished_ok(rec: Arc<JobRecord>, s: &JobStatus) -> Result<Arc<JobRecord>, ApiError> {
    if s.status != JobState::Completed {
        return Err(ApiError::conflict("JOB_NOT_COMPLETED", "This job has no result (yet)."));
    }
    Ok(rec)
}

/// A finished job by id alone. Only for requests that carry a valid signed link, which is the proof of access.
pub(crate) fn completed_by_link(st: &AppState, id: &str) -> Result<Arc<JobRecord>, ApiError> {
    let rec = st.store.get(id).ok_or_else(ApiError::job_not_found)?;
    let s = st.store.core_status(&rec).ok_or_else(ApiError::job_not_found)?;
    finished_ok(rec, &s)
}

struct Listing {
    files: Vec<(String, PathBuf, u64)>,
    dirs: Vec<String>,
}

fn walk(root: &std::path::Path, rel: &str, out: &mut Listing) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(root)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(".filetool-") {
            continue; // in-progress temp file
        }
        let rel_path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        let ft = e.file_type()?;
        if ft.is_dir() {
            out.dirs.push(rel_path.clone());
            walk(&e.path(), &rel_path, out)?;
        } else if ft.is_file() {
            out.files.push((rel_path, e.path(), e.metadata()?.len()));
        } // symlinks are never served
    }
    Ok(())
}

async fn list_outputs(rec: &JobRecord) -> Result<Listing, ApiError> {
    let dir = rec.outputs_dir();
    tokio::task::spawn_blocking(move || {
        let mut l = Listing { files: vec![], dirs: vec![] };
        walk(&dir, "", &mut l).map(|_| l)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(ApiError::internal)
}

pub async fn list_result(State(st): State<AppState>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<Json<ResultManifest>, ApiError> {
    let rec = completed(&st, &id, &who)?;
    let l = list_outputs(&rec).await?;
    Ok(Json(ResultManifest {
        files: l.files.iter().enumerate().map(|(i, (p, _, s))| ResultFile { index: i, path: p.clone(), size: *s }).collect(),
        directories: l.dirs,
    }))
}

pub async fn get_result_file(State(st): State<AppState>, Extension(who): Extension<Principal>, Path((id, index)): Path<(String, usize)>) -> Result<Response, ApiError> {
    let rec = completed(&st, &id, &who)?;
    file_response(&rec, index).await
}

pub(crate) async fn file_response(rec: &JobRecord, index: usize) -> Result<Response, ApiError> {
    let l = list_outputs(rec).await?;
    let (rel, path, _) = l.files.get(index).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "FILE_NOT_FOUND", "No such result file."))?;
    let name = rel.rsplit('/').next().unwrap_or("result");
    serve(path, name, "application/octet-stream").await
}

/// One file -> that file. Anything else -> a ZIP bundle built on first request.
pub async fn get_result(State(st): State<AppState>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let rec = completed(&st, &id, &who)?;
    bundle_response(&rec).await
}

pub(crate) async fn bundle_response(rec: &JobRecord) -> Result<Response, ApiError> {
    let l = list_outputs(rec).await?;
    if l.files.is_empty() {
        return Err(ApiError::conflict("JOB_NO_OUTPUT", "The job finished without producing any files."));
    }
    if l.files.len() == 1 && l.dirs.is_empty() {
        let (rel, path, _) = &l.files[0];
        return serve(path, rel, "application/octet-stream").await;
    }

    let mut bundle = rec.bundle.lock().await;
    if bundle.is_none() {
        let outputs = rec.outputs_dir();
        let out_dir = rec.dir.join("bundle");
        let built = tokio::task::spawn_blocking(move || -> file_core::Result<PathBuf> {
            std::fs::create_dir_all(&out_dir)?;
            let tops: Vec<PathBuf> = std::fs::read_dir(&outputs)?
                .filter_map(|e| e.ok())
                .filter(|e| !e.file_name().to_string_lossy().starts_with(".filetool-"))
                .map(|e| e.path())
                .collect();
            let ctx = file_core::JobContext::silent();
            file_core::archive::compress(&tops, &out_dir, Some("result"), true, ConflictPolicy::Rename, &ctx)?;
            Ok(out_dir.join("result.zip"))
        })
        .await
        .map_err(ApiError::internal)??;
        *bundle = Some(built);
    }
    let path = bundle.clone().unwrap();
    drop(bundle);
    serve(&path, "result.zip", "application/zip").await
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn serve(path: &std::path::Path, name: &str, content_type: &'static str) -> Result<Response, ApiError> {
    // Only ever a fixed allow-list of types, never something derived from file content.
    let content_type = match name.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("zip") => "application/zip",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => content_type,
    };
    let file = tokio::fs::File::open(path).await.map_err(ApiError::internal)?;
    let len = file.metadata().await.map_err(ApiError::internal)?.len();
    let ascii: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' }).collect();
    let disposition = format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{}", percent_encode(name));
    let mut res = Response::new(Body::from_stream(ReaderStream::new(file)));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

// -------------------------------------------------------------- capabilities, preview

pub async fn capabilities(State(st): State<AppState>, Extension(who): Extension<Principal>) -> Json<file_core::Capabilities> {
    let limits = st.cfg.limits_for(&who);
    let mut caps = st.registry.capabilities();
    caps.limits.max_file_bytes = Some(limits.max_file_bytes);
    caps.limits.max_request_bytes = Some(limits.max_request_bytes);
    caps.limits.max_files = Some(limits.max_files as u64);
    caps.limits.max_concurrent_jobs = Some(st.cfg.max_concurrent_processing as u64);
    caps.limits.retention_seconds = Some(st.cfg.retention.as_secs());
    Json(caps)
}

fn issue(code: &str, message: String, file: Option<&str>) -> PreviewIssue {
    PreviewIssue { code: code.to_uppercase(), message, file: file.map(String::from) }
}

/// Validate a request from file descriptions alone (names, sizes, first bytes),
/// so a client can find out a conversion is impossible before uploading gigabytes.
pub async fn preview(
    State(st): State<AppState>,
    Extension(who): Extension<Principal>,
    body: Result<Json<PreviewRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<PreviewResponse>, ApiError> {
    let Json(req) = body.map_err(|_| ApiError::invalid("The preview request must be JSON with operation, options and files."))?;
    let op = Op::parse(&req.operation).ok_or_else(|| ApiError::invalid("operation must be one of compress, extract, convert, pdf_merge, pdf_split, pdf_pages, images_to_pdf, pdf_to_images or office_to_pdf."))?;
    let options = if req.options.is_null() { None } else { Some(req.options.to_string()) };
    let mut out = PreviewResponse { ok: true, operation: op.name().into(), engine: None, errors: vec![], warnings: vec![] };

    if req.files.is_empty() {
        out.errors.push(issue("invalid_request", "Add at least one file.".into(), None));
    }
    let limits = st.cfg.limits_for(&who);
    if req.files.len() as u64 > limits.max_files as u64 {
        out.errors.push(issue("payload_too_large", format!("At most {} files per job.", limits.max_files), None));
    }
    let total: u64 = req.files.iter().map(|f| f.size).sum();
    if total > limits.max_request_bytes {
        out.errors.push(issue("payload_too_large", format!("These files together are larger than the {} limit for one job.", mb(limits.max_request_bytes)), None));
    }
    for f in req.files.iter().filter(|f| f.size > limits.max_file_bytes) {
        out.errors.push(issue("payload_too_large", format!("This file is larger than the {} limit for one file.", mb(limits.max_file_bytes)), Some(&f.name)));
    }

    let engine = match st.registry.engine_for(op.core_type()) {
        Ok(e) => e,
        Err(e) => {
            out.errors.push(issue(e.code(), e.user_message(), None));
            out.ok = false;
            return Ok(Json(out));
        }
    };
    let info = engine.info();
    out.engine = Some(PreviewEngine { id: info.id, version: info.version });

    match build_operation(&st, op, options.as_deref()) {
        Err(e) => out.errors.push(issue("invalid_options", e.message, None)),
        Ok(operation) => {
            // Option problems are reported once, not once per file.
            let option_problem = engine.preflight(&operation, &[], true).err().map(|e| (e.code(), e.user_message()));
            if let Some((code, message)) = &option_problem {
                out.errors.push(issue(code, message.clone(), None));
            }
            let mut seen_pairs = Vec::new();
            for f in &req.files {
                let head = formats::hex_decode(&f.head_hex).unwrap_or_default();
                let format = formats::detect(&head).map(String::from);
                let desc = FileDescriptor { name: f.name.clone(), size: f.size, format: format.clone() };
                if let Err(e) = engine.preflight(&operation, &[desc], true) {
                    if option_problem.as_ref() != Some(&(e.code(), e.user_message())) {
                        out.errors.push(issue(e.code(), e.user_message(), Some(&f.name)));
                    }
                } else if let (Operation::ConvertImage(o) | Operation::ResizeImage(o), Some(from)) = (&operation, format) {
                    // what the user should know about exactly this conversion
                    let to = o.format.fixed().map(|f| f.id().to_string()).unwrap_or_else(|| from.clone());
                    // Resizing in the same format is the point of that tool, not something to explain.
                    let resizing_in_place = matches!(operation, Operation::ResizeImage(_)) && to == from;
                    if !resizing_in_place && !seen_pairs.contains(&(from.clone(), to.clone())) {
                        if let Some(p) = st.registry.operation(op.core_type()).and_then(|s| s.pairs.into_iter().find(|p| p.from == from && p.to == to)) {
                            out.warnings.extend(p.notes);
                        }
                        seen_pairs.push((from, to));
                    }
                }
            }
        }
    }
    out.ok = out.errors.is_empty();
    Ok(Json(out))
}
