//! What a guest instance may consume, and the engine that enforces it.
//!
//! Limits are not optional: there is no constructor that skips them. They live
//! in their own module because two of them are easy to get wrong in a way that
//! looks right — wasmtime asks the *limiter* for its count ceilings rather than
//! reading a configured value, and its per-memory cap is not an aggregate one.
//! Both mistakes are silent, so both are made once, here.

use wasmtime::{Config, Engine, ResourceLimiter, StoreLimits, StoreLimitsBuilder};

use crate::component::PluginError;

/// Budgets applied to every guest instance.
///
/// Defaults are chosen for the host, not by the host: a plugin that needs more
/// than this is telling you it should be native code. The override exists for
/// the rare real case and is deliberately absent from the guides.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuestLimits {
    /// Fuel for instantiation. Instantiation runs guest code, so it is metered
    /// too. It is a separate budget from `call_fuel` because the two differ by
    /// orders of magnitude in practice: startup pays for the guest's whole
    /// module initializer while a call may be a few hundred instructions. One
    /// shared number would force a per-call budget large enough to boot,
    /// making a tight call budget impossible to express.
    pub startup_fuel: u64,
    /// Fuel for one call, refilled before each invocation so every call gets
    /// the whole budget rather than whatever startup left behind.
    ///
    /// Fuel is deterministic and needs no background timer, which is why it is
    /// the default rather than a wall-clock epoch deadline: a library should
    /// not silently spawn a ticker thread. A host that wants wall-clock
    /// cancellation drives `Engine::increment_epoch` itself.
    pub call_fuel: u64,
    /// Bytes a guest may copy across host imports in one invocation: the UTF-8
    /// length of every request it sends plus every reply or declared error the
    /// host returns, summed. Startup and each call get a separate, full
    /// budget, like fuel. A request that would pass it is refused before the
    /// host function runs; a reply that would pass it is withheld from the
    /// guest. Either traps the guest with `Unknown` certainty: the guest was
    /// already running, and a withheld reply follows a host effect that may
    /// have happened. Equality is allowed. The Node host implements the same
    /// law as `hostcallCopyBytes`.
    ///
    /// This bounds copy volume, not retained host data or the host function's
    /// own work.
    pub hostcall_copy_bytes: usize,
    /// Maximum linear memory one instance may grow to, in bytes.
    pub memory_bytes: usize,
    /// Maximum table elements one instance may grow to.
    pub table_elements: usize,
    /// Maximum linear memories the store may create. wasmtime 49 defaults
    /// this to 10,000; we set it explicitly so the per-memory cap is also
    /// an aggregate ceiling (`memory_bytes * memories`).
    pub memories: usize,
    /// Maximum tables the store may create. wasmtime 49 defaults this to
    /// 10,000.
    pub tables: usize,
    /// Maximum core instances the store may create. wasmtime 49 defaults
    /// this to 10,000.
    pub instances: usize,
}

impl Default for GuestLimits {
    fn default() -> Self {
        Self {
            startup_fuel: 100_000_000,
            call_fuel: 1_000_000_000,
            hostcall_copy_bytes: 128 * 1024 * 1024,
            memory_bytes: 64 * 1024 * 1024,
            table_elements: 10_000,
            memories: 4,
            tables: 8,
            instances: 16,
        }
    }
}

impl GuestLimits {
    /// The wasmtime store limits these budgets compile to.
    ///
    /// `memory_size` caps each linear memory. Count limits are set
    /// explicitly because wasmtime 49 defaults memories, tables, and
    /// instances to 10,000 each, which would make a 64 MiB per-memory cap
    /// a 640 GiB aggregate.
    #[must_use]
    pub fn store_limits(self) -> StoreLimits {
        StoreLimitsBuilder::new()
            .memory_size(self.memory_bytes)
            .table_elements(self.table_elements)
            .memories(self.memories)
            .tables(self.tables)
            .instances(self.instances)
            .build()
    }

    /// Aggregate linear-memory ceiling implied by these limits, in bytes:
    /// per-memory cap times the number of memories the store may create.
    #[must_use]
    pub fn aggregate_memory_bytes(self) -> usize {
        self.memory_bytes
            .saturating_mul(ResourceLimiter::memories(&self.store_limits()))
    }
}

/// Builds an engine configured for guest realizations.
///
/// Fuel metering must be enabled on the engine, not the store, so a host that
/// builds its own `Engine` can silently lose the CPU budget. This constructor
/// exists so that cannot happen by accident.
///
/// # Errors
///
/// Returns [`PluginError::Load`] when the engine rejects the configuration.
///
/// Component-model async is always disabled, whatever Cargo features are
/// unified into `wasmtime`: a component using it is refused at load with
/// `NotStarted` certainty.
pub fn guest_engine() -> Result<Engine, PluginError> {
    let mut config = Config::new();
    config.consume_fuel(true);
    // The plugin profile is synchronous `(string) -> result<string, string>`.
    // Cargo unifies features across a dependency graph, so another crate
    // enabling wasmtime's `component-model-async` would otherwise turn async
    // component types, tasks and callbacks on for this engine. Switch the
    // proposal off explicitly instead of relying on feature exclusivity.
    config.wasm_features(wasmtime::WasmFeatures::CM_ASYNC, false);
    // Epoch interruption is available for a host that runs its own ticker; it
    // is off here because a library must not spawn a background thread.
    Engine::new(&config).map_err(|error| PluginError::Load(error.to_string()))
}

/// Per-store state: the memory ceiling and nothing else. Deliberately carries
/// no host context.
pub(crate) struct GuestState {
    pub(crate) limits: StoreLimits,
    /// Linear-memory bytes this store has granted across every memory.
    pub(crate) total_memory_bytes: usize,
    /// The ceiling that total may not cross.
    pub(crate) aggregate_memory_bytes: usize,
    /// Bytes copied across host imports since startup or the current call began.
    hostcall_used: usize,
    /// The most that may be copied before the next reset.
    hostcall_budget: usize,
}

