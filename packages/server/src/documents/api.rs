use crate::db::{DocumentRow, DocumentWithRole};
use crate::errors::AppError;
use crate::AppState;

#[derive(Serialize)]
pub struct DocumentSummary {
    pub id: Uuid,
    pub title: String,
    pub cr...{truncated}
pub async fn list_documents(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<DocumentSummary>>, AppError> {
    let rows = state
        .db
        .list_accessible_d...{truncated}
pub async fn get_document(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<DocumentSummary>, AppError> {
    let row = state
        .db
        ...{truncated}