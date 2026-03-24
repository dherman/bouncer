    pub async fn clear_update_log(&self, document_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM update_log WHERE document_id = $1")
            .bind(document_id)
           ...{truncated}