/// Shared application state, available to all handlers.
pub struct AppState {
    pub db: db::Database,
    pub document_sessions: Arc<documents::SessionManager>,
    pub storage: documents::storage:...{truncated}