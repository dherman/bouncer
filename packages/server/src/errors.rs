/// Application error type that maps to HTTP responses.
#[derive(Debug)]
pub enum AppError {
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::NotFound(msg) => write!(f, "Not found: {}", ms...{truncated}