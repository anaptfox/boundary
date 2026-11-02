//! Per-type cache of the compiled portable schema used to validate decoding.

use std::{
    any::TypeId,
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, PoisonError},
};

use crate::program::PortableSchema;

use super::WireError;

type Cache = Mutex<HashMap<TypeId, Arc<PortableSchema>>>;

/// Returns the compiled portable schema for `T`, compiling it at most once per
/// process. A type that cannot be expressed in the profile is retried and
/// reported on every call, never cached.
pub(super) fn compiled_schema<T: schemars::JsonSchema + 'static>()
-> Result<Arc<PortableSchema>, WireError> {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let id = TypeId::of::<T>();
    if let Some(found) = cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&id)
    {
        return Ok(Arc::clone(found));
    }
    let schema = Arc::new(
        PortableSchema::for_type::<T>().map_err(|error| WireError::Schema(error.to_string()))?,
    );
    cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id, Arc::clone(&schema));
    Ok(schema)
}
