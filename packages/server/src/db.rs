    pub async fn update_document_title(
        &self,
        id: Uuid,
        title: &str,
    ) -> Result<Option<DocumentRow>, sqlx::Error> {
        sqlx::query_as::<_, DocumentRow>(
            ...{truncated}