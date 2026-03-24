use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::{db:...{truncated}
#[derive(Deserialize)]
pub struct UpdateDocumentRequest {
    pub title: Option<String>,
}

// --- Handlers ---

pub async fn list_documents(
    State(state): State<Arc<AppState>>,
) -> Result<Json<V...{truncated}