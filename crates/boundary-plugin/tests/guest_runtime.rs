//! Instantiation, limits, and outcome classification.
//!
//! The fixtures here have stub bodies that trap when called. That is exactly
//! the case worth pinning: a realization that fails leaves the consequence
//! unknown, and nothing may quietly turn that into a domain error or into
//! evidence that the effect did not happen.
#![allow(clippy::expect_used)]

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use boundary_plugin::{
    GuestInstance, GuestLimits, GuestOutcome, HostFunctions, HostReply, InvocationCertainty,
    PluginComponent, PluginError, PluginLifetime, guest_engine,
};

const COMPLIANT: &[u8] =
    include_bytes!("../../../tests/fixtures/wasm-imports/compliant.component.wasm");
const OVERREACH: &[u8] =
    include_bytes!("../../../tests/fixtures/wasm-imports/overreach.component.wasm");

const WIT_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const INTERFACE: &str = "boundary:guest/footprints@1.0.0";

fn imports_with_images() -> HostFunctions {
    HostFunctions::new()
        .provide("images", |request| {
            HostReply::Returned(format!("{{\"echo\":{request}}}"))
        })
        .expect("images is spellable")
}

#[test]
fn a_guest_within_the_offer_instantiates() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let instance = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits::default(),
    );
    assert!(instance.is_ok(), "{:?}", instance.err());
}

#[test]
fn an_unmapped_import_stboundary_instantiation_before_any_guest_code_runs() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, OVERREACH, WIT_DIGEST).expect("load");
    let error = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits::default(),
    )
    .err()
    .expect("instantiation must be refused");

    assert_eq!(
        error,
        PluginError::UnmappedImports {
            unmapped: vec!["boundary:guest/footprints@1.0.0#publications".to_owned()],
            provided: vec!["images".to_owned()],
        }
    );
}

#[test]
fn the_host_function_is_never_handed_a_context() {
    // The host closure captures its own state. Nothing about an invocation
    // context is passed through the guest, and this test exists so a future
    // change that widens the signature has to break it deliberately.
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let imports = HostFunctions::new()
        .provide("images", move |_request| {
            counter.fetch_add(1, Ordering::SeqCst);
            HostReply::Returned("{}".to_owned())
        })
        .expect("images is spellable");

    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let instance =
        GuestInstance::instantiate(&engine, &guest, &imports, INTERFACE, GuestLimits::default());
    assert!(instance.is_ok());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "instantiation alone must not call into host functions"
    );
}

#[test]
fn a_trapping_guest_yields_a_fault_not_a_declared_error() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let mut instance = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("instantiate");

    // The fixture's stub body traps.
    let outcome = instance.call(
        "images-make-thumbnail",
        "{\"imageId\":\"a\",\"maxWidth\":10}",
    );
    assert!(
        outcome.is_fault(),
        "a trap must remain a fault, got {outcome:?}"
    );
    assert!(
        !matches!(outcome, GuestOutcome::DeclaredError(_)),
        "a trap must never be reclassified as a domain error"
    );
}

/// wasmtime marks a store permanently on any trap and refuses to re-enter
/// it. Without a rebuild, one exhausted budget would end the realization for
/// every later caller — and each of those dead calls would report an unknown
/// consequence for an effect that provably never started.
#[test]
fn a_realization_survives_a_trap_and_serves_the_next_caller() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let mut instance = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("instantiate");

    let input = "{\"imageId\":\"a\",\"maxWidth\":10}";
    let first = instance.call("images-make-thumbnail", input);
    assert!(first.is_fault(), "the fixture traps, got {first:?}");

    // The same call again. Before the rebuild this returned
    // `Fault("cannot enter component instance")` forever.
    let second = instance.call("images-make-thumbnail", input);
    assert!(
        !format!("{second:?}").contains("cannot enter component instance"),
        "a trap must not brick the realization, got {second:?}"
    );
    assert!(
        second.is_fault(),
        "this fixture traps every time, so the second call is a fault too, got {second:?}"
    );

    // And a call that does not trap still resolves normally afterwards,
    // proving the instance is genuinely live rather than merely re-reporting.
    let after = instance.call("images-rotate", "{}");
    assert_eq!(
        after,
        GuestOutcome::Fault {
            certainty: InvocationCertainty::Unknown,
            reason: "guest does not export \"images-rotate\"".to_owned(),
        },
        "a rebuilt instance reports a missing export, not a poisoned store"
    );
    assert!(
        !after.is_not_started(),
        "the realization is usable, so nothing here is a not-started outcome"
    );
}

/// `name.rs` documents that distinct ids can derive one WIT name and says
/// the projector must detect it. So must the host map: inserting over the
/// first entry would leave the host believing it provided two capabilities
/// while the guest reaches whichever was provided last.
#[test]
fn two_footprints_deriving_one_wit_name_are_refused_not_silently_merged() {
    let error = HostFunctions::new()
        .provide("images.byId", |_| HostReply::Returned(String::new()))
        .expect("first footprint is fine")
        .provide("images.by-id", |_| HostReply::Returned(String::new()))
        .expect_err("a colliding footprint must be refused");
    assert_eq!(error.derived.as_deref(), Some("images-by-id"));
    let message = error.to_string();
    assert!(
        message.contains("images.byId"),
        "the refusal must name the footprint already holding the name, got {message}"
    );

    // Re-providing the *same* footprint stays a legitimate override.
    HostFunctions::new()
        .provide("images", |_| HostReply::Returned(String::new()))
        .expect("first")
        .provide("images", |_| HostReply::Returned(String::new()))
        .expect("replacing one footprint's own function is not a collision");
}

/// The WIT profile carries `result<string, string>`, so a host function that
/// started an effect and cannot confirm it has only `ok` and `err` to choose
/// from — and `err` is a declared error the guest may catch and flatten into
/// `ok`. `HostReply::Unknown` stops the call instead, so uncertainty reaches
/// the caller as uncertainty rather than as a domain outcome.
#[test]
fn a_host_that_cannot_confirm_its_effect_stboundary_the_call() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let imports = HostFunctions::new()
        .provide("images", |_request| {
            HostReply::Unknown("the write may have landed".to_owned())
        })
        .expect("images is spellable");
    let mut instance =
        GuestInstance::instantiate(&engine, &guest, &imports, INTERFACE, GuestLimits::default())
            .expect("instantiate");

    let outcome = instance.call(
        "images-make-thumbnail",
        "{\"imageId\":\"a\",\"maxWidth\":10}",
    );
    assert!(
        !matches!(outcome, GuestOutcome::DeclaredError(_)),
        "an unconfirmed host effect must never arrive as a domain error, got {outcome:?}"
    );
    assert!(
        !outcome.is_not_started(),
        "the guest did run, so this is not a not-started outcome"
    );
    assert!(
        outcome.is_fault(),
        "an unconfirmed host effect leaves the consequence unknown, got {outcome:?}"
    );
}

#[test]
fn calling_an_export_the_guest_does_not_have_is_a_fault() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let mut instance = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("instantiate");

    let outcome = instance.call("images-rotate", "{}");
    assert_eq!(
        outcome,
        GuestOutcome::Fault {
            certainty: InvocationCertainty::Unknown,
            reason: "guest does not export \"images-rotate\"".to_owned(),
        }
    );
}

/// The default lifetime gives every call its own store, so a guest cannot
/// carry heap state from one caller to the next. The fixture traps every
/// time, so the observable fact here is that each call is judged on its own:
/// a trap on the first never turns the second into a poisoned-store error.
#[test]
fn each_call_runs_on_a_fresh_store_by_default() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    assert_eq!(guest.lifetime(), PluginLifetime::PerCall);
    let mut instance = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("instantiate");

    let first = instance.call("images-make-thumbnail", "{}");
    let second = instance.call("images-make-thumbnail", "{}");
    assert!(first.is_fault(), "fixture stub traps, got {first:?}");
    assert!(
        second.is_fault(),
        "fixture stub traps every time, got {second:?}"
    );
    assert!(
        !format!("{second:?}").contains("cannot enter component instance"),
        "a fresh store per call never inherits an earlier trap, got {second:?}"
    );
}

/// Opting into a persistent lifetime is a different realization, and it is
/// the one in which a store is reused between calls.
#[test]
fn a_persistent_guest_reuses_its_store_and_is_a_distinct_realization() {
    let engine = guest_engine().expect("engine");
    let per_call = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let persistent =
        PluginComponent::load_with(&engine, COMPLIANT, WIT_DIGEST, PluginLifetime::Persistent)
            .expect("load");
    assert_ne!(
        per_call.realization_id(),
        persistent.realization_id(),
        "whether heap state can outlive a call is part of what was bound"
    );
    let mut instance = GuestInstance::instantiate(
        &engine,
        &persistent,
        &imports_with_images(),
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("instantiate");
    let first = instance.call("images-make-thumbnail", "{}");
    let second = instance.call("images-make-thumbnail", "{}");
    assert!(first.is_fault(), "fixture stub traps, got {first:?}");
    assert!(
        second.is_fault() && !format!("{second:?}").contains("cannot enter component instance"),
        "a trap rebuilds the persistent store rather than bricking it, got {second:?}"
    );
}

#[test]
fn limits_are_applied_and_instantiation_itself_is_metered() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let limits = GuestLimits::default();
    let instance =
        GuestInstance::instantiate(&engine, &guest, &imports_with_images(), INTERFACE, limits)
            .expect("instantiate");

    // Fuel is live on the store, so the CPU budget is real rather than
    // declared. Startup and calls have separate budgets, and a call refills
    // before it runs so every invocation gets the whole call budget rather
    // than whatever startup left behind.
    let remaining = instance.fuel_remaining().expect("fuel is enabled");
    assert!(
        remaining < limits.startup_fuel,
        "instantiation must be metered, {remaining} vs {}",
        limits.startup_fuel
    );
    assert!(remaining > 0, "startup must not exhaust the budget");
    assert_eq!(limits.memory_bytes, 64 * 1024 * 1024);
}

#[test]
fn store_limits_do_not_inherit_wasmtime_49_count_defaults() {
    use wasmtime::{ResourceLimiter, StoreLimitsBuilder};

    let wasmtime_default = StoreLimitsBuilder::new().build();
    assert_eq!(
        ResourceLimiter::memories(&wasmtime_default),
        10_000,
        "wasmtime 49 default memories; this test pins the version, not our policy"
    );
    assert_eq!(ResourceLimiter::tables(&wasmtime_default), 10_000);
    assert_eq!(ResourceLimiter::instances(&wasmtime_default), 10_000);

    let limits = GuestLimits::default();
    let applied = limits.store_limits();
    // Four memories at 64 MiB is a 256 MiB aggregate ceiling. wasmtime's
    // default of 10,000 memories would make the same per-memory cap 640 GiB.
    assert_eq!(ResourceLimiter::memories(&applied), 4);
    assert_eq!(ResourceLimiter::tables(&applied), 8);
    assert_eq!(ResourceLimiter::instances(&applied), 16);
    assert_eq!(limits.aggregate_memory_bytes(), 4 * 64 * 1024 * 1024);
    assert!(
        !ResourceLimiter::memory_growing(&mut applied.clone(), 0, 64 * 1024 * 1024 + 1, None)
            .expect("limiter answers"),
        "per-memory cap must still refuse a single memory above 64 MiB"
    );
}

#[test]
fn a_zero_fuel_budget_stboundary_the_guest_at_instantiation() {
    let engine = guest_engine().expect("engine");
    let guest = PluginComponent::load(&engine, COMPLIANT, WIT_DIGEST).expect("load");
    let error = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits {
            startup_fuel: 0,
            ..GuestLimits::default()
        },
    )
    .err()
    .expect("a zero budget must stop the guest");

    // Instantiation is guest execution, so an impossible budget is refused
    // there rather than at the first call. The guest never gets to run.
    let PluginError::Startup { reason: message } = &error else {
        unreachable!("expected a startup failure, got {error:?}")
    };
    assert!(message.contains("fuel"), "{message}");
}

#[test]
fn a_zero_call_budget_traps_without_spending_the_startup_budget() {
    let engine = guest_engine().expect("engine");
    let guest =
        PluginComponent::load_with(&engine, COMPLIANT, WIT_DIGEST, PluginLifetime::Persistent)
            .expect("load");
    let mut instance = GuestInstance::instantiate(
        &engine,
        &guest,
        &imports_with_images(),
        INTERFACE,
        GuestLimits {
            call_fuel: 0,
            ..GuestLimits::default()
        },
    )
    .expect("startup has its own nonzero fuel budget");

    // Wasmtime 49 changes fuel accounting. A successful startup must never
    // lend its remaining budget to a call, including after rebuilding a store
    // poisoned by the previous exhausted call.
    for _ in 0..2 {
        let outcome = instance.call("images-make-thumbnail", "{}");
        let GuestOutcome::Fault { certainty, reason } = outcome else {
            unreachable!("zero call fuel must trap, got {outcome:?}")
        };
        assert_eq!(certainty, InvocationCertainty::Unknown);
        assert!(reason.contains("fuel"), "{reason}");
        assert!(
            instance.fuel_remaining().is_none(),
            "a trap discards the store"
        );
    }
}
