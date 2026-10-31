//! `/api/v1/pdf/documents` over real HTTP. Needs PDFium: set `ORANGEFILE_PDFIUM` to its folder
//! (see file-core/tests/pdf_tests.rs); `ORANGEFILE_REQUIRE_PDFIUM=1` turns a skip into a failure.

use file_api::types::PdfDocumentResponse;
use file_api::{start_with, ApiConfig, RunningServer};
use file_core::engine::pdf::{HostConfig, PdfHost, WorkerProgram};
use file_core::Registry;
use reqwest::{multipart, Client, StatusCode};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Env {
    server: RunningServer,
    http: Client,
    root: tempfile::TempDir,
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../file-core/tests/fixtures/pdf").join(name)).unwrap()
}

fn pdfium_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("ORANGEFILE_PDFIUM").map(PathBuf::from);
    if dir.is_none() {
        assert!(std::env::var_os("ORANGEFILE_REQUIRE_PDFIUM").is_none(), "ORANGEFILE_REQUIRE_PDFIUM is set but ORANGEFILE_PDFIUM is not");
        eprintln!("skipped: ORANGEFILE_PDFIUM is not set");
    }
    dir
}

fn registry(lib_dir: &Path) -> Arc<Registry> {
    let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(PathBuf::from(env!("CARGO_BIN_EXE_file-api"))));
    cfg.library_dirs = vec![lib_dir.to_path_buf()];
    Arc::new(Registry::bundled_with(Arc::new(PdfHost::new(cfg))))
}

impl Env {
    async fn with(lib_dir: &Path, tweak: impl FnOnce(&mut ApiConfig)) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = ApiConfig::local(root.path().join("data"));
        cfg.sweep_interval = Duration::from_millis(50);
        tweak(&mut cfg);
        let server = start_with(cfg, registry(lib_dir)).await.unwrap();
        Env { server, http: Client::new(), root }
    }

    async fn real(tweak: impl FnOnce(&mut ApiConfig)) -> Option<Self> {
        let dir = pdfium_dir()?;
        Some(Self::with(&dir, tweak).await)
    }

    fn url(&self, p: &str) -> String {
        format!("{}/api/v1{p}", self.server.base_url())
    }

    fn data_entries(&self) -> Vec<String> {
        std::fs::read_dir(self.root.path().join("data")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
    }

    async fn open_raw(&self, name: &str, bytes: Vec<u8>, password: Option<&str>) -> reqwest::Response {
        let mut form = multipart::Form::new();
        if let Some(p) = password {
            form = form.text("password", p.to_string());
        }
        form = form.part("file", multipart::Part::bytes(bytes).file_name(name.to_string()));
        self.http.post(self.url("/pdf/documents")).bearer_auth(&self.server.token).multipart(form).send().await.unwrap()
    }

    async fn open(&self, fixture_name: &str) -> PdfDocumentResponse {
        let r = self.open_raw(fixture_name, fixture(fixture_name), None).await;
        assert_eq!(r.status(), StatusCode::CREATED, "{:?}", r.text().await);
        r.json().await.unwrap()
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.http.get(self.url(path)).bearer_auth(&self.server.token).send().await.unwrap()
    }

    async fn delete(&self, path: &str) -> reqwest::Response {
        self.http.delete(self.url(path)).bearer_auth(&self.server.token).send().await.unwrap()
    }
}

async fn error_code(r: reqwest::Response) -> (StatusCode, String, String) {
    let status = r.status();
    let v: Value = r.json().await.unwrap();
    (status, v["error"]["code"].as_str().unwrap_or("").into(), v["error"]["message"].as_str().unwrap_or("").into())
}

#[tokio::test]
async fn opens_a_pdf_and_describes_it() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let doc = e.open("three-pages.pdf").await;
    assert!(doc.id.starts_with("doc_"));
    assert_eq!(doc.name, "three-pages.pdf");
    assert_eq!(doc.info.page_count, 3);
    assert_eq!(doc.info.metadata.title.as_deref(), Some("Three pages"));
    assert!(doc.size > 1000);

    let again: PdfDocumentResponse = e.get(&format!("/pdf/documents/{}", doc.id)).await.json().await.unwrap();
    assert_eq!(again.info, doc.info);
}

