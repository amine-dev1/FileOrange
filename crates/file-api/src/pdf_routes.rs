//! `/api/v1/pdf/documents`: open a PDF, read its description, draw pages, close it.

use crate::docs::Doc;
use crate::error::ApiError;
use crate::principal::Principal;
use crate::types::PdfDocumentResponse;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::Extension;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use file_core::pdf::{PdfHost, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH};
use file_core::request::Secret;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

/// A width when the client doesn't ask for one.
const DEFAULT_WIDTH: u32 = 800;

fn host(st: &AppState) -> Result<Arc<PdfHost>, ApiError> {
    st.registry.pdf_host().ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "ENGINE_UNAVAILABLE", "PDF support isn't part of this version of OrangeFile."))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> file_core::Result<T> + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await.map_err(ApiError::internal)?.map_err(Into::into)
}

/// Deletes a half-built document folder unless it was accepted.
struct DirGuard(Option<PathBuf>);
impl Drop for DirGuard {
    fn drop(&mut self) {
        if let Some(p) = &self.0 {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

fn display_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(255).collect();
    if cleaned.is_empty() {
        "document.pdf".into()
    } else {
        cleaned
    }
}

fn response(doc: &Doc) -> PdfDocumentResponse {
    PdfDocumentResponse { id: doc.id.clone(), name: doc.name.clone(), size: doc.size, info: doc.info.clone() }
}

/// `POST /pdf/documents`: multipart with an optional `password` field, then `file`.
pub async fn open_document(State(st): State<AppState>, Extension(who): Extension<Principal>, mut mp: Multipart) -> Result<(StatusCode, Json<PdfDocumentResponse>), ApiError> {
    let host = host(&st)?;
    let limits = st.cfg.limits_for(&who);
    // Opening a PDF is an upload like any other: it counts against the daily volume, though not as a job.
    let admission = st.quota.admit(&who, &limits, 0, 0, false)?;
    // Refuse before reading a large upload if the engine can't work at all.
    {
        let h = host.clone();
        if let file_core::Availability::Unavailable { reason } = tokio::task::spawn_blocking(move || h.availability()).await.map_err(ApiError::internal)? {
            return Err(file_core::Error::EngineUnavailable { engine: "PDF tools (PDFium)".into(), reason }.into());
        }
    }

    let id = format!("doc_{}", uuid::Uuid::new_v4().simple());
    let dir = st.cfg.data_dir.join(&id);
    tokio::fs::create_dir_all(&dir).await.map_err(ApiError::internal)?;
    let mut guard = DirGuard(Some(dir.clone()));

    let mut password: Option<Secret> = None;
    let mut uploaded: Option<(String, u64)> = None;
    while let Some(mut field) = mp.next_field().await.map_err(crate::routes::multipart_err)? {
        match field.name().unwrap_or("") {
            "password" => {
                if uploaded.is_some() {
                    return Err(ApiError::invalid("Send `password` before `file`."));
                }
                let text = crate::routes::read_text(field, 1024).await?;
                password = Some(Secret::new(text)).filter(|s| !s.expose().is_empty());
            }
            "file" => {
                if uploaded.is_some() {
                    return Err(ApiError::invalid("Send one PDF at a time."));
                }
                let name = display_name(field.file_name().unwrap_or(""));
                let mut out = tokio::fs::File::create(dir.join("source.pdf")).await.map_err(ApiError::internal)?;
                let mut size: u64 = 0;
                let mut head: Vec<u8> = Vec::with_capacity(8);
                while let Some(chunk) = field.chunk().await.map_err(crate::routes::multipart_err)? {
                    size += chunk.len() as u64;
                    if size > limits.max_file_bytes {
                        return Err(ApiError::too_large(format!("The PDF is larger than the {} MB limit for one file.", limits.max_file_bytes / (1024 * 1024))));
                    }
                    admission.add_bytes(chunk.len() as u64)?;
                    if head.len() < 8 {
                        head.extend_from_slice(&chunk[..chunk.len().min(8 - head.len())]);
                        if head.len() >= 5 && file_core::formats::detect(&head) != Some(file_core::formats::PDF) {
                            return Err(file_core::Error::UnsupportedFormat(name).into());
                        }
                    }
                    out.write_all(&chunk).await.map_err(ApiError::internal)?;
                }
                out.flush().await.map_err(ApiError::internal)?;
                if file_core::formats::detect(&head) != Some(file_core::formats::PDF) {
                    return Err(file_core::Error::UnsupportedFormat(name).into());
                }
                uploaded = Some((name, size));
            }
            _ => return Err(ApiError::invalid("Unknown form field.")),
        }
    }
    let (name, size) = uploaded.ok_or_else(|| ApiError::invalid("Upload a PDF in the `file` field."))?;

    let source = dir.join("source.pdf");
    let pw = password.clone();
    let info = blocking(move || host.info(&source, pw.as_ref())).await?;

    let doc = Arc::new(Doc::new(id.clone(), who.id.clone(), dir, name, size, password, info));
    let out = response(&doc);
    for closed in st.docs.insert(doc, st.cfg.limits_for(&who).max_open_documents) {
        let _ = tokio::fs::remove_dir_all(closed).await;
    }
    guard.0 = None;
    Ok((StatusCode::CREATED, Json(out)))
}

fn find(st: &AppState, id: &str, who: &Principal) -> Result<Arc<Doc>, ApiError> {
    st.docs.get(id, &who.id).ok_or_else(ApiError::document_not_found)
}

pub async fn get_document(State(st): State<AppState>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<Json<PdfDocumentResponse>, ApiError> {
    Ok(Json(response(find(&st, &id, &who)?.as_ref())))
}

pub async fn close_document(State(st): State<AppState>, Extension(who): Extension<Principal>, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let dir = st.docs.remove(&id, &who.id).ok_or_else(ApiError::document_not_found)?;
    let _ = tokio::fs::remove_dir_all(dir).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct ImageQuery {
    pub width: Option<u32>,
}

/// `GET /pdf/documents/{id}/pages/{n}/image?width=`: page `n` (from 1) as a PNG.
pub async fn page_image(State(st): State<AppState>, Extension(who): Extension<Principal>, Path((id, n)): Path<(String, u32)>, Query(q): Query<ImageQuery>) -> Result<Response, ApiError> {
    let host = host(&st)?;
    let doc = find(&st, &id, &who)?;
    if n == 0 || n > doc.info.page_count {
        return Err(file_core::Error::PageOutOfRange { page: n }.into());
    }
    let width = q.width.unwrap_or(DEFAULT_WIDTH).clamp(MIN_RENDER_WIDTH, MAX_RENDER_WIDTH);
    let dir = doc.render_dir();
    let cached = dir.join(format!("{n}-{width}.png"));

    if tokio::fs::metadata(&cached).await.is_err() {
        tokio::fs::create_dir_all(&dir).await.map_err(ApiError::internal)?;
        if doc.note_render() {
            // Keep the cache bounded: start over rather than track recency.
            let _ = tokio::fs::remove_dir_all(&dir).await;
            tokio::fs::create_dir_all(&dir).await.map_err(ApiError::internal)?;
            doc.reset_renders();
        }
        let (source, pw, out) = (doc.source(), doc.password.clone(), cached.clone());
        blocking(move || host.render(&source, pw.as_ref(), n - 1, width, &out).map(|_| ())).await.map_err(|e| {
            // The document may have been closed while the render was queued.
            if st.docs.get(&id, &who.id).is_none() {
                ApiError::document_not_found()
            } else {
                e
            }
        })?;
    }

    let bytes = tokio::fs::read(&cached).await.map_err(|_| ApiError::document_not_found())?;
    let mut res = Response::new(Body::from(bytes));
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(res)
}
