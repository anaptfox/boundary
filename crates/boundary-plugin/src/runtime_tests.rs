//! Store replacement and rebuild failure boundaries.
#![allow(clippy::expect_used)]

use super::*;
use crate::{PluginLifetime, guest_engine};

const COMPONENT: &[u8] =
    include_bytes!("../../../tests/fixtures/wasm-imports/compliant.component.wasm");
const INTERFACE: &str = "boundary:guest/footprints@1.0.0";

fn instance(lifetime: PluginLifetime) -> GuestInstance {
    let engine = guest_engine().expect("engine");
    let component = PluginComponent::load_with(&engine, COMPONENT, "test-world", lifetime)
        .expect("compile component");
    let imports = HostFunctions::new()
        .provide("images", |_| HostReply::Returned("{}".into()))
        .expect("host import");
    GuestInstance::instantiate(
        &engine,
        &component,
        &imports,
        INTERFACE,
        GuestLimits::default(),
    )
    .expect("initial instance")
}

#[test]
fn trapped_persistent_store_is_released_and_rebuild_failure_stays_unknown() {
    let mut guest = instance(PluginLifetime::Persistent);
    assert!(guest.call("images-make-thumbnail", "{}").is_fault());
    assert!(
        guest.live.is_none(),
        "release the trapped store immediately"
    );
    assert_eq!(guest.fuel_remaining(), None);

    guest.blueprint.limits.startup_fuel = 0;
    let failed = guest.call("images-make-thumbnail", "{}");
    assert_eq!(failed.certainty(), Some(InvocationCertainty::Unknown));
    assert!(
        guest.live.is_none(),
        "failed startup must not restore an old store"
    );

    guest.blueprint.limits.startup_fuel = GuestLimits::default().startup_fuel;
    let next = guest.call("images-make-thumbnail", "{}");
    assert!(next.is_fault(), "fixture export traps on every fresh store");
    assert!(!format!("{next:?}").contains("could not be rebuilt"));
}

#[test]
fn spent_per_call_store_is_released_even_when_replacement_fails() {
    let mut guest = instance(PluginLifetime::PerCall);
    // A missing export does not enter Wasm, but consumes this per-call instance.
    assert!(guest.call("absent", "{}").is_fault());
    assert!(guest.live.is_some());
    guest.blueprint.limits.startup_fuel = 0;
    let failed = guest.call("images-make-thumbnail", "{}");
    assert_eq!(failed.certainty(), Some(InvocationCertainty::Unknown));
    assert!(
        guest.live.is_none(),
        "the spent heap must not survive replacement failure"
    );
}

#[test]
fn pre_execution_refusal_remains_not_started_and_can_recover() {
    let mut guest = instance(PluginLifetime::PerCall);
    assert!(guest.call("images-make-thumbnail", "{}").is_fault());
    guest.blueprint.interface = "unprovided:interface/footprints@1.0.0".into();
    let refused = guest.call("images-make-thumbnail", "{}");
    assert!(
        refused.is_not_started(),
        "import refusal precedes guest startup"
    );
    assert!(guest.live.is_none());
    guest.blueprint.interface = INTERFACE.into();
    let recovered = guest.call("images-make-thumbnail", "{}");
    assert_eq!(recovered.certainty(), Some(InvocationCertainty::Unknown));
    assert!(!format!("{recovered:?}").contains("could not be rebuilt"));
}