impl GuestState {
    pub(crate) fn new(limits: GuestLimits) -> Self {
        Self {
            limits: limits.store_limits(),
            total_memory_bytes: 0,
            aggregate_memory_bytes: limits.aggregate_memory_bytes(),
            hostcall_used: 0,
            hostcall_budget: limits.hostcall_copy_bytes,
        }
    }

    /// Starts a fresh host-call copy budget, for startup and for each call.
    pub(crate) fn reset_hostcall_budget(&mut self) {
        self.hostcall_used = 0;
    }

    /// Counts `bytes` copied across a host import, or refuses when the total
    /// would pass the budget. A refusal is a trap, never a declared error.
    pub(crate) fn charge_hostcall(&mut self, bytes: usize, what: &str) -> wasmtime::Result<()> {
        let total = self.hostcall_used.saturating_add(bytes);
        if total > self.hostcall_budget {
            return Err(wasmtime::Error::msg(format!(
                "host import {what} would pass the {}-byte copy budget",
                self.hostcall_budget
            )));
        }
        self.hostcall_used = total;
        Ok(())
    }
}

impl ResourceLimiter for GuestState {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        // `memory_size` caps each linear memory, so the per-memory answer is
        // not the whole answer. Track the total this store has handed out and
        // refuse a growth that would put the store over the aggregate the
        // host declared. Without this, `memories` alone would still allow
        // `memory_bytes * memories` in the worst case; with it, the aggregate
        // is the aggregate.
        if !self.limits.memory_growing(current, desired, maximum)? {
            return Ok(false);
        }
        let total = self.total_memory_bytes.saturating_sub(current);
        if total.saturating_add(desired) > self.aggregate_memory_bytes {
            return Ok(false);
        }
        self.total_memory_bytes = total.saturating_add(desired);
        Ok(true)
    }

    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        self.limits.table_growing(current, desired, maximum)
    }

    // wasmtime asks the limiter for these, not the `StoreLimits` value the
    // limiter holds. Without forwarding them the trait defaults answer —
    // 10,000 memories, tables, and instances each — and every count a host
    // configured is silently discarded. See wasmtime 49
    // `src/runtime/limits.rs`: `DEFAULT_*_LIMIT` at the trait, the real
    // values on `StoreLimits`' own impl.
    fn instances(&self) -> usize {
        self.limits.instances()
    }

    fn tables(&self) -> usize {
        self.limits.tables()
    }

    fn memories(&self) -> usize {
        self.limits.memories()
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::{GuestLimits, GuestState, ResourceLimiter};

    fn state(limits: GuestLimits) -> GuestState {
        GuestState::new(limits)
    }

    /// wasmtime asks the limiter for these counts, not the `StoreLimits` the
    /// limiter holds. A limiter that does not forward them answers with the
    /// trait defaults of 10,000 each, and every configured count is silently
    /// discarded — which is what turned a documented 256 MiB ceiling into a
    /// 640 GiB one.
    #[test]
    fn the_limiter_reports_the_configured_counts_not_wasmtime_defaults() {
        let limits = GuestLimits::default();
        let state = state(limits);
        assert_eq!(ResourceLimiter::memories(&state), limits.memories);
        assert_eq!(ResourceLimiter::tables(&state), limits.tables);
        assert_eq!(ResourceLimiter::instances(&state), limits.instances);
        assert_ne!(
            ResourceLimiter::memories(&state),
            10_000,
            "the wasmtime default must not be what a guest gets"
        );
    }

    /// The published ceiling and the enforced ceiling must be the same
    /// number. `memory_size` caps each memory, so several memories under the
    /// per-memory cap can still cross the aggregate; the limiter has to add
    /// them up.
    #[test]
    fn growth_stboundary_at_the_aggregate_the_host_declared() {
        let limits = GuestLimits {
            memory_bytes: 1024,
            memories: 2,
            ..GuestLimits::default()
        };
        assert_eq!(limits.aggregate_memory_bytes(), 2048);

        let mut state = state(limits);
        assert!(
            state.memory_growing(0, 1024, None).expect("first memory"),
            "one memory at the per-memory cap is allowed"
        );
        assert!(
            state.memory_growing(0, 1024, None).expect("second memory"),
            "a second memory to the aggregate is allowed"
        );
        assert!(
            !state.memory_growing(0, 1, None).expect("third memory"),
            "one byte past the aggregate must be refused, not granted per-memory"
        );
    }

    /// The law is a running sum with equality allowed, and a refused charge
    /// does not count.
    #[test]
    fn the_hostcall_budget_is_a_sum_that_allows_equality() {
        let mut state = state(GuestLimits {
            hostcall_copy_bytes: 10,
            ..GuestLimits::default()
        });
        state.charge_hostcall(4, "request").expect("4 of 10");
        state
            .charge_hostcall(6, "reply")
            .expect("equality is allowed");
        assert!(state.charge_hostcall(1, "request").is_err(), "11 of 10");
        state.reset_hostcall_budget();
        state
            .charge_hostcall(10, "request")
            .expect("a reset restores the whole budget");
    }

    #[test]
    fn a_single_memory_still_cannot_pass_its_own_cap() {
        let limits = GuestLimits {
            memory_bytes: 1024,
            memories: 4,
            ..GuestLimits::default()
        };
        let mut state = state(limits);
        assert!(
            !state.memory_growing(0, 1025, None).expect("oversized"),
            "the per-memory cap still applies below the aggregate"
        );
    }
}