#[tokio::test]
async fn serves_page_images_with_caching_and_bounds() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let doc = e.open("three-pages.pdf").await;
    let path = |n: u32, w: u32| format!("/pdf/documents/{}/pages/{n}/image?width={w}", doc.id);

    let r = e.get(&path(1, 240)).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["content-type"], "image/png");
    let bytes = r.bytes().await.unwrap();
    let img = image::load_from_memory(&bytes).unwrap().to_rgb8();
    assert_eq!(img.width(), 240);
    assert!(img.get_pixel(120, 200).0[0] > 190, "page 1 is red");

    // Second request for the same thing is served from the document's cache.
    let again = e.get(&path(1, 240)).await.bytes().await.unwrap();
    assert_eq!(again, bytes);

    // Pages are numbered from 1; other numbers are 404s with a stable code.
    for n in [0, 4, 99] {
        let (s, code, _) = error_code(e.get(&path(n, 100)).await).await;
        assert_eq!((s, code.as_str()), (StatusCode::NOT_FOUND, "PAGE_NOT_FOUND"), "page {n}");
    }
    // An absurd width is clamped, not honoured.
    let big = e.get(&format!("/pdf/documents/{}/pages/2/image?width=4000000000", doc.id)).await.bytes().await.unwrap();
    assert!(image::load_from_memory(&big).unwrap().width() <= 4096);
    // No width = a sensible default.
    let dflt = e.get(&format!("/pdf/documents/{}/pages/2/image", doc.id)).await.bytes().await.unwrap();
    assert_eq!(image::load_from_memory(&dflt).unwrap().width(), 800);
}

#[tokio::test]
async fn passwords_are_asked_for_checked_and_never_echoed() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let bytes = fixture("encrypted.pdf");

    let (s, code, msg) = error_code(e.open_raw("enc.pdf", bytes.clone(), None).await).await;
    assert_eq!((s, code.as_str()), (StatusCode::UNPROCESSABLE_ENTITY, "PASSWORD_REQUIRED"), "{msg}");
    let r = e.open_raw("enc.pdf", bytes.clone(), Some("not-the-one")).await;
    let text = r.text().await.unwrap();
    assert!(text.contains("WRONG_PASSWORD") && !text.contains("not-the-one"), "{text}");
    assert!(e.data_entries().is_empty(), "failed opens leave nothing behind: {:?}", e.data_entries());

    let r = e.open_raw("enc.pdf", bytes, Some("open-sesame")).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let body = r.text().await.unwrap();
    assert!(!body.contains("open-sesame"), "the password isn't echoed");
    let doc: PdfDocumentResponse = serde_json::from_str(&body).unwrap();
    assert!(doc.info.encrypted);

    // Pages render without the client sending the password again.
    let r = e.get(&format!("/pdf/documents/{}/pages/1/image?width=200", doc.id)).await;
    assert_eq!(r.status(), 200);
    // And the password isn't written to disk anywhere under the data directory.
    let mut hits = 0;
    for entry in walk(&e.root.path().join("data")) {
        if std::fs::read(&entry).map(|b| b.windows(11).any(|w| w == b"open-sesame")).unwrap_or(false) {
            hits += 1;
        }
    }
    assert_eq!(hits, 0);
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[tokio::test]
async fn rejects_things_that_are_not_pdfs() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let (s, code, _) = error_code(e.open_raw("notes.pdf", b"just some text, named .pdf".to_vec(), None).await).await;
    assert_eq!((s, code.as_str()), (StatusCode::UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_FORMAT"));
    // A PNG renamed to .pdf is still a PNG.
    let (s, code, _) = error_code(e.open_raw("x.pdf", b"\x89PNG\r\n\x1a\n....".to_vec(), None).await).await;
    assert_eq!((s, code.as_str()), (StatusCode::UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_FORMAT"));
    // Right header, nothing behind it.
    let (s, code, _) = error_code(e.open_raw("x.pdf", b"%PDF-1.7\nthis is not a document".to_vec(), None).await).await;
    assert_eq!((s, code.as_str()), (StatusCode::UNPROCESSABLE_ENTITY, "CORRUPT_PDF"));
    let (s, code, _) = error_code(e.open_raw("empty.pdf", fixture("no-pages.pdf"), None).await).await;
    assert_eq!((s, code.as_str()), (StatusCode::UNPROCESSABLE_ENTITY, "CORRUPT_PDF"));
    assert!(e.data_entries().is_empty(), "{:?}", e.data_entries());

    // Form mistakes.
    let r = e.http.post(e.url("/pdf/documents")).bearer_auth(&e.server.token).multipart(multipart::Form::new().text("password", "x")).send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert!(e.data_entries().is_empty());
}

#[tokio::test]
async fn size_limit_is_enforced_while_uploading() {
    let Some(e) = Env::real(|c| c.max_file_bytes = 1000).await else { return };
    let (s, code, _) = error_code(e.open_raw("big.pdf", fixture("three-pages.pdf"), None).await).await;
    assert_eq!((s, code.as_str()), (StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE"));
    assert!(e.data_entries().is_empty());
}

#[tokio::test]
async fn closing_deletes_everything() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let doc = e.open("three-pages.pdf").await;
    e.get(&format!("/pdf/documents/{}/pages/1/image?width=100", doc.id)).await.bytes().await.unwrap();
    assert_eq!(e.data_entries().len(), 1);

    assert_eq!(e.delete(&format!("/pdf/documents/{}", doc.id)).await.status(), 204);
    assert!(e.data_entries().is_empty());
    for r in [e.get(&format!("/pdf/documents/{}", doc.id)).await, e.get(&format!("/pdf/documents/{}/pages/1/image", doc.id)).await, e.delete(&format!("/pdf/documents/{}", doc.id)).await] {
        let (s, code, _) = error_code(r).await;
        assert_eq!((s, code.as_str()), (StatusCode::NOT_FOUND, "DOCUMENT_NOT_FOUND"));
    }
}

#[tokio::test]
async fn the_least_recently_used_document_is_closed_to_make_room() {
    let Some(e) = Env::real(|c| c.max_open_documents = 2).await else { return };
    let a = e.open("three-pages.pdf").await;
    let b = e.open("three-pages.pdf").await;
    assert_eq!(e.get(&format!("/pdf/documents/{}", a.id)).await.status(), 200, "touch A so B is the older one");
    let c = e.open("three-pages.pdf").await;
    assert_eq!(e.get(&format!("/pdf/documents/{}", b.id)).await.status(), 404);
    assert_eq!(e.get(&format!("/pdf/documents/{}", a.id)).await.status(), 200);
    assert_eq!(e.get(&format!("/pdf/documents/{}", c.id)).await.status(), 200);
    assert_eq!(e.data_entries().len(), 2);
}

#[tokio::test]
async fn idle_documents_expire() {
    let Some(e) = Env::real(|c| c.document_idle = Duration::from_millis(300)).await else { return };
    let doc = e.open("three-pages.pdf").await;
    let t = Instant::now();
    while !e.data_entries().is_empty() {
        assert!(t.elapsed() < Duration::from_secs(10), "idle document was never closed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(e.get(&format!("/pdf/documents/{}", doc.id)).await.status(), 404);
}

#[tokio::test]
async fn shutdown_deletes_open_documents_and_startup_cleans_stale_ones() {
    let Some(dir) = pdfium_dir() else { return };
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(data.join("doc_leftover")).unwrap();
    std::fs::write(data.join("doc_leftover/source.pdf"), b"%PDF-").unwrap();
    std::fs::write(data.join("keep.txt"), b"not ours").unwrap();

    let server = start_with(ApiConfig::local(&data), registry(&dir)).await.unwrap();
    assert!(!data.join("doc_leftover").exists(), "stale document folders are removed at startup");
    assert!(data.join("keep.txt").exists(), "only our own folders are touched");

    let http = Client::new();
    let form = multipart::Form::new().part("file", multipart::Part::bytes(fixture("three-pages.pdf")).file_name("a.pdf"));
    let r = http.post(format!("{}/api/v1/pdf/documents", server.base_url())).bearer_auth(&server.token).multipart(form).send().await.unwrap();
    assert_eq!(r.status(), 201);
    assert!(std::fs::read_dir(&data).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("doc_")));
    server.shutdown().await;
    assert!(!std::fs::read_dir(&data).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("doc_")));
}

#[tokio::test]
async fn needs_the_token_like_everything_else() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let doc = e.open("three-pages.pdf").await;
    let anon = &e.http;
    for (method, path) in [("GET", format!("/pdf/documents/{}", doc.id)), ("GET", format!("/pdf/documents/{}/pages/1/image", doc.id)), ("DELETE", format!("/pdf/documents/{}", doc.id))] {
        let r = anon.request(method.parse().unwrap(), e.url(&path)).send().await.unwrap();
        assert_eq!(r.status(), 401, "{method} {path}");
    }
    let form = multipart::Form::new().part("file", multipart::Part::bytes(fixture("three-pages.pdf")).file_name("a.pdf"));
    assert_eq!(anon.post(e.url("/pdf/documents")).multipart(form).send().await.unwrap().status(), 401);
    assert_eq!(e.get(&format!("/pdf/documents/{}", doc.id)).await.status(), 200, "the document survived the anonymous attempts");
}

#[tokio::test]
async fn without_pdfium_the_engine_is_unavailable_and_says_why() {
    let empty = tempfile::tempdir().unwrap();
    let e = Env::with(empty.path(), |_| {}).await;
    let caps: Value = e.get("/capabilities").await.json().await.unwrap();
    let op = caps["operations"].as_array().unwrap().iter().find(|o| o["id"] == "pdf_view").unwrap();
    assert_eq!((op["available"].clone(), op["interactive"].clone()), (json!(false), json!(true)));
    assert!(op["unavailable_reason"].as_str().unwrap().contains("missing"));
    assert!(!op["unavailable_reason"].as_str().unwrap().contains(empty.path().to_str().unwrap()), "no paths");
    assert!(caps["formats"].as_array().unwrap().iter().any(|f| f["id"] == "pdf"));

    let (s, code, msg) = error_code(e.open_raw("a.pdf", fixture("three-pages.pdf"), None).await).await;
    assert_eq!((s, code.as_str()), (StatusCode::UNPROCESSABLE_ENTITY, "ENGINE_UNAVAILABLE"), "{msg}");
    assert!(e.data_entries().is_empty());
}

#[tokio::test]
async fn pdf_viewing_is_not_a_batch_job() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let form = multipart::Form::new()
        .text("operation", "pdf_view")
        .part("files", multipart::Part::bytes(fixture("three-pages.pdf")).file_name("a.pdf"));
    let r = e.http.post(e.url("/jobs")).bearer_auth(&e.server.token).multipart(form).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let r = e.http.post(e.url("/jobs/preview")).bearer_auth(&e.server.token).json(&json!({"operation": "pdf_view", "files": []})).send().await.unwrap();
    assert_eq!(r.status(), 400);
}

#[tokio::test]
async fn a_crashed_worker_does_not_take_the_server_down() {
    let Some(dir) = pdfium_dir() else { return };
    // A worker that dies on real work but answers the availability probe.
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("w.sh");
    std::fs::write(&script, "#!/bin/sh\ninput=$(cat); case \"$input\" in *probe*) echo '{\"status\":\"ok\",\"data\":{}}';; *) kill -SEGV $$;; esac\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(script));
        cfg.library_dirs = vec![dir];
        let reg = Arc::new(Registry::bundled_with(Arc::new(PdfHost::new(cfg))));
        let root = tempfile::tempdir().unwrap();
        let server = start_with(ApiConfig::local(root.path().join("d")), reg).await.unwrap();
        let http = Client::new();
        let form = multipart::Form::new().part("file", multipart::Part::bytes(fixture("three-pages.pdf")).file_name("a.pdf"));
        let r = http.post(format!("{}/api/v1/pdf/documents", server.base_url())).bearer_auth(&server.token).multipart(form).send().await.unwrap();
        let (s, code, msg) = error_code(r).await;
        assert_eq!((s, code.as_str()), (StatusCode::INTERNAL_SERVER_ERROR, "PDF_WORKER_FAILED"));
        assert!(!msg.contains("SEGV") && !msg.contains(".sh"), "{msg}");
        let h = http.get(format!("{}/health", server.base_url())).send().await.unwrap();
        assert_eq!(h.status(), 200, "the API itself is fine");
        server.shutdown().await;
    }
    #[cfg(not(unix))]
    let _ = (dir, script);
}

// ------------------------------------------------------------------ merge / split / pages as jobs

use file_api::types::{CreateJobResponse, JobResponse, PreviewResponse, ResultManifest, WireStatus};

impl Env {
    async fn job(&self, operation: &str, options: Value, files: Vec<(&str, Vec<u8>)>) -> reqwest::Response {
        let mut form = multipart::Form::new().text("operation", operation.to_string()).text("options", options.to_string());
        for (name, bytes) in files {
            form = form.part("files", multipart::Part::bytes(bytes).file_name(name.to_string()));
        }
        self.http.post(self.url("/jobs")).bearer_auth(&self.server.token).multipart(form).send().await.unwrap()
    }

    async fn finished(&self, operation: &str, options: Value, files: Vec<(&str, Vec<u8>)>) -> (String, JobResponse) {
        let r = self.job(operation, options, files).await;
        assert_eq!(r.status(), StatusCode::ACCEPTED, "{:?}", r.text().await);
        let id = r.json::<CreateJobResponse>().await.unwrap().job_id;
        let t = Instant::now();
        loop {
            let s: JobResponse = self.get(&format!("/jobs/{id}")).await.json().await.unwrap();
            if s.status.is_finished() {
                return (id, s);
            }
            assert!(t.elapsed() < Duration::from_secs(60));
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    async fn download(&self, id: &str, index: usize) -> Vec<u8> {
        let r = self.get(&format!("/jobs/{id}/result/files/{index}")).await;
        assert_eq!(r.status(), 200);
        r.bytes().await.unwrap().to_vec()
    }
}

/// Page count of PDF bytes, using the same PDFium the server uses.
fn page_count(bytes: &[u8]) -> u32 {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("x.pdf");
    std::fs::write(&f, bytes).unwrap();
    let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(PathBuf::from(env!("CARGO_BIN_EXE_file-api"))));
    cfg.library_dirs = vec![pdfium_dir().unwrap()];
    PdfHost::new(cfg).info(&f, None).unwrap().page_count
}

#[tokio::test]
async fn merge_over_http() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let (id, s) = e.finished("pdf_merge", json!({"output_name": "both"}), vec![("a.pdf", fixture("three-pages.pdf")), ("b.pdf", fixture("second.pdf"))]).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert_eq!(s.results.len(), 1);
    assert_eq!(s.results[0].output.as_deref(), Some("both.pdf"), "file name only, no server path");
    let bytes = e.download(&id, 0).await;
    assert!(bytes.starts_with(b"%PDF-"));
    assert_eq!(page_count(&bytes), 5);
}

#[tokio::test]
async fn merge_with_a_password_over_http() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let files = || vec![("a.pdf", fixture("second.pdf")), ("e.pdf", fixture("encrypted.pdf"))];
    let (_, s) = e.finished("pdf_merge", json!({}), files()).await;
    assert_eq!(s.status, WireStatus::Failed);
    let msg = serde_json::to_string(&s).unwrap();
    assert!(msg.contains("e.pdf") && msg.contains("password"), "{msg}");
    let (id, s) = e.finished("pdf_merge", json!({"password": "open-sesame"}), files()).await;
    let text = serde_json::to_string(&s).unwrap();
    assert_eq!(s.status, WireStatus::Completed, "{text}");
    assert!(!text.contains("open-sesame"), "the password isn't echoed in job status");
    assert_eq!(page_count(&e.download(&id, 0).await), 5);
}

#[tokio::test]
async fn split_over_http_returns_a_folder_of_parts() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let (id, s) = e.finished("pdf_split", json!({"mode": "every", "every": 4}), vec![("ten.pdf", fixture("ten-pages.pdf"))]).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert_eq!(s.results.len(), 3);
    let manifest: ResultManifest = e.get(&format!("/jobs/{id}/result/files")).await.json().await.unwrap();
    let names: Vec<_> = manifest.files.iter().map(|f| f.path.clone()).collect();
    assert_eq!(names, ["ten (split)/ten - pages 1-4.pdf", "ten (split)/ten - pages 5-8.pdf", "ten (split)/ten - pages 9-10.pdf"]);
    let counts: Vec<u32> = futures_counts(&e, &id, names.len()).await;
    assert_eq!(counts, [4, 4, 2]);
}

async fn futures_counts(e: &Env, id: &str, n: usize) -> Vec<u32> {
    let mut v = vec![];
    for i in 0..n {
        v.push(page_count(&e.download(id, i).await));
    }
    v
}

#[tokio::test]
async fn pages_job_reorders_rotates_and_deletes() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let plan = json!({"pages": [{"page": 3}, {"page": 1, "rotate": 90}], "output_name": "mine"});
    let (id, s) = e.finished("pdf_pages", plan, vec![("t.pdf", fixture("three-pages.pdf"))]).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert_eq!(page_count(&e.download(&id, 0).await), 2);

    let (_, s) = e.finished("pdf_pages", json!({"pages": [{"page": 9}]}), vec![("t.pdf", fixture("three-pages.pdf"))]).await;
    assert_eq!(s.status, WireStatus::Failed);
    assert!(serde_json::to_string(&s).unwrap().contains("page 9"));
}

#[tokio::test]
async fn pdf_jobs_refuse_other_file_types_and_bad_options_up_front() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let r = e.job("pdf_merge", json!({}), vec![("a.pdf", fixture("second.pdf")), ("b.pdf", b"just text, not a pdf".to_vec())]).await;
    let (s, code, _) = error_code(r).await;
    assert_eq!((s, code.as_str()), (StatusCode::UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_FORMAT"));
    let r = e.job("pdf_split", json!({"mode": "ranges", "ranges": "5-2"}), vec![("a.pdf", fixture("ten-pages.pdf"))]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = e.job("pdf_pages", json!({"pages": []}), vec![("a.pdf", fixture("ten-pages.pdf"))]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = e.job("pdf_pages", json!({"pages": [{"page": 1, "rotate": 45}]}), vec![("a.pdf", fixture("ten-pages.pdf"))]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert!(e.data_entries().is_empty(), "{:?}", e.data_entries());
}

#[tokio::test]
async fn preview_covers_the_pdf_jobs() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let head = |b: &[u8]| file_core::formats::hex_encode(&b[..32.min(b.len())]);
    let pdf = head(&fixture("second.pdf"));
    let post = |body: Value| {
        let e = &e;
        async move { e.http.post(e.url("/jobs/preview")).bearer_auth(&e.server.token).json(&body).send().await.unwrap().json::<PreviewResponse>().await.unwrap() }
    };
    let p = post(json!({"operation": "pdf_merge", "options": {}, "files": [{"name": "a.pdf", "size": 10, "head_hex": pdf}, {"name": "b.pdf", "size": 10, "head_hex": pdf}]})).await;
    assert!(p.ok, "{p:?}");
    assert_eq!(p.engine.unwrap().id, "pdf");
    let p = post(json!({"operation": "pdf_merge", "options": {}, "files": [{"name": "a.png", "size": 10, "head_hex": head(b"\x89PNG\r\n\x1a\n....")}]})).await;
    assert!(!p.ok && p.errors[0].code == "UNSUPPORTED_FORMAT" && p.errors[0].file.as_deref() == Some("a.png"), "{p:?}");
    let p = post(json!({"operation": "pdf_split", "options": {"mode": "every", "every": 0}, "files": []})).await;
    assert!(!p.ok, "{p:?}");
}

// ------------------------------------------------------------------ step 6: pictures, annotations, Office

fn png_bytes(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(w, h, image::Rgb(rgb));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn office_fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../file-core/tests/fixtures/office").join(name)).unwrap()
}

#[tokio::test]
async fn pictures_to_pdf_over_http() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let files = vec![("one.png", png_bytes(200, 100, [255, 0, 0])), ("two.png", png_bytes(100, 200, [0, 0, 255]))];
    let (id, s) = e.finished("images_to_pdf", json!({"paper": "a4", "orientation": "auto", "margin_mm": 10, "output_name": "pics"}), files).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert_eq!(s.results[0].output.as_deref(), Some("pics.pdf"));
    assert_eq!(page_count(&e.download(&id, 0).await), 2);

    // Not a picture: refused before anything is stored.
    let before = e.data_entries();
    let r = e.job("images_to_pdf", json!({}), vec![("a.png", png_bytes(8, 8, [0; 3])), ("b.txt", b"hello hello hello hello".to_vec())]).await;
    assert_eq!(error_code(r).await.1, "UNSUPPORTED_FORMAT");
    let r = e.job("images_to_pdf", json!({"paper": "tabloid"}), vec![("a.png", png_bytes(8, 8, [0; 3]))]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(e.data_entries(), before, "refused jobs leave nothing behind");
}

#[tokio::test]
async fn pdf_to_pictures_over_http() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let (id, s) = e.finished("pdf_to_images", json!({"format": "png", "dpi": 72}), vec![("three-pages.pdf", fixture("three-pages.pdf"))]).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    let manifest: ResultManifest = e.get(&format!("/jobs/{id}/result/files")).await.json().await.unwrap();
    let names: Vec<_> = manifest.files.iter().map(|f| f.path.clone()).collect();
    assert_eq!(names, ["three-pages (images)/three-pages - page 1.png", "three-pages (images)/three-pages - page 2.png", "three-pages (images)/three-pages - page 3.png"]);
    let first = image::load_from_memory(&e.download(&id, 0).await).unwrap().to_rgb8();
    assert!(first.get_pixel(first.width() / 2, first.height() / 2).0[0] > 190, "page 1 is red");

    let (id, s) = e.finished("pdf_to_images", json!({"format": "jpeg", "dpi": 72, "pages": "2", "quality": 80}), vec![("three-pages.pdf", fixture("three-pages.pdf"))]).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert_eq!(&e.download(&id, 0).await[..3], [0xff, 0xd8, 0xff]);

    let r = e.job("pdf_to_images", json!({"format": "png", "dpi": 5000}), vec![("t.pdf", fixture("three-pages.pdf"))]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = e.job("pdf_to_images", json!({"format": "gif"}), vec![("t.pdf", fixture("three-pages.pdf"))]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn annotations_and_a_picture_are_drawn_into_a_copy() {
    let Some(e) = Env::real(|_| {}).await else { return };
    let plan = json!({
        "pages": [{"page": 1}],
        "annotations": [
            {"kind": "shape", "page": 1, "shape": "rect", "x0": 50, "y0": 50, "x1": 250, "y1": 150, "color": "#0000ff", "width": 4, "fill": "#0000ff"},
            {"kind": "image", "page": 1, "x": 300, "y": 300, "w": 100, "h": 100, "image": 0}
        ]
    });
    let files = vec![("t.pdf", fixture("three-pages.pdf")), ("sig.png", png_bytes(40, 40, [0, 160, 0]))];
    let (id, s) = e.finished("pdf_pages", plan, files).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    let out = e.download(&id, 0).await;
    assert_eq!(page_count(&out), 1);

    // Render the result through the server's own PDF document endpoint to look at pixels.
    let doc = e.open_raw("annotated.pdf", out, None).await;
    let doc: PdfDocumentResponse = doc.json().await.unwrap();
    let png = e.get(&format!("/pdf/documents/{}/pages/1/image?width={}", doc.id, 612)).await.bytes().await.unwrap();
    let img = image::load_from_memory(&png).unwrap().to_rgb8();
    let blue = img.get_pixel(150, 100).0;
    let green = img.get_pixel(350, 350).0;
    assert!(blue[2] > 200 && blue[0] < 60, "blue box at 150,100: {blue:?}");
    assert!(green[1] > 120 && green[0] < 60, "green picture at 350,350: {green:?}");

    // A reference to a picture that wasn't sent is refused up front.
    let bad = json!({"pages": [{"page": 1}], "annotations": [{"kind": "image", "page": 1, "x": 0, "y": 0, "w": 10, "h": 10, "image": 3}]});
    let (_, s) = e.finished("pdf_pages", bad, vec![("t.pdf", fixture("three-pages.pdf"))]).await;
    assert_eq!(s.status, WireStatus::Failed);
}

#[tokio::test]
async fn office_documents_to_pdf_over_http() {
    let Some(dir) = pdfium_dir() else { return };
    let mut office = file_core::engine::office::OfficeConfig::for_app();
    if let Some(p) = std::env::var_os("ORANGEFILE_LIBREOFFICE") {
        office = office.with_bundled_dir(p);
    }
    let office = Arc::new(file_core::engine::office::OfficeHost::new(office));
    if matches!(office.availability(), file_core::engine::Availability::Unavailable { .. }) {
        assert!(std::env::var_os("ORANGEFILE_REQUIRE_LIBREOFFICE").is_none());
        eprintln!("skipped: LibreOffice is not available");
        return;
    }
    let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(PathBuf::from(env!("CARGO_BIN_EXE_file-api"))));
    cfg.library_dirs = vec![dir];
    let reg = Arc::new(Registry::bundled_with_office(Arc::new(PdfHost::new(cfg)), office));
    let root = tempfile::tempdir().unwrap();
    let server = start_with(ApiConfig::local(root.path().join("data")), reg).await.unwrap();
    let e = Env { server, http: Client::new(), root };

    let (id, s) = e.finished("office_to_pdf", json!({}), vec![("Quarterly report.docx", office_fixture("report.docx")), ("deck.pptx", office_fixture("deck.pptx"))]).await;
    assert_eq!(s.status, WireStatus::Completed, "{s:?}");
    assert_eq!(s.results[0].output.as_deref(), Some("Quarterly report.pdf"));
    assert_eq!(page_count(&e.download(&id, 0).await), 2);
    assert_eq!(page_count(&e.download(&id, 1).await), 3);

    // A zip that isn't a document passes the first-bytes check but is rejected by the job, per file.
    let mut z = std::io::Cursor::new(Vec::new());
    {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(&mut z);
        w.start_file("a.txt", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
    }
    let (_, s) = e.finished("office_to_pdf", json!({}), vec![("fake.docx", z.into_inner())]).await;
    assert_eq!(s.status, WireStatus::Failed, "{s:?}");
    let r = e.job("office_to_pdf", json!({}), vec![("a.png", png_bytes(8, 8, [0; 3]))]).await;
    assert_eq!(error_code(r).await.1, "UNSUPPORTED_FORMAT");
}

#[tokio::test]
async fn office_conversion_reports_a_missing_libreoffice() {
    let root = tempfile::tempdir().unwrap();
    let mut cfg = HostConfig::for_app();
    cfg.library_dirs = vec![root.path().to_path_buf()];
    let nothing = Arc::new(file_core::engine::office::OfficeHost::new(file_core::engine::office::OfficeConfig::nothing()));
    let reg = Arc::new(Registry::bundled_with_office(Arc::new(PdfHost::new(cfg)), nothing));
    let server = start_with(ApiConfig::local(root.path().join("data")), reg).await.unwrap();
    let e = Env { server, http: Client::new(), root };
    let r = e.job("office_to_pdf", json!({}), vec![("report.docx", office_fixture("report.docx"))]).await;
    let (status, code, message) = error_code(r).await;
    assert_eq!(code, "ENGINE_UNAVAILABLE", "{status} {message}");
    assert!(message.contains("LibreOffice"), "{message}");
    let caps: Value = e.get("/capabilities").await.json().await.unwrap();
    let op = caps["operations"].as_array().unwrap().iter().find(|o| o["id"] == "office_to_pdf" || o["spec"]["id"] == "office_to_pdf").expect("office_to_pdf listed");
    assert_eq!(op["available"], false);
    assert!(e.data_entries().is_empty());
}
