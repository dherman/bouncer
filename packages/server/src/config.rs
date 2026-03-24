    pub s3_bucket: String,
    pub s3_endpoint: Option<String>,
    pub port: u16,
            s3_bucket: std::env::var("S3_BUCKET")
                .unwrap_or_else(|_| "{project-name}-documents".to_string()),
            s3_endpoint: std::env::var("S3_ENDPOINT").ok(),
            p...{truncated}