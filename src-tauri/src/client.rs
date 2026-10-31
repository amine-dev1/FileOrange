//! HTTP client for the file API. The only place that knows the token or the URL;
//! neither is ever handed to the webview.

use file_api::types::*;
use futures_util::StreamExt;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct ClientError {
    pub code: String,
    pub message: String,
}

impl ClientError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    pub fn cancelled() -> Self {
        Self::new("CANCELLED", "The job was cancelled.")
    }
    fn unavailable() -> Self {
        Self::new("SERVICE_UNAVAILABLE", "The processing service isn't responding. Restart the app and try again.")
    }
}

impl From<reqwest::Error> for ClientError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_connect() || e.is_timeout() || e.is_request() || e.is_body() {
            Self::unavailable()
        } else {
            Self::new("INTERNAL_ERROR", "Something went wrong talking to the processing service.")
        }
    }
}

pub struct UploadFile {
    /// First bytes of the file, hex-encoded; lets the API check the real file type before upload.
    pub head_hex: String,
    pub path: PathBuf,
    /// Name sent to the server; a relative path for files inside a folder.
    pub name: String,
    pub size: u64,
}

pub struct ApiClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl ApiClient {
    pub fn new(base: String, token: String) -> Self {
        let http = reqwest::Client::builder()
            .no_proxy() // loopback traffic must never go through a system proxy
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("http client");
        Self { http, base, token }
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{path}", self.base)).bearer_auth(&self.token)
    }

    async fn check(res: reqwest::Response) -> Result<reqwest::Response, ClientError> {
        if res.status().is_success() {
            return Ok(res);
        }
        match res.json::<ErrorBody>().await {
            Ok(b) => Err(ClientError::new(&b.error.code, b.error.message)),
            Err(_) => Err(ClientError::new("INTERNAL_ERROR", "The processing service returned an unexpected response.")),
        }
    }

    pub async fn health(&self) -> Result<Health, ClientError> {
        let res = self.http.get(format!("{}/health", self.base)).timeout(Duration::from_secs(3)).send().await?;
        Ok(Self::check(res).await?.json().await?)
    }

    /// Stream the files to the API. `sent` is updated as bytes leave; `cancel`
    /// aborts the upload (the server then deletes the partial job).
    pub async fn create_job(
        &self,
        operation: &str,
        options: &serde_json::Value,
        files: Vec<UploadFile>,
        sent: Arc<AtomicU64>,
        cancel: CancellationToken,
    ) -> Result<CreateJobResponse, ClientError> {
        let mut form = reqwest::multipart::Form::new().text("operation", operation.to_string()).text("options", options.to_string());
        for f in files {
            let file = tokio::fs::File::open(&f.path)
                .await
                .map_err(|_| ClientError::new("NOT_FOUND", format!("“{}” couldn't be opened. It may have been moved or is in use.", f.name)))?;
            let sent = sent.clone();
            let stream = ReaderStream::with_capacity(file, 256 * 1024).inspect(move |chunk| {
                if let Ok(b) = chunk {
                    sent.fetch_add(b.len() as u64, Ordering::Relaxed);
                }
            });
            let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), f.size).file_name(f.name);
            form = form.part("files", part);
        }
        let send = self.req(reqwest::Method::POST, "/api/v1/jobs").multipart(form).send();
        let res = tokio::select! {
            _ = cancel.cancelled() => return Err(ClientError::cancelled()),
            r = send => r?,
        };
        Ok(Self::check(res).await?.json().await?)
    }

    /// Upload a PDF to be opened for viewing. The password, if any, is sent once and never stored here.
    pub async fn open_pdf(&self, path: &std::path::Path, name: &str, size: u64, password: Option<&str>) -> Result<PdfDocumentResponse, ClientError> {
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| ClientError::new("NOT_FOUND", format!("“{name}” couldn't be opened. It may have been moved or is in use.")))?;
        let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(ReaderStream::with_capacity(file, 256 * 1024)), size)
            .file_name(name.to_string());
        let mut form = reqwest::multipart::Form::new();
        if let Some(p) = password.filter(|p| !p.is_empty()) {
            form = form.text("password", p.to_string());
        }
        let res = self.req(reqwest::Method::POST, "/api/v1/pdf/documents").multipart(form.part("file", part)).timeout(Duration::from_secs(300)).send().await?;
        Ok(Self::check(res).await?.json().await?)
    }

    /// One page of an open PDF as PNG bytes. `page` counts from 1.
    pub async fn pdf_page(&self, id: &str, page: u32, width: u32) -> Result<Vec<u8>, ClientError> {
        let res = self
            .req(reqwest::Method::GET, &format!("/api/v1/pdf/documents/{id}/pages/{page}/image?width={width}"))
            .timeout(Duration::from_secs(120))
            .send()
            .await?;
        Ok(Self::check(res).await?.bytes().await?.to_vec())
    }

    pub async fn close_pdf(&self, id: &str) -> Result<(), ClientError> {
        let res = self.req(reqwest::Method::DELETE, &format!("/api/v1/pdf/documents/{id}")).timeout(Duration::from_secs(10)).send().await?;
        match Self::check(res).await {
            Ok(_) => Ok(()),
            Err(e) if e.code == "DOCUMENT_NOT_FOUND" => Ok(()), // already gone
            Err(e) => Err(e),
        }
    }

    pub async fn capabilities(&self) -> Result<file_core::Capabilities, ClientError> {
        let res = self.req(reqwest::Method::GET, "/api/v1/capabilities").timeout(Duration::from_secs(10)).send().await?;
        Ok(Self::check(res).await?.json().await?)
    }

    /// Ask the API whether this job is possible, from file descriptions alone. Uploads nothing.
    pub async fn preview(&self, operation: &str, options: &serde_json::Value, files: &[UploadFile]) -> Result<PreviewResponse, ClientError> {
        // the password is not needed to decide whether a job is possible
        let mut options = options.clone();
        if let Some(o) = options.as_object_mut() {
            o.remove("password");
        }
        let body = PreviewRequest {
            operation: operation.to_string(),
            options,
            files: files.iter().map(|f| PreviewFile { name: f.name.clone(), size: f.size, head_hex: f.head_hex.clone() }).collect(),
        };
        let res = self.req(reqwest::Method::POST, "/api/v1/jobs/preview").json(&body).timeout(Duration::from_secs(30)).send().await?;
        Ok(Self::check(res).await?.json().await?)
    }

    pub async fn status(&self, id: &str) -> Result<JobResponse, ClientError> {
        let res = self.req(reqwest::Method::GET, &format!("/api/v1/jobs/{id}")).timeout(Duration::from_secs(10)).send().await?;
        Ok(Self::check(res).await?.json().await?)
    }

    pub async fn cancel(&self, id: &str) -> Result<(), ClientError> {
        let res = self.req(reqwest::Method::DELETE, &format!("/api/v1/jobs/{id}")).timeout(Duration::from_secs(10)).send().await?;
        match Self::check(res).await {
            Ok(_) => Ok(()),
            Err(e) if e.code == "JOB_FINISHED" => Ok(()), // nothing left to cancel
            Err(e) => Err(e),
        }
    }

    pub async fn manifest(&self, id: &str) -> Result<ResultManifest, ClientError> {
        let res = self.req(reqwest::Method::GET, &format!("/api/v1/jobs/{id}/result/files")).timeout(Duration::from_secs(30)).send().await?;
        Ok(Self::check(res).await?.json().await?)
    }

    /// Open a download for one result file.
    pub async fn file(&self, id: &str, index: usize) -> Result<reqwest::Response, ClientError> {
        let res = self.req(reqwest::Method::GET, &format!("/api/v1/jobs/{id}/result/files/{index}")).send().await?;
        Self::check(res).await
    }
}

