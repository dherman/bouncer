use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use super::middleware::AuthUser;
use crate::auth::{jwt, ...{truncated}
// ── Handlers ──
pub async fn ws_token(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<WsTokenResponse>, AppError> {
    let ws_token = jwt::create_ws_token(auth.user_id, &state.config.jw...{truncated}