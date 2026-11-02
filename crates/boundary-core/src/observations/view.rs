use super::{ObservationFault, ObservationSnapshot};

/// One captured native observation and its complete host token.
#[derive(Clone, Debug)]
pub enum Observation<K, Q, T> {
    /// Presence/content evidence for a point key.
    Point {
        /// Exact owned point key.
        key: K,
        /// Whether the observed key existed.
        present: bool,
        /// Complete host-issued evidence.
        token: T,
    },
    /// Membership/order/content evidence for an exact query descriptor.
    Query {
        /// Exact owned query descriptor.
        query: Q,
        /// Complete host-issued evidence.
        token: T,
    },
}

pub(crate) type Evidence<S> = Observation<
    <S as ObservationSnapshot>::Key,
    <S as ObservationSnapshot>::Query,
    <S as ObservationSnapshot>::Token,
>;

/// Capturing view given to a read evaluator inside one immutable snapshot.
pub struct ObservationView<'a, S: ObservationSnapshot> {
    snapshot: &'a S,
    pub(crate) evidence: Vec<Evidence<S>>,
    pub(crate) failed: bool,
}

impl<'a, S: ObservationSnapshot> ObservationView<'a, S> {
    pub(crate) fn new(snapshot: &'a S) -> Self {
        Self {
            snapshot,
            evidence: Vec::new(),
            failed: false,
        }
    }

    /// Reads and captures exact key, absence, and content evidence.
    ///
    /// # Errors
    /// Returns an adapter failure. If the evaluator handles it and returns a
    /// valid domain fallback, that answer is returned without retention.
    pub fn get(&mut self, key: &S::Key) -> Result<Option<S::Value>, ObservationFault> {
        let observation = self.snapshot.get(key).inspect_err(|_| self.failed = true)?;
        self.evidence.push(Observation::Point {
            key: key.clone(),
            present: observation.value.is_some(),
            token: observation.token,
        });
        Ok(observation.value)
    }

    /// Queries and captures the exact descriptor and membership/order/content token.
    ///
    /// # Errors
    /// Returns an adapter failure and marks the captured execution incomplete.
    pub fn query(&mut self, query: &S::Query) -> Result<S::QueryResult, ObservationFault> {
        let observation = self
            .snapshot
            .query(query)
            .inspect_err(|_| self.failed = true)?;
        self.evidence.push(Observation::Query {
            query: query.clone(),
            token: observation.token,
        });
        Ok(observation.value)
    }
}
