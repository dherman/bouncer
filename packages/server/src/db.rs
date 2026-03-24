/// Database connection wrapper.
#[derive(Clone)]
pub struct Database {
    pub pool: PgPool,
}