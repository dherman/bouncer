use {project-name}_server::{build_router, AppState};
use {project-name}_server::{config, db, documents, sidecar};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::ini...{truncated}