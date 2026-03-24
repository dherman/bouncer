/// A document row with the requesting user's role and ownership info.
#[derive(Debug, sqlx::FromRow)]
pub struct DocumentWithRole {
    pub id: Uuid,
    pub title: String,
    pub schema_version: i3...{truncated}
    pub async fn list_accessible_documents(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<DocumentRow>, sqlx::Error> {
        sqlx::query_as::<_, DocumentRow>(
            r#"SELECT d.id,...{truncated}