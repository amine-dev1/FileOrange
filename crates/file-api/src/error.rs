use crate::types::{ErrorBody, ErrorDetail};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

tokio::task_local! {
    pub static REQUEST_ID: String;
}

pub fn current_request_id() -> String {
    REQUEST_ID.try_with(|id| id.clone()).unwrap_or_else(|_| "req_unknown".into())
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "INVALID_REQUEST", message)
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "A valid access token is required.")
    }
    pub fn forbidden(code: &'static str, message: &str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }
    pub fn job_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "JOB_NOT_FOUND", "No such job. It may have expired.")
    }
    pub fn document_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "DOCUMENT_NOT_FOUND", "No such document. It may have been closed; open it again.")
    }
    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", message)
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_FORMAT", message)
    }
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
    /// Log the real cause; tell the client nothing about it.
    pub fn internal(cause: impl std::fmt::Display) -> Self {
        tracing::error!(request_id = %current_request_id(), "internal error: {cause}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Something went wrong on the server.")
    }

    /// Generic body for errors produced by the framework (404 route, 405, ...).
    pub fn from_status(status: StatusCode) -> Self {
        let (code, msg) = match status {
            StatusCode::NOT_FOUND => ("NOT_FOUND", "Not found."),
            StatusCode::METHOD_NOT_ALLOWED => ("METHOD_NOT_ALLOWED", "This method isn't allowed here."),
            StatusCode::PAYLOAD_TOO_LARGE => ("PAYLOAD_TOO_LARGE", "The upload exceeds the size limit."),
            StatusCode::UNSUPPORTED_MEDIA_TYPE => ("UNSUPPORTED_FORMAT", "Unsupported content type."),
            s if s.is_server_error() => ("INTERNAL_ERROR", "Something went wrong on the server."),
            _ => ("INVALID_REQUEST", "The request couldn't be processed."),
        };
        Self::new(status, code, msg)
    }
}

impl From<file_core::Error> for ApiError {
    fn from(e: file_core::Error) -> Self {
        use file_core::Error as E;
        match e {
            E::Unsupported(_) | E::UnsupportedFormat(_) => Self::unsupported(e.user_message()),
            E::UnsupportedConversion { .. } => Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_CONVERSION", e.user_message()),
            E::EngineUnavailable { .. } => Self::new(StatusCode::UNPROCESSABLE_ENTITY, "ENGINE_UNAVAILABLE", e.user_message()),
            E::PasswordRequired => Self::new(StatusCode::UNPROCESSABLE_ENTITY, "PASSWORD_REQUIRED", e.user_message()),
            E::WrongPassword => Self::new(StatusCode::UNPROCESSABLE_ENTITY, "WRONG_PASSWORD", e.user_message()),
            E::CorruptPdf(_) => Self::new(StatusCode::UNPROCESSABLE_ENTITY, "CORRUPT_PDF", e.user_message()),
            E::PageOutOfRange { .. } => Self::new(StatusCode::NOT_FOUND, "PAGE_NOT_FOUND", e.user_message()),
            E::PdfWorker(ref cause) => {
                tracing::error!(request_id = %current_request_id(), "pdf worker failed: {cause}");
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "PDF_WORKER_FAILED", e.user_message())
            }
            E::InvalidRequest(_) | E::UnsafeEntry(_) => Self::invalid(e.user_message()),
            other => Self::internal(other),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error: ErrorDetail { code: self.code.into(), message: self.message, request_id: current_request_id() },
        };
        (self.status, Json(body)).into_response()
    }
}
