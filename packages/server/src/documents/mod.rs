pub mod api;
pub mod storage;

use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, RwLock};
use uuid::Uuid;
use y...{truncated}
            });
        // Leak the subscription so it lives as long as the Doc.
        // observe_update_v1 returns Result<Subscription, ...> — unwrap and forget it.
        if let Ok(sub) = sub {
 ...{truncated}
        let awareness = self.awareness.blocking_read();
        let sub = awareness
            .doc()
            .observe_update_v1(move |_txn, event| {
                let update_data = event.updat...{truncated}
    pub async fn flush(
        &self,
        db: &Database,
        storage: &SnapshotStorage,
    ) -> Result<(), AppError> {
        // Encode the full doc state. The transaction and awareness mus...{truncated}
    /// Insert a pre-built session into the cache (for testing).
    pub fn preload(&self, doc_id: Uuid, session: Arc<DocumentSession>) {
        self.sessions.insert(doc_id, session);
    }

    /// ...{truncated}