#[cfg(test)]
mod tests {
    //! The PDF calls against a real in-process server and real PDFium. They need `ORANGEFILE_PDFIUM`
    //! and the `of-pdf-worker` binary (`cargo build -p file-core`); without either they say so and return.
    use super::*;
    use file_core::pdf::{HostConfig, PdfHost, WorkerProgram};
    use std::sync::Arc;

    fn worker() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let p = exe.parent()?.parent()?.join(if cfg!(windows) { "of-pdf-worker.exe" } else { "of-pdf-worker" });
        p.is_file().then_some(p)
    }

    #[tokio::test]
    async fn pdf_open_page_and_close_over_the_real_api() {
        let (Some(lib), Some(worker)) = (std::env::var_os("ORANGEFILE_PDFIUM"), worker()) else {
            eprintln!("skipped: needs ORANGEFILE_PDFIUM and a built of-pdf-worker");
            return;
        };
        let mut host = HostConfig::for_app().with_worker(WorkerProgram::Exe(worker));
        host.library_dirs = vec![PathBuf::from(lib)];
        let registry = Arc::new(file_core::Registry::bundled_with(Arc::new(PdfHost::new(host))));
        let dir = tempfile::tempdir().unwrap();
        let server = file_api::start_with(file_api::ApiConfig::local(dir.path().join("d")), registry).await.unwrap();
        let api = ApiClient::new(server.base_url(), server.token.clone());

        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../crates/file-core/tests/fixtures/pdf");
        let plain = fixtures.join("three-pages.pdf");
        let size = std::fs::metadata(&plain).unwrap().len();
        let doc = api.open_pdf(&plain, "three-pages.pdf", size, None).await.unwrap();
        assert_eq!(doc.info.page_count, 3);

        let png = api.pdf_page(&doc.id, 2, 300).await.unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(api.pdf_page(&doc.id, 9, 300).await.unwrap_err().code, "PAGE_NOT_FOUND");

        api.close_pdf(&doc.id).await.unwrap();
        api.close_pdf(&doc.id).await.unwrap(); // closing twice is fine
        assert_eq!(api.pdf_page(&doc.id, 1, 300).await.unwrap_err().code, "DOCUMENT_NOT_FOUND");

        // Passwords: asked for, checked, accepted.
        let locked = fixtures.join("encrypted.pdf");
        let size = std::fs::metadata(&locked).unwrap().len();
        assert_eq!(api.open_pdf(&locked, "e.pdf", size, None).await.unwrap_err().code, "PASSWORD_REQUIRED");
        assert_eq!(api.open_pdf(&locked, "e.pdf", size, Some("nope")).await.unwrap_err().code, "WRONG_PASSWORD");
        let doc = api.open_pdf(&locked, "e.pdf", size, Some("open-sesame")).await.unwrap();
        assert!(doc.info.encrypted);

        let missing = api.open_pdf(&dir.path().join("none.pdf"), "none.pdf", 1, None).await.unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
        server.shutdown().await;
    }
}
