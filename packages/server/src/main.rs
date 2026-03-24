    let database = db::Database::connect(&cfg.database_url)
        .await
        .expect("Failed to connect to database");

    sqlx::migrate!()
        .run(&database.pool)
        .await
        ....{truncated}
use {project-name}_server::{build_router, AppState};
use {project-name}_server::{config, db, documents, sidecar};
use {project-name}_server::{build_router, AppState};
use {project-name}_server::{config, db, documents, sidecar};
use sqlx::migrate::Migrator;