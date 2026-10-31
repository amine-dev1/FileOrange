use serde_json::json;
use file_api::types::*;
use file_api::{start, start_with, ApiConfig, RunningServer};
use reqwest::{multipart, Client, StatusCode};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

struct Env {
    server: RunningServer,
    http: Client,
    root: tempfile::TempDir,
}

impl Env {
    async fn new() -> Self {
        Self::with(|_| {}).await
    }
    async fn with(tweak: impl FnOnce(&mut ApiConfig)) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = ApiConfig::local(root.path().join("jobs"));
        cfg.sweep_interval = Duration::from_millis(100);
        tweak(&mut cfg);
        let server = start(cfg).await.unwrap();
        Env { server, http: Client::new(), root }
    }
    async fn with_registry(registry: std::sync::Arc<file_core::Registry>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = ApiConfig::local(root.path().join("jobs"));
        cfg.sweep_interval = Duration::from_millis(100);
        let server = start_with(cfg, registry).await.unwrap();
        Env { server, http: Client::new(), root }
    }
    fn url(&self, p: &str) -> String {
        format!("{}{p}", self.server.base_url())
    }
    fn auth(&self) -> String {
        format!("Bearer {}", self.server.token)
    }
    fn jobs_dir(&self) -> std::path::PathBuf {
        self.root.path().join("jobs")
    }
    fn job_dirs(&self) -> Vec<String> {
        std::fs::read_dir(self.jobs_dir()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
    }

    async fn post(&self, op: &str, options: Option<&str>, files: Vec<(&str, Vec<u8>)>) -> reqwest::Response {
        let mut form = multipart::Form::new().text("operation", op.to_string());
        if let Some(o) = options {
            form = form.text("options", o.to_string());
        }
        for (name, bytes) in files {
            form = form.part("files", multipart::Part::bytes(bytes).file_name(name.to_string()));
        }
        self.http.post(self.url("/api/v1/jobs")).header("authorization", self.auth()).multipart(form).send().await.unwrap()
    }

    async fn create(&self, op: &str, options: Option<&str>, files: Vec<(&str, Vec<u8>)>) -> String {
        let r = self.post(op, options, files).await;
        assert_eq!(r.status(), StatusCode::ACCEPTED, "{:?}", r.text().await);
        let body: CreateJobResponse = r.json().await.unwrap();
        assert_eq!(body.status, WireStatus::Queued);
        assert!(body.job_id.starts_with("job_"));
        body.job_id
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.http.get(self.url(path)).header("authorization", self.auth()).send().await.unwrap()
    }

    async fn wait(&self, id: &str) -> JobResponse {
        let t = Instant::now();
        loop {
            let s: JobResponse = self.get(&format!("/api/v1/jobs/{id}")).await.json().await.unwrap();
            if s.status.is_finished() {
                return s;
            }
            assert!(t.elapsed() < Duration::from_secs(60));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn png_bytes(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([x as u8, y as u8, 99, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (n, d) in entries {
        z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(d).unwrap();
    }
    z.finish().unwrap().into_inner()
}

fn noise(n: usize) -> Vec<u8> {
    let mut x: u64 = 88172645463325252;
    (0..n).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; (x >> 24) as u8 }).collect()
}

fn zip_names(bytes: Vec<u8>) -> Vec<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect()
}

fn has_part_files(dir: &Path) -> bool {
    walk(dir).iter().any(|n| n.ends_with(".part"))
}
fn walk(p: &Path) -> Vec<String> {
    let mut v = vec![];
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            v.push(e.file_name().to_string_lossy().into_owned());
            if e.path().is_dir() { v.extend(walk(&e.path())); }
        }
    }
    v
}

// ------------------------------------------------------------- basics/auth

#[tokio::test]
async fn health_is_open_and_minimal() {
    let e = Env::new().await;
    let r = e.http.get(e.url("/health")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().contains_key("x-request-id"));
    let text = r.text().await.unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 2, "only status + version: {text}");
    assert!(!text.contains(&e.server.token));
    assert!(!text.contains("jobs"));
}

#[tokio::test]
async fn requests_without_valid_token_are_rejected_with_json_error() {
    let e = Env::new().await;
    for auth in [None, Some("Bearer wrong".to_string()), Some(e.server.token.clone()), Some("Basic abc".into())] {
        let mut r = e.http.get(e.url("/api/v1/jobs/job_x"));
        if let Some(a) = auth { r = r.header("authorization", a); }
        let r = r.send().await.unwrap();
        assert_eq!(r.status(), 401);
        let b: ErrorBody = r.json().await.unwrap();
        assert_eq!(b.error.code, "UNAUTHORIZED");
        assert!(b.error.request_id.starts_with("req_"));
    }
    // upload endpoint is protected too, and nothing is stored
    let r = e.http.post(e.url("/api/v1/jobs")).multipart(multipart::Form::new().text("operation", "compress")).send().await.unwrap();
    assert_eq!(r.status(), 401);
    assert!(e.job_dirs().is_empty());
}

#[tokio::test]
async fn browser_origins_and_foreign_hosts_are_refused() {
    let e = Env::new().await;
    let r = e.http.get(e.url("/health")).header("origin", "https://evil.example").send().await.unwrap();
    assert_eq!(r.status(), 403);
    let b: ErrorBody = r.json().await.unwrap();
    assert_eq!(b.error.code, "FORBIDDEN_ORIGIN");
    let r = e.http.get(e.url("/health")).header("host", "evil.example").send().await.unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(e.http.get(e.url("/health")).header("host", format!("localhost:{}", e.server.addr.port())).send().await.unwrap().status(), 200);
}

#[tokio::test]
async fn non_loopback_bind_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = ApiConfig::local(dir.path());
    cfg.bind = "0.0.0.0:0".parse().unwrap();
    assert!(start(cfg).await.is_err());
    let mut cfg = ApiConfig::local(dir.path());
    cfg.token = "short".into();
    assert!(start(cfg).await.is_err());
    assert!(!format!("{:?}", ApiConfig::local(dir.path())).contains(&ApiConfig::local(dir.path()).token));
}

#[tokio::test]
async fn unknown_routes_and_methods_return_json_errors() {
    let e = Env::new().await;
    let r = e.get("/api/v1/nope").await;
    assert_eq!(r.status(), 404);
    assert!(r.json::<ErrorBody>().await.is_ok());
    let r = e.http.post(e.url("/health")).send().await.unwrap();
    assert_eq!(r.status(), 405);
    assert!(r.json::<ErrorBody>().await.is_ok());
    let r = e.get("/api/v1/jobs/job_doesnotexist").await;
    assert_eq!(r.status(), 404);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "JOB_NOT_FOUND");
}

// --------------------------------------------------------------- workflows

#[tokio::test]
async fn convert_image_end_to_end() {
    let e = Env::new().await;
    let id = e.create("convert", Some(r#"{"format":"jpeg","quality":80}"#), vec![("holiday photo.png", png_bytes(40, 30))]).await;
    let s = e.wait(&id).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert_eq!(s.progress.percent, 100);
    assert_eq!(s.results[0].input, "holiday photo.png");
    assert_eq!(s.results[0].output.as_deref(), Some("holiday photo.jpg"));

    let r = e.get(&format!("/api/v1/jobs/{id}/result")).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert!(r.headers()["content-disposition"].to_str().unwrap().contains("holiday photo.jpg"));
    let bytes = r.bytes().await.unwrap();
    let img = image::load_from_memory(&bytes).unwrap();
    assert_eq!((img.width(), img.height()), (40, 30));
    assert_eq!(image::guess_format(&bytes).unwrap(), image::ImageFormat::Jpeg);

    // private inputs are deleted as soon as the job finishes
    let job_dir = e.jobs_dir().join(&id);
    assert!(!job_dir.join("inputs").exists());
}

#[tokio::test]
async fn compress_multiple_files_returns_one_zip() {
    let e = Env::new().await;
    let id = e.create("compress", Some(r#"{"archive_name":"stuff"}"#), vec![("a.txt", b"alpha".to_vec()), ("a.txt", b"beta".to_vec()), ("b.bin", noise(50_000))]).await;
    let s = e.wait(&id).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    let r = e.get(&format!("/api/v1/jobs/{id}/result")).await;
    assert_eq!(r.headers()["content-type"], "application/zip");
    let mut names = zip_names(r.bytes().await.unwrap().to_vec());
    names.sort();
    assert_eq!(names, vec!["a (1).txt", "a.txt", "b.bin"]);
}

#[tokio::test]
async fn extract_returns_manifest_and_individual_files_or_a_bundle() {
    let e = Env::new().await;
    let z = zip_bytes(&[("docs/readme.txt", b"hello"), ("top.txt", b"top"), ("deep/er/x.bin", b"xx")]);
    let id = e.create("extract", Some(r#"{"subfolder":false}"#), vec![("pack.zip", z)]).await;
    let s = e.wait(&id).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");

    let m: ResultManifest = e.get(&format!("/api/v1/jobs/{id}/result/files")).await.json().await.unwrap();
    let paths: Vec<_> = m.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["deep/er/x.bin", "docs/readme.txt", "top.txt"]);
    assert!(m.directories.contains(&"deep/er".to_string()));
    let f = m.files.iter().find(|f| f.path == "docs/readme.txt").unwrap();
    assert_eq!(e.get(&format!("/api/v1/jobs/{id}/result/files/{}", f.index)).await.bytes().await.unwrap().as_ref(), b"hello");
    assert_eq!(e.get(&format!("/api/v1/jobs/{id}/result/files/99")).await.status(), 404);

    let bundle = e.get(&format!("/api/v1/jobs/{id}/result")).await.bytes().await.unwrap().to_vec();
    let names = zip_names(bundle);
    assert!(names.contains(&"docs/readme.txt".to_string()) && names.contains(&"top.txt".to_string()));
}

#[tokio::test]
async fn malicious_archive_is_reported_and_writes_nothing_outside_the_job() {
    let e = Env::new().await;
    let z = zip_bytes(&[("../../escape.txt", b"pwned"), ("ok.txt", b"ok")]);
    let id = e.create("extract", None, vec![("evil.zip", z)]).await;
    let s = e.wait(&id).await;
    assert_eq!(s.status, WireStatus::Failed);
    assert_eq!(s.results[0].error_code.as_deref(), Some("UNSAFE_ENTRY"));
    assert_eq!(s.error.as_ref().unwrap().code, "ALL_FAILED");
    assert!(!e.root.path().join("escape.txt").exists());
    assert!(!e.jobs_dir().join("escape.txt").exists());
    assert!(!walk(e.root.path()).contains(&"escape.txt".to_string()));
    // a failed job has no result
    let r = e.get(&format!("/api/v1/jobs/{id}/result")).await;
    assert_eq!(r.status(), 409);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "JOB_NOT_COMPLETED");
    // error text never leaks server paths
    let text = serde_json::to_string(&s).unwrap();
    assert!(!text.contains(e.root.path().to_str().unwrap()), "{text}");
}

#[tokio::test]
async fn bad_files_in_a_batch_are_reported_individually() {
    let e = Env::new().await;
    let good = png_bytes(8, 8);
    let truncated = good[..good.len() / 2].to_vec();
    // magic bytes are valid but data is cut off: passes the type check, fails in the decoder
    let id = e.create("convert", Some(r#"{"format":"png"}"#), vec![("good.png", good), ("cut.png", truncated)]).await;
    let s = e.wait(&id).await;
    assert_eq!(s.status, WireStatus::Completed);
    assert_eq!(s.results.len(), 2);
    assert_eq!(s.results[0].outcome, WireOutcome::Done);
    assert_eq!(s.results[1].outcome, WireOutcome::Failed);
    assert_eq!(s.results[1].error_code.as_deref(), Some("CORRUPT_IMAGE"));
}

#[tokio::test]
async fn hostile_upload_filenames_cannot_escape_the_job_directory() {
    let e = Env::new().await;
    let id = e.create("convert", Some(r#"{"format":"png"}"#), vec![("../../../evil.png", png_bytes(4, 4)), ("C:\\Windows\\x.png", png_bytes(4, 4))]).await;
    let s = e.wait(&id).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert!(!e.root.path().join("evil.png").exists());
    assert!(!e.root.path().parent().unwrap().join("evil.png").exists());
    assert_eq!(s.results[0].input, "../../../evil.png", "original kept as display metadata");
    let m: ResultManifest = e.get(&format!("/api/v1/jobs/{id}/result/files")).await.json().await.unwrap();
    assert!(m.files.iter().all(|f| !f.path.contains("..") && !f.path.contains(':')));
}

// ------------------------------------------------------------ validation

#[tokio::test]
async fn invalid_requests_get_400_and_leave_nothing_behind() {
    let e = Env::new().await;
    let png = || vec![("a.png", png_bytes(4, 4))];
    let cases: Vec<(&str, Option<&str>, Vec<(&str, Vec<u8>)>)> = vec![
        ("explode", None, png()),                                  // unknown operation
        ("convert", Some(r#"{"quality":50}"#), png()),             // missing format
        ("convert", Some(r#"{"format":"jpeg","quality":0}"#), png()),
        ("convert", Some("not json"), png()),
        ("convert", Some("[1,2]"), png()),
        ("compress", Some(r#"{"archive_name":"../x"}"#), vec![("a.txt", vec![1])]),
        ("compress", None, vec![]),                                // no files
    ];
    for (op, opts, files) in cases {
        let r = e.post(op, opts, files).await;
        assert_eq!(r.status(), 400, "{op} {opts:?}");
        let b: ErrorBody = r.json().await.unwrap();
        assert_eq!(b.error.code, "INVALID_REQUEST");
    }
    // wrong field order
    let form = multipart::Form::new().part("files", multipart::Part::bytes(vec![1]).file_name("a")).text("operation", "compress");
    let r = e.http.post(e.url("/api/v1/jobs")).header("authorization", e.auth()).multipart(form).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // not multipart at all
    let r = e.http.post(e.url("/api/v1/jobs")).header("authorization", e.auth()).body("hi").send().await.unwrap();
    assert!(r.status().is_client_error());
    assert!(r.json::<ErrorBody>().await.is_ok());
    assert!(e.job_dirs().is_empty(), "{:?}", e.job_dirs());
}

#[tokio::test]
async fn unsupported_file_types_get_415() {
    let e = Env::new().await;
    let r = e.post("convert", Some(r#"{"format":"png"}"#), vec![("notes.png", b"definitely not an image, just text".to_vec())]).await;
    assert_eq!(r.status(), 415);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "UNSUPPORTED_FORMAT");
    let r = e.post("convert", Some(r#"{"format":"png"}"#), vec![("tiny", b"hi".to_vec())]).await;
    assert_eq!(r.status(), 415, "short files are checked too");
    let r = e.post("extract", None, vec![("x.zip", png_bytes(8, 8))]).await;
    assert_eq!(r.status(), 415);
    assert!(e.job_dirs().is_empty());
}

#[tokio::test]
async fn oversized_uploads_get_413_and_are_cleaned_up() {
    let e = Env::with(|c| { c.max_file_bytes = 100_000; c.max_request_bytes = 150_000; c.max_files = 2 }).await;
    let r = e.post("compress", None, vec![("big.bin", noise(200_000))]).await;
    assert_eq!(r.status(), 413);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "PAYLOAD_TOO_LARGE");
    let r = e.post("compress", None, vec![("a", noise(90_000)), ("b", noise(90_000))]).await;
    assert_eq!(r.status(), 413, "request total limit");
    let r = e.post("compress", None, vec![("a", vec![1]), ("b", vec![1]), ("c", vec![1])]).await;
    assert_eq!(r.status(), 413, "file count limit");
    assert!(e.job_dirs().is_empty(), "{:?}", e.job_dirs());
}

#[tokio::test]
async fn job_capacity_is_enforced() {
    let e = Env::with(|c| c.max_stored_jobs = 1).await;
    e.create("compress", None, vec![("a", vec![1])]).await;
    let r = e.post("compress", None, vec![("a", vec![1])]).await;
    assert_eq!(r.status(), 429);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "TOO_MANY_JOBS");
}

// ------------------------------------------------ cancel & cleanup lifecycle

#[tokio::test]
async fn cancel_queued_job_then_conflict_on_finished_job() {
    let e = Env::with(|c| c.max_concurrent_processing = 1).await;
    let first = e.create("compress", None, vec![("big.bin", noise(12_000_000))]).await;
    let second = e.create("compress", None, vec![("small", b"x".to_vec())]).await;

    let r = e.http.delete(e.url(&format!("/api/v1/jobs/{second}"))).header("authorization", e.auth()).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let s = e.wait(&second).await;
    assert_eq!(s.status, WireStatus::Cancelled);
    assert_eq!(e.get(&format!("/api/v1/jobs/{second}/result")).await.status(), 409);

    // cancelling something that already finished is a 409
    assert_eq!(e.wait(&first).await.status, WireStatus::Completed);
    let r = e.http.delete(e.url(&format!("/api/v1/jobs/{first}"))).header("authorization", e.auth()).send().await.unwrap();
    assert_eq!(r.status(), 409);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "JOB_FINISHED");
    let r = e.http.delete(e.url("/api/v1/jobs/job_nope")).header("authorization", e.auth()).send().await.unwrap();
    assert_eq!(r.status(), 404);
}

#[tokio::test]
async fn cancelling_a_running_job_leaves_no_partial_output() {
    let e = Env::new().await;
    let files: Vec<_> = (0..6).map(|i| (Box::leak(format!("f{i}.bin").into_boxed_str()) as &str, noise(3_000_000))).collect();
    let id = e.create("compress", None, files).await;
    // wait until it is actually running, then cancel
    let t = Instant::now();
    loop {
        let s: JobResponse = e.get(&format!("/api/v1/jobs/{id}")).await.json().await.unwrap();
        if s.status != WireStatus::Queued { break; }
        assert!(t.elapsed() < Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let _ = e.http.delete(e.url(&format!("/api/v1/jobs/{id}"))).header("authorization", e.auth()).send().await.unwrap();
    let s = e.wait(&id).await;
    assert!(matches!(s.status, WireStatus::Cancelled | WireStatus::Completed));
    if s.status == WireStatus::Cancelled {
        assert!(walk(&e.jobs_dir().join(&id).join("outputs")).is_empty());
    }
    assert!(!has_part_files(&e.jobs_dir()));
}

#[tokio::test]
async fn finished_jobs_are_deleted_after_retention() {
    let e = Env::with(|c| c.retention = Duration::from_millis(300)).await;
    let id = e.create("compress", None, vec![("a.txt", b"hello".to_vec())]).await;
    assert_eq!(e.wait(&id).await.status, WireStatus::Completed);
    assert!(e.jobs_dir().join(&id).exists());
    let t = Instant::now();
    while e.jobs_dir().join(&id).exists() {
        assert!(t.elapsed() < Duration::from_secs(5), "job directory not cleaned up");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(e.get(&format!("/api/v1/jobs/{id}")).await.status(), 404);
    assert_eq!(e.get(&format!("/api/v1/jobs/{id}/result")).await.status(), 404);
}

#[tokio::test]
async fn shutdown_deletes_all_job_data_and_stale_dirs_are_cleaned_on_start() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("jobs");
    std::fs::create_dir_all(data.join("job_stale/inputs")).unwrap();
    std::fs::write(data.join("job_stale/inputs/secret.txt"), "private").unwrap();
    std::fs::write(data.join("keep.me"), "not ours").unwrap();

    let server = start(ApiConfig::local(&data)).await.unwrap();
    assert!(!data.join("job_stale").exists(), "stale job data from a crashed run is removed");
    assert!(data.join("keep.me").exists(), "files that aren't job_* are left alone");

    let http = Client::new();
    let form = multipart::Form::new().text("operation", "compress").part("files", multipart::Part::bytes(b"data".to_vec()).file_name("a.txt"));
    let r = http.post(format!("{}/api/v1/jobs", server.base_url())).bearer_auth(&server.token).multipart(form).send().await.unwrap();
    assert_eq!(r.status(), 202);
    let url = server.base_url();
    server.shutdown().await;
    assert!(std::fs::read_dir(&data).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with("job_")));
    assert!(http.get(format!("{url}/health")).send().await.is_err(), "server stopped listening");
}

#[tokio::test]
async fn compress_preserves_uploaded_folder_structure_safely() {
    let e = Env::new().await;
    let files = vec![
        ("proj/readme.txt", b"r".to_vec()),
        ("proj/src/main.rs", b"fn main(){}".to_vec()),
        ("loose.txt", b"l".to_vec()),
        ("../../escape.txt", b"nope".to_vec()),
        ("proj\\win\\file.txt", b"w".to_vec()),
    ];
    let id = e.create("compress", Some(r#"{"archive_name":"out"}"#), files).await;
    let s = e.wait(&id).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    let mut names = zip_names(e.get(&format!("/api/v1/jobs/{id}/result")).await.bytes().await.unwrap().to_vec());
    names.sort();
    assert!(names.contains(&"proj/readme.txt".to_string()), "{names:?}");
    assert!(names.contains(&"proj/src/main.rs".to_string()));
    assert!(names.contains(&"proj/win/file.txt".to_string()), "backslashes are separators: {names:?}");
    assert!(names.contains(&"loose.txt".to_string()));
    assert!(names.iter().all(|n| !n.contains("..")), "{names:?}");
    assert!(!walk(e.root.path()).contains(&"escape.txt".to_string()) || names.iter().any(|n| n.starts_with("file-")));
}

#[tokio::test]
async fn extract_defaults_to_one_folder_per_archive() {
    let e = Env::new().await;
    let a = zip_bytes(&[("same.txt", b"from a")]);
    let b = zip_bytes(&[("same.txt", b"from b")]);
    let id = e.create("extract", None, vec![("alpha.zip", a), ("beta.zip", b)]).await;
    assert_eq!(e.wait(&id).await.status, WireStatus::Completed);
    let m: ResultManifest = e.get(&format!("/api/v1/jobs/{id}/result/files")).await.json().await.unwrap();
    let paths: Vec<_> = m.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["alpha/same.txt", "beta/same.txt"]);
}

// ======================================================================
// Capabilities, preview, engine availability, lossy WebP
// ======================================================================

use file_core::engine::{Availability, ConversionPair, Engine, EngineInfo, OperationSpec};
use file_core::formats::{self, FileDescriptor, FormatInfo};
use file_core::request::{JobRequest, Operation, Review};

/// A fake "convert images" engine that only knows PNG -> JPEG.
struct FakeConvert {
    availability: Availability,
}

impl Engine for FakeConvert {
    fn info(&self) -> EngineInfo {
        EngineInfo { id: "fake".into(), name: "Fake converter".into(), version: "9.9".into(), availability: self.availability.clone(), license: "MIT".into() }
    }
    fn formats(&self) -> Vec<FormatInfo> {
        vec![]
    }
    fn operations(&self) -> Vec<OperationSpec> {
        vec![OperationSpec {
            interactive: false,
            id: "convert_image".into(),
            label: "Fake".into(),
            description: String::new(),
            inputs: vec!["png".into()],
            outputs: vec!["jpeg".into()],
            pairs: vec![ConversionPair { from: "png".into(), to: "jpeg".into(), notes: vec!["Fake note.".into()] }],
            options: vec![],
        }]
    }
    fn preflight(&self, op: &Operation, files: &[FileDescriptor], strict: bool) -> file_core::Result<()> {
        let Operation::ConvertImage(o) = op else { return Err(file_core::Error::Unsupported("x".into())) };
        for f in files {
            match f.format.as_deref() {
                Some("png") if o.format.id() != "jpeg" => return Err(file_core::Error::UnsupportedConversion { from: "png".into(), to: o.format.id().into() }),
                Some("png") => {}
                _ if strict => return Err(file_core::Error::UnsupportedFormat(f.name.clone())),
                _ => {}
            }
        }
        Ok(())
    }
    fn review(&self, _: &JobRequest) -> file_core::Result<Review> {
        Ok(Review::default())
    }
    fn run(&self, _: &JobRequest, _: &file_core::JobContext) -> file_core::Result<()> {
        Ok(())
    }
}

fn png_head_hex() -> String {
    formats::hex_encode(&png_bytes(4, 4)[..32])
}

async fn post_json(e: &Env, path: &str, body: serde_json::Value) -> reqwest::Response {
    e.http.post(e.url(path)).header("authorization", e.auth()).json(&body).send().await.unwrap()
}

#[tokio::test]
async fn capabilities_report_real_engines_formats_and_server_limits() {
    let e = Env::with(|c| { c.max_files = 7; c.max_file_bytes = 123_456; c.max_concurrent_processing = 3; c.retention = Duration::from_secs(99); }).await;
    assert_eq!(e.http.get(e.url("/api/v1/capabilities")).send().await.unwrap().status(), 401, "capabilities need the token");

    let r = e.get("/api/v1/capabilities").await;
    assert_eq!(r.status(), 200);
    let text = r.text().await.unwrap();
    assert!(!text.contains(&e.server.token), "token never leaks");
    assert!(!text.contains(e.root.path().to_str().unwrap()), "no server paths");
    let caps: file_core::Capabilities = serde_json::from_str(&text).unwrap();

    let ids: Vec<_> = caps.engines.iter().map(|x| x.info.id.as_str()).collect();
    assert_eq!(ids, ["zip", "image", "pdf", "office"]);
    let convert = caps.operations.iter().find(|o| o.spec.id == "convert_image").unwrap();
    assert!(convert.available && convert.spec.pairs.len() == 9);
    for opt in ["webp_mode", "quality", "background", "keep_metadata"] {
        assert!(convert.spec.options.iter().any(|o| o.id == opt), "{opt} option reported");
    }
    assert_eq!(caps.limits.max_files, Some(7));
    assert_eq!(caps.limits.max_file_bytes, Some(123_456));
    assert_eq!(caps.limits.max_concurrent_jobs, Some(3));
    assert_eq!(caps.limits.retention_seconds, Some(99));
    assert!(caps.limits.max_webp_dimension == 16_383 && caps.limits.max_archive_entries > 0);
}

#[tokio::test]
async fn preview_validates_without_uploading() {
    let e = Env::with(|c| { c.max_files = 2; c.max_file_bytes = 1_000_000; }).await;
    let png = png_head_hex();
    let text_head = formats::hex_encode(b"definitely not an image at all..");

    // good request: ok, with the notes for exactly this conversion
    let r = post_json(&e, "/api/v1/jobs/preview", json!({"operation": "convert", "options": {"format": "jpeg"}, "files": [{"name": "a.png", "size": 1000, "head_hex": png}]})).await;
    assert_eq!(r.status(), 200);
    let p: PreviewResponse = r.json().await.unwrap();
    assert!(p.ok, "{p:?}");
    assert_eq!(p.engine.as_ref().unwrap().id, "image");
    assert!(p.warnings.iter().any(|w| w.to_lowercase().contains("transparent")), "{:?}", p.warnings);

    // wrong content, bad options, too many/too large: all reported together
    let r = post_json(&e, "/api/v1/jobs/preview", json!({"operation": "convert", "options": {"format": "jpeg", "quality": 0}, "files": [
        {"name": "note.png", "size": 10, "head_hex": text_head},
        {"name": "ok.png", "size": 5_000_000, "head_hex": png},
        {"name": "c.png", "size": 1, "head_hex": png}]})).await;
    let p: PreviewResponse = r.json().await.unwrap();
    assert!(!p.ok);
    let codes: Vec<_> = p.errors.iter().map(|i| (i.code.as_str(), i.file.as_deref())).collect();
    assert!(codes.contains(&("UNSUPPORTED_FORMAT", Some("note.png"))), "{codes:?}");
    assert!(codes.contains(&("PAYLOAD_TOO_LARGE", Some("ok.png"))), "{codes:?}");
    assert!(codes.iter().any(|(c, f)| *c == "PAYLOAD_TOO_LARGE" && f.is_none()), "file-count limit: {codes:?}");
    assert!(p.errors.iter().any(|i| i.message.contains("Quality")), "{:?}", p.errors);

    // extract wants a real ZIP
    let r = post_json(&e, "/api/v1/jobs/preview", json!({"operation": "extract", "files": [{"name": "x.zip", "head_hex": png}]})).await;
    let p: PreviewResponse = r.json().await.unwrap();
    assert!(!p.ok && p.errors[0].code == "UNSUPPORTED_FORMAT");

    // malformed requests are plain 400s, and nothing is ever stored
    assert_eq!(post_json(&e, "/api/v1/jobs/preview", json!({"operation": "explode", "files": []})).await.status(), 400);
    let r = e.http.post(e.url("/api/v1/jobs/preview")).header("authorization", e.auth()).body("not json").send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "INVALID_REQUEST");
    assert_eq!(e.http.post(e.url("/api/v1/jobs/preview")).json(&json!({})).send().await.unwrap().status(), 401);
    assert!(e.job_dirs().is_empty());
}

#[tokio::test]
async fn unavailable_engines_are_reported_and_refused_with_422() {
    let reg = std::sync::Arc::new(file_core::Registry::new(vec![std::sync::Arc::new(FakeConvert { availability: Availability::Unavailable { reason: "not installed".into() } })]));
    let e = Env::with_registry(reg).await;

    let caps: file_core::Capabilities = e.get("/api/v1/capabilities").await.json().await.unwrap();
    assert!(!caps.operations[0].available);
    assert_eq!(caps.operations[0].unavailable_reason.as_deref(), Some("not installed"));

    let p: PreviewResponse = post_json(&e, "/api/v1/jobs/preview", json!({"operation": "convert", "options": {"format": "jpeg"}, "files": [{"name": "a.png", "head_hex": png_head_hex()}]})).await.json().await.unwrap();
    assert!(!p.ok);
    assert_eq!(p.errors[0].code, "ENGINE_UNAVAILABLE");
    assert!(p.errors[0].message.contains("not installed"));

    let r = e.post("convert", Some(r#"{"format":"jpeg"}"#), vec![("a.png", png_bytes(4, 4))]).await;
    assert_eq!(r.status(), 422);
    let b: ErrorBody = r.json().await.unwrap();
    assert_eq!(b.error.code, "ENGINE_UNAVAILABLE");
    assert!(e.job_dirs().is_empty(), "refused before storing anything");
    // an operation nobody handles is a plain unsupported error
    let r = e.post("compress", None, vec![("a.txt", vec![1])]).await;
    assert_eq!(r.status(), 415);
}

#[tokio::test]
async fn unsupported_conversion_pairs_are_refused_with_415() {
    let reg = std::sync::Arc::new(file_core::Registry::new(vec![std::sync::Arc::new(FakeConvert { availability: Availability::Bundled })]));
    let e = Env::with_registry(reg).await;

    let r = e.post("convert", Some(r#"{"format":"webp"}"#), vec![("a.png", png_bytes(4, 4))]).await;
    assert_eq!(r.status(), 415);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "UNSUPPORTED_CONVERSION");

    let jpeg = { let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0]; b.extend_from_slice(&[0; 40]); b };
    let r = e.post("convert", Some(r#"{"format":"jpeg"}"#), vec![("a.jpg", jpeg)]).await;
    assert_eq!(r.status(), 415);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "UNSUPPORTED_FORMAT");

    let p: PreviewResponse = post_json(&e, "/api/v1/jobs/preview", json!({"operation": "convert", "options": {"format": "webp"}, "files": [{"name": "a.png", "head_hex": png_head_hex()}]})).await.json().await.unwrap();
    assert_eq!(p.errors[0].code, "UNSUPPORTED_CONVERSION");
    assert!(p.errors[0].message.contains("PNG") && p.errors[0].message.contains("WEBP"));

    // the one supported pair goes through
    let id = e.create("convert", Some(r#"{"format":"jpeg"}"#), vec![("a.png", png_bytes(4, 4))]).await;
    assert_eq!(e.wait(&id).await.status, WireStatus::Completed);
    assert!(e.job_dirs().len() == 1);
}

#[tokio::test]
async fn lossy_webp_and_options_work_over_http() {
    let e = Env::new().await;
    let png = { let n = noise(160 * 120); let img = image::RgbImage::from_fn(160, 120, |x, y| { let t = n[(y * 160 + x) as usize] / 8; image::Rgb([(x * 2) as u8 / 2 + t, (y * 2) as u8 / 2 + t, 100 + t]) }); let mut o = std::io::Cursor::new(Vec::new()); img.write_to(&mut o, image::ImageFormat::Png).unwrap(); o.into_inner() };

    let lossy = e.create("convert", Some(r#"{"format":"webp","quality":50}"#), vec![("p.png", png.clone())]).await;
    assert_eq!(e.wait(&lossy).await.status, WireStatus::Completed);
    let lossy_bytes = e.get(&format!("/api/v1/jobs/{lossy}/result")).await.bytes().await.unwrap();
    assert_eq!(image::guess_format(&lossy_bytes).unwrap(), image::ImageFormat::WebP);

    let lossless = e.create("convert", Some(r#"{"format":"webp","webp_mode":"lossless"}"#), vec![("p.png", png.clone())]).await;
    assert_eq!(e.wait(&lossless).await.status, WireStatus::Completed);
    let lossless_bytes = e.get(&format!("/api/v1/jobs/{lossless}/result")).await.bytes().await.unwrap();
    assert!(lossy_bytes.len() < lossless_bytes.len());

    // unknown mode / bad colour / bad quality are 400s before anything is stored
    for opts in [r#"{"format":"webp","webp_mode":"fancy"}"#, r#"{"format":"jpeg","background":"red"}"#, r#"{"format":"jpeg","quality":500}"#] {
        let r = e.post("convert", Some(opts), vec![("p.png", png.clone())]).await;
        assert_eq!(r.status(), 400, "{opts}");
        assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "INVALID_REQUEST");
    }
    assert_eq!(e.job_dirs().len(), 2, "only the two accepted jobs are on disk");
}

#[tokio::test]
async fn post_cancel_is_an_alias_for_delete() {
    let e = Env::with(|c| c.max_concurrent_processing = 1).await;
    let first = e.create("compress", None, vec![("big.bin", noise(12_000_000))]).await;
    let second = e.create("compress", None, vec![("small", b"x".to_vec())]).await;
    let r = e.http.post(e.url(&format!("/api/v1/jobs/{second}/cancel"))).header("authorization", e.auth()).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(e.wait(&second).await.status, WireStatus::Cancelled);
    assert_eq!(e.wait(&first).await.status, WireStatus::Completed);
    let r = e.http.post(e.url(&format!("/api/v1/jobs/{first}/cancel"))).header("authorization", e.auth()).send().await.unwrap();
    assert_eq!(r.status(), 409);
    assert_eq!(r.json::<ErrorBody>().await.unwrap().error.code, "JOB_FINISHED");
    assert_eq!(e.http.post(e.url("/api/v1/jobs/job_nope/cancel")).header("authorization", e.auth()).send().await.unwrap().status(), 404);
}
