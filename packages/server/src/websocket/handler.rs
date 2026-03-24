pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<Uuid>,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    // Verify document exists in dat...{truncated}
    // get_or_load checks the in-memory cache first, then falls back to
    // loading from the database + S3. If the document doesn't exist in either
    // place, it returns a 404.
    let session =...{truncated}