- [x] Create `packages/server/src/documents/storage.rs`
- [x] Implement the S3 client wrapper:
- [x] Add `pub mod storage;` to `packages/server/src/documents/mod.rs`
## Verification

- [ ] Start server with Postgres and LocalStack running
- [ ] Open two browser tabs, edit a document collaboratively
- [ ] Wait 5+ seconds with no edits — check S3 for a snapshot file...{truncated}
- [x] `cargo test` passes all new integration tests
- [x] Start server with Postgres and LocalStack running