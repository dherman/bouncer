use axum::{
    routing::{delete, get, patch, post},
    Json, Router,
};
        .route("/api/docs/{id}", get(documents::api::get_document))
        .route(
            "/api/docs/{id}",
            delete(documents::api::delete_document),
        )
        .route(
       ...{truncated}