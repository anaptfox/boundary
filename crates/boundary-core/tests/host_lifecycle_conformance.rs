// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Native consumption of the reviewed portable Host lifecycle v1 vector.

use std::{error::Error, io, sync::Arc};

use boundary_core::{
    ChangeFootprint, ChangesState, Compatibility, Handler, Interaction, NoError, PortableSchema,
    WireCodec, WireError, contract_compatibility,
    handoff::{HandoffInvocation, HandoffOutcome, HandoffResult, checked_handoff},
    interaction_id,
    lifecycle::{
        Admission, AdmissionDecision, AdmissionRequest, BindResult, Binding, BindingManifest,
        CompiledInteraction, InstallationCatalog, InstallationId, InstallationManifest,
        InteractionMode, InvocationCertainty, InvocationResultKind, NativeDispatchFault,
        NativeDispatchOutcome, NativeDispatchRequest, NativeDispatcher, ProjectError, Projection,
        ProjectionManifest, ProjectionModes, RealizationId, RequestCapability,
        RequestCapabilityFault, RequestControlDigest, RequestIdentity, UnrealizedReason,
        UnrealizedReport, admit_all, bind, compile_interaction, direct_realization,
        dispatch_realization, identified_request_realization, install, project, select,
    },
};
use futures::executor::block_on;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const VECTOR: &str = include_str!("../../../tests/conformance/v1/host-lifecycle.json");

#[test]
fn empty_surface_is_an_authentic_serializable_binding() -> Result<(), Box<dyn Error>> {
    let law: Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/composition.json"
    ))?;
    let projection = project(Vec::new())?;
    assert_eq!(
        projection.manifest().projection_digest().as_str(),
        law["emptySurface"]["projectionDigest"]
    );
    assert_eq!(
        projection.manifest().program().digest().as_str(),
        law["emptySurface"]["programDigest"]
    );
    assert_eq!(
        projection.manifest().interactions().len() as u64,
        law["emptySurface"]["selectedInteractions"]
    );
    let restored: ProjectionManifest =
        serde_json::from_value(serde_json::to_value(projection.manifest())?)?;
    assert_eq!(restored.interactions().len(), 0);
    let installed = install(
        InstallationId::new("observer:1")?,
        Vec::<boundary_core::lifecycle::InstallationContribution<()>>::new(),
    )?;
    let bound = match bind(&projection, &installed.installation, admit_all()) {
        BindResult::Bound(bound) => bound,
        BindResult::Unrealized(_) => {
            return Err(io::Error::other("empty observer did not bind").into());
        }
    };
    let manifest: BindingManifest =
        serde_json::from_value(serde_json::to_value(bound.binding.manifest())?)?;
    assert_eq!(
        manifest.interactions().len() as u64,
        law["emptySurface"]["bindingInteractions"]
    );
    let interaction_id = interaction_id!("todos.create").to_owned()?;
    assert!(
        HandoffInvocation::new(
            bound.binding.manifest(),
            &interaction_id,
            InteractionMode::Direct,
            json!({"title":"not exposed"})
        )
        .is_err()
    );
    assert!(bound.controller.revoke());
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostLifecycleVector {
    version: u8,
    interaction: VectorInteraction,
    projection: VectorProjection,
    compatible_actual: VectorCompatibleActual,
    installation: VectorInstallation,
    atomic_unrealized: VectorUnrealized,
    outcomes: Vec<VectorOutcome>,
    native_dispatch_outcomes: Vec<VectorNativeDispatchOutcome>,
    certainty_claims: Vec<VectorCertaintyClaim>,
    artifacts: VectorArtifacts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorArtifacts {
    installation: Value,
    binding: Value,
    handoff_invocation: Value,
    handoff_outcomes: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorInteraction {
    alias: String,
    id: String,
    input_arity: u8,
    contract_digest: String,
    program_digest: String,
}

#[derive(Deserialize)]
struct VectorProjection {
    modes: Vec<InteractionMode>,
    #[serde(rename = "projectionDigest")]
    projection_digest: String,
    #[serde(rename = "renamedAlias")]
    renamed_alias: String,
    #[serde(rename = "renamedProjectionDigest")]
    renamed_projection_digest: String,
    #[serde(rename = "durableClaims")]
    durable_claims: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorCompatibleActual {
    contract_digest: String,
    program_digest: String,
    expected_to_actual: String,
    actual_to_expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorInstallation {
    installation_id: String,
    realization_ids: VectorRealizationIds,
}

#[derive(Deserialize)]
struct VectorRealizationIds {
    direct: String,
    request: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorUnrealized {
    available_modes: Vec<InteractionMode>,
    missing_mode: InteractionMode,
    reason: UnrealizedReason,
    status: String,
    exposes_binding: bool,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorOutcome {
    name: String,
    mode: InteractionMode,
    behavior: String,
    certainty: InvocationCertainty,
    result_kind: InvocationResultKind,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorNativeDispatchOutcome {
    name: String,
    certainty: InvocationCertainty,
    result_kind: InvocationResultKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorCertaintyClaim {
    certainty: InvocationCertainty,
    meaning: String,
    legal_result_kinds: Vec<InvocationResultKind>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CreateTodo {
    title: String,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Todo {
    id: String,
    title: String,
}

struct CreateTodoCodec;

impl WireCodec<CreateTodo> for CreateTodoCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::from_value(json!({
            "type": "object",
            "properties": {"title": {"type": "string", "minLength": 1}},
            "required": ["title"],
            "additionalProperties": false
        }))
        .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(value: &CreateTodo) -> Result<Value, WireError> {
        if value.title.is_empty() {
            return Err(WireError::Encode("title must not be empty".to_owned()));
        }
        serde_json::to_value(value).map_err(|error| WireError::Encode(error.to_string()))
    }

    fn decode(value: Value) -> Result<CreateTodo, WireError> {
        let value: CreateTodo =
            serde_json::from_value(value).map_err(|error| WireError::Decode(error.to_string()))?;
        if value.title.is_empty() {
            return Err(WireError::Decode("title must not be empty".to_owned()));
        }
        Ok(value)
    }
}

#[derive(Debug)]
struct CompatibleCreateTodo {
    title: String,
    priority: Option<u8>,
}

struct CompatibleCreateTodoCodec;

impl WireCodec<CompatibleCreateTodo> for CompatibleCreateTodoCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::from_value(json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "minLength": 1},
                "priority": {"type": "integer", "minimum": 0, "maximum": 255}
            },
            "required": ["title"],
            "additionalProperties": false
        }))
        .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(value: &CompatibleCreateTodo) -> Result<Value, WireError> {
        if value.title.is_empty() {
            return Err(WireError::Encode("title must not be empty".to_owned()));
        }
        let mut encoded = serde_json::Map::new();
        encoded.insert("title".to_owned(), Value::String(value.title.clone()));
        if let Some(priority) = value.priority {
            encoded.insert("priority".to_owned(), Value::from(priority));
        }
        Ok(Value::Object(encoded))
    }

    fn decode(value: Value) -> Result<CompatibleCreateTodo, WireError> {
        let object = value
            .as_object()
            .ok_or_else(|| WireError::Decode("input must be an object".to_owned()))?;
        if object.keys().any(|key| key != "title" && key != "priority") {
            return Err(WireError::Decode(
                "input contains an unknown field".to_owned(),
            ));
        }
        let title = object
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| WireError::Decode("title must be a non-empty string".to_owned()))?;
        let priority = object
            .get("priority")
            .map(|priority| {
                priority
                    .as_u64()
                    .and_then(|priority| u8::try_from(priority).ok())
                    .ok_or_else(|| {
                        WireError::Decode("priority must be an unsigned byte".to_owned())
                    })
            })
            .transpose()?;
        Ok(CompatibleCreateTodo {
            title: title.to_owned(),
            priority,
        })
    }
}

impl Interaction for CompatibleCreateTodo {
    const ID: boundary_core::StaticInteractionId = interaction_id!("todos.create");

    type Output = Todo;
    type Error = NoError;
    type Effect = ChangesState;
    type InputCodec = CompatibleCreateTodoCodec;
    type OutputCodec = TodoCodec;
    type ErrorCodec = NoError;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["todos"], &["todos"])
    }
}

struct CompatibleCreateHandler;

impl Handler<CompatibleCreateTodo> for CompatibleCreateHandler {
    async fn handle(
        &self,
        _context: &(),
        interaction: CompatibleCreateTodo,
    ) -> Result<Todo, NoError> {
        let id = match interaction.priority {
            Some(priority) => format!("todo-{priority}"),
            None => "todo-compatible".to_owned(),
        };
        Ok(Todo {
            id,
            title: interaction.title,
        })
    }
}

#[derive(Debug)]
struct EquivalentCreateTodo {
    title: String,
}

impl WireCodec<EquivalentCreateTodo> for CreateTodoCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        <Self as WireCodec<CreateTodo>>::schema()
    }

    fn encode(value: &EquivalentCreateTodo) -> Result<Value, WireError> {
        <Self as WireCodec<CreateTodo>>::encode(&CreateTodo {
            title: value.title.clone(),
        })
    }

    fn decode(value: Value) -> Result<EquivalentCreateTodo, WireError> {
        <Self as WireCodec<CreateTodo>>::decode(value).map(|interaction| EquivalentCreateTodo {
            title: interaction.title,
        })
    }
}

impl Interaction for EquivalentCreateTodo {
    const ID: boundary_core::StaticInteractionId = interaction_id!("todos.create");

    type Output = Todo;
    type Error = NoError;
    type Effect = ChangesState;
    type InputCodec = CreateTodoCodec;
    type OutputCodec = TodoCodec;
    type ErrorCodec = NoError;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["todos"], &["todos"])
    }
}

struct EquivalentCreateHandler;

impl Handler<EquivalentCreateTodo> for EquivalentCreateHandler {
    async fn handle(
        &self,
        _context: &(),
        interaction: EquivalentCreateTodo,
    ) -> Result<Todo, NoError> {
        Ok(Todo {
            id: "todo-equivalent".to_owned(),
            title: interaction.title,
        })
    }
}

#[derive(Debug)]
struct RequiredPriorityCreateTodo {
    title: String,
    priority: u8,
}

struct RequiredPriorityCreateTodoCodec;

impl WireCodec<RequiredPriorityCreateTodo> for RequiredPriorityCreateTodoCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::from_value(json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "minLength": 1},
                "priority": {"type": "integer", "minimum": 0, "maximum": 255}
            },
            "required": ["title", "priority"],
            "additionalProperties": false
        }))
        .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(value: &RequiredPriorityCreateTodo) -> Result<Value, WireError> {
        Ok(json!({"title": value.title, "priority": value.priority}))
    }

    fn decode(value: Value) -> Result<RequiredPriorityCreateTodo, WireError> {
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| WireError::Decode("title must be a non-empty string".to_owned()))?;
        let priority = value
            .get("priority")
            .and_then(Value::as_u64)
            .and_then(|priority| u8::try_from(priority).ok())
            .ok_or_else(|| WireError::Decode("priority is required".to_owned()))?;
        Ok(RequiredPriorityCreateTodo {
            title: title.to_owned(),
            priority,
        })
    }
}

impl Interaction for RequiredPriorityCreateTodo {
    const ID: boundary_core::StaticInteractionId = interaction_id!("todos.create");

    type Output = Todo;
    type Error = NoError;
    type Effect = ChangesState;
    type InputCodec = RequiredPriorityCreateTodoCodec;
    type OutputCodec = TodoCodec;
    type ErrorCodec = NoError;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["todos"], &["todos"])
    }
}

struct RequiredPriorityCreateHandler;

impl Handler<RequiredPriorityCreateTodo> for RequiredPriorityCreateHandler {
    async fn handle(
        &self,
        _context: &(),
        interaction: RequiredPriorityCreateTodo,
    ) -> Result<Todo, NoError> {
        Ok(Todo {
            id: format!("todo-{}", interaction.priority),
            title: interaction.title,
        })
    }
}

struct TodoCodec;

impl WireCodec<Todo> for TodoCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::from_value(json!({
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "title": {"type": "string"}
            },
            "required": ["id", "title"],
            "additionalProperties": false
        }))
        .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(value: &Todo) -> Result<Value, WireError> {
        serde_json::to_value(value).map_err(|error| WireError::Encode(error.to_string()))
    }

    fn decode(value: Value) -> Result<Todo, WireError> {
        serde_json::from_value(value).map_err(|error| WireError::Decode(error.to_string()))
    }
}

impl Interaction for CreateTodo {
    const ID: boundary_core::StaticInteractionId = interaction_id!("todos.create");

    type Output = Todo;
    type Error = NoError;
    type Effect = ChangesState;
    type InputCodec = CreateTodoCodec;
    type OutputCodec = TodoCodec;
    type ErrorCodec = NoError;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["todos"], &["todos"])
    }
}

struct CreateHandler;

impl Handler<CreateTodo> for CreateHandler {
    async fn handle(&self, _context: &(), interaction: CreateTodo) -> Result<Todo, NoError> {
        Ok(Todo {
            id: "todo-1".to_owned(),
            title: interaction.title,
        })
    }
}

struct CreateRequest;

impl RequestCapability<CreateTodo> for CreateRequest {
    async fn request<'a>(
        &'a self,
        _context: &'a (),
        interaction: CreateTodo,
    ) -> Result<Value, RequestCapabilityFault> {
        Ok(json!({"kind": "todo-create", "title": interaction.title}))
    }
}

struct DenyAll;

impl Admission for DenyAll {
    async fn admit<'a>(&'a self, _request: AdmissionRequest<'a, ()>) -> AdmissionDecision {
        AdmissionDecision::Deny {
            code: "policy.denied".to_owned(),
        }
    }
}

struct FailingDispatcher;

impl NativeDispatcher for FailingDispatcher {
    async fn dispatch<'a>(
        &'a self,
        _request: NativeDispatchRequest<'a, ()>,
    ) -> Result<NativeDispatchOutcome, NativeDispatchFault> {
        Err(NativeDispatchFault::Unknown)
    }
}

fn assert_catalog_pins(
    mut catalog: Value,
    vector: &HostLifecycleVector,
    control_digest: &RequestControlDigest,
    preview_schema: &PortableSchema,
) {
    assert_eq!(
        catalog
            .pointer("/interactions/0/direct/realizationId")
            .and_then(Value::as_str),
        Some(vector.installation.realization_ids.direct.as_str())
    );
    assert_eq!(
        catalog
            .pointer("/interactions/0/request/realizationId")
            .and_then(Value::as_str),
        Some(vector.installation.realization_ids.request.as_str())
    );
    assert_eq!(
        catalog
            .pointer("/interactions/0/request/controlDigest")
            .and_then(Value::as_str),
        Some(control_digest.as_str())
    );
    assert_eq!(
        catalog.pointer("/interactions/0/request/previewSchema"),
        Some(preview_schema.as_value())
    );
    catalog["interactions"][0]["request"]["realizationId"] =
        Value::String(vector.installation.realization_ids.direct.clone());
    assert!(serde_json::from_value::<InstallationCatalog>(catalog).is_err());
}

fn assert_direct_catalog(installation_value: &Value, vector: &HostLifecycleVector) {
    assert!(installation_value.get("installationDigest").is_some());
    assert!(installation_value.get("catalog").is_some());
    assert!(installation_value.get("interactions").is_none());
    assert_eq!(
        installation_value
            .pointer("/catalog/interactions/0/interactionId")
            .and_then(Value::as_str),
        Some(vector.interaction.id.as_str())
    );
    assert_eq!(
        installation_value
            .pointer("/catalog/interactions/0/direct/realizationId")
            .and_then(Value::as_str),
        Some(vector.installation.realization_ids.direct.as_str())
    );
    assert!(
        installation_value
            .pointer("/catalog/interactions/0/request")
            .is_none()
    );
}

#[test]
fn vector_drives_projection_identity_and_atomic_unrealized_report() -> Result<(), Box<dyn Error>> {
    let vector: HostLifecycleVector = serde_json::from_str(VECTOR)?;
    assert_eq!(vector.version, 1);
    assert_vector_metadata(&vector);
    let interaction = compile_interaction::<CreateTodo>()?;
    assert_eq!(interaction.interaction_id().as_str(), vector.interaction.id);
    assert_eq!(
        interaction.input_arity() as u8,
        vector.interaction.input_arity
    );
    assert_eq!(
        interaction.contract_digest().as_str(),
        vector.interaction.contract_digest
    );
    let projection = project([select(
        &vector.interaction.alias,
        &interaction,
        modes(&vector.projection.modes)?,
    )?])?;
    assert_eq!(
        projection.manifest().program().digest().as_str(),
        vector.interaction.program_digest
    );
    assert_eq!(
        projection.manifest().projection_digest().as_str(),
        vector.projection.projection_digest
    );
    let projection_value = serde_json::to_value(projection.manifest())?;
    assert_eq!(
        projection_value
            .get("interactions")
            .and_then(Value::as_array)
            .and_then(|interactions| interactions.first())
            .and_then(|interaction| interaction.get("modes")),
        Some(&json!(["direct", "request"]))
    );
    assert_eq!(
        projection_value
            .get("interactions")
            .and_then(Value::as_array)
            .and_then(|interactions| interactions.first())
            .and_then(|interaction| interaction.get("expectedContractDigest")),
        Some(&Value::String(vector.interaction.contract_digest.clone()))
    );

    let installation = install(
        InstallationId::new(&vector.installation.installation_id)?,
        [direct_realization(
            &interaction,
            RealizationId::new(&vector.installation.realization_ids.direct)?,
            CreateHandler,
        )],
    )?;
    let installation_value = serde_json::to_value(installation.installation.manifest())?;
    assert_direct_catalog(&installation_value, &vector);

    match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Unrealized(report) => {
            assert_eq!(vector.atomic_unrealized.status, "unrealized");
            assert!(!vector.atomic_unrealized.exposes_binding);
            assert_eq!(report.issues().len(), 1);
            let issue = report
                .issues()
                .first()
                .ok_or_else(|| io::Error::other("missing unrealized issue"))?;
            assert_eq!(issue.alias(), vector.interaction.alias);
            assert_eq!(issue.mode(), Some(vector.atomic_unrealized.missing_mode));
            assert_eq!(issue.reason(), vector.atomic_unrealized.reason);
            let report_value = serde_json::to_value(&report)?;
            assert_eq!(
                report_value
                    .get("issues")
                    .and_then(Value::as_array)
                    .and_then(|issues| issues.first())
                    .and_then(|issue| issue.get("reason")),
                Some(&Value::String("missing-request".to_owned()))
            );
            let decoded: UnrealizedReport = serde_json::from_value(report_value.clone())?;
            assert_eq!(decoded.issues(), report.issues());
            let mut unknown = report_value;
            insert_field(&mut unknown, "unexpected", Value::Bool(true))?;
            assert!(serde_json::from_value::<UnrealizedReport>(unknown).is_err());
        }
        BindResult::Bound(_) => return Err("partial Installation exposed a Binding".into()),
    }
    Ok(())
}

#[test]
fn binding_manifest_pins_v1_installation_and_realizations() -> Result<(), Box<dyn Error>> {
    let vector: HostLifecycleVector = serde_json::from_str(VECTOR)?;
    let interaction = compile_interaction::<CreateTodo>()?;
    let projection = project([select(
        &vector.interaction.alias,
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    let control_digest = RequestControlDigest::parse(concat!(
        "sha256:",
        "2222222222222222222222222222222222222222222222222222222222222222"
    ))?;
    let preview_schema = PortableSchema::from_value(json!({
        "type": "object",
        "properties": {
            "kind": {"const": "todo-create"},
            "title": {"type": "string"}
        },
        "required": ["kind", "title"],
        "additionalProperties": false
    }))?;
    let installation = install(
        InstallationId::new(&vector.installation.installation_id)?,
        [
            direct_realization(
                &interaction,
                RealizationId::new(&vector.installation.realization_ids.direct)?,
                CreateHandler,
            ),
            identified_request_realization(
                &interaction,
                RealizationId::new(&vector.installation.realization_ids.request)?,
                RequestIdentity::new(control_digest.clone(), preview_schema.clone()),
                CreateRequest,
            ),
        ],
    )?;
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(report) => {
            return Err(format!("unexpected unrealized report: {:?}", report.issues()).into());
        }
    };
    let manifest = binding.binding.manifest();
    assert_eq!(
        manifest.installation_id().as_str(),
        vector.installation.installation_id
    );
    assert_eq!(
        manifest.installation_digest(),
        installation.installation.manifest().installation_digest()
    );
    assert_eq!(manifest.interactions().len(), 2);
    assert_eq!(
        manifest.interactions()[0].realization_id().as_str(),
        vector.installation.realization_ids.direct
    );
    assert_eq!(
        manifest.interactions()[1].realization_id().as_str(),
        vector.installation.realization_ids.request
    );
    let request = manifest.interactions()[1]
        .request_identity()
        .ok_or_else(|| io::Error::other("request pin lacks control identity"))?;
    assert_eq!(request.control_digest(), &control_digest);
    assert_eq!(request.preview_schema(), &preview_schema);
    assert_catalog_pins(
        serde_json::to_value(installation.installation.manifest().catalog())?,
        &vector,
        &control_digest,
        &preview_schema,
    );

    assert_artifact_vectors(&vector.artifacts, &installation, manifest, &interaction)?;

    let output = block_on(
        binding.binding.caller().call(
            &(),
            &projection
                .handles()
                .get(&vector.interaction.alias, &interaction)?,
            CreateTodo {
                title: "Native parity".to_owned(),
            },
        ),
    )?;
    assert_eq!(output.id, "todo-1");

    assert_binding_manifest_wire(manifest)?;
    Ok(())
}

fn assert_artifact_vectors(
    artifacts: &VectorArtifacts,
    installation: &boundary_core::lifecycle::Installed,
    manifest: &BindingManifest,
    interaction: &CompiledInteraction<CreateTodo>,
) -> Result<(), Box<dyn Error>> {
    assert_eq!(
        serde_json::to_value(installation.installation.manifest())?,
        artifacts.installation
    );
    assert_eq!(serde_json::to_value(manifest)?, artifacts.binding);
    let invocation = HandoffInvocation::new(
        manifest,
        interaction.interaction_id(),
        InteractionMode::Direct,
        json!({"title": "Native parity"}),
    )?;
    assert_eq!(
        serde_json::to_value(&invocation)?,
        artifacts.handoff_invocation
    );
    assert_eq!(artifacts.handoff_outcomes.len(), 4);
    let mut certainties = Vec::new();
    for outcome in &artifacts.handoff_outcomes {
        let decoded: HandoffOutcome = serde_json::from_value(outcome.clone())?;
        certainties.push(decoded.certainty());
        assert_eq!(serde_json::to_value(decoded)?, *outcome);
    }
    assert!(certainties.contains(&InvocationCertainty::NotStarted));
    assert!(certainties.contains(&InvocationCertainty::NotCompleted));
    assert!(certainties.contains(&InvocationCertainty::Completed));
    assert!(certainties.contains(&InvocationCertainty::Unknown));
    Ok(())
}

#[test]
fn compatible_nonidentical_installation_pins_actual_program_and_bridges_codecs()
-> Result<(), Box<dyn Error>> {
    let vector: HostLifecycleVector = serde_json::from_str(VECTOR)?;
    let expected = compile_interaction::<CreateTodo>()?;
    let actual = compile_interaction::<CompatibleCreateTodo>()?;
    assert_eq!(
        contract_compatibility(
            expected.descriptor().contract(),
            actual.descriptor().contract(),
        ),
        Compatibility::Compatible
    );
    assert!(
        !contract_compatibility(
            actual.descriptor().contract(),
            expected.descriptor().contract(),
        )
        .is_compatible()
    );
    assert_eq!(vector.compatible_actual.expected_to_actual, "compatible");
    assert_eq!(vector.compatible_actual.actual_to_expected, "incompatible");
    assert_eq!(
        actual.contract_digest().as_str(),
        vector.compatible_actual.contract_digest
    );

    let projection = project([select(
        &vector.interaction.alias,
        &expected,
        ProjectionModes::Direct,
    )?])?;
    let installation = install(
        InstallationId::new("installation:todos:compatible-v1")?,
        [direct_realization(
            &actual,
            RealizationId::new("realization:todos.create:compatible-direct:v1")?,
            CompatibleCreateHandler,
        )],
    )?;
    let installation_manifest = installation.installation.manifest();
    assert_eq!(
        installation_manifest.program().digest().as_str(),
        vector.compatible_actual.program_digest
    );
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(report) => {
            return Err(format!(
                "compatible Installation did not bind: {:?}",
                report.issues()
            )
            .into());
        }
    };
    let manifest = binding.binding.manifest();
    assert_eq!(
        manifest.expected_program_digest(),
        projection.manifest().program().digest()
    );
    assert_eq!(
        manifest.actual_program_digest(),
        installation_manifest.program().digest()
    );
    assert_ne!(
        manifest.expected_program_digest(),
        manifest.actual_program_digest()
    );
    let pinned = manifest
        .interactions()
        .first()
        .ok_or_else(|| io::Error::other("compatible Binding has no interaction pin"))?;
    assert_eq!(
        pinned.expected_contract_digest(),
        expected.contract_digest()
    );
    assert_eq!(pinned.actual_contract_digest(), actual.contract_digest());
    assert_ne!(
        pinned.expected_contract_digest(),
        pinned.actual_contract_digest()
    );

    let output = block_on(
        binding.binding.caller().call(
            &(),
            &projection
                .handles()
                .get(&vector.interaction.alias, &expected)?,
            CreateTodo {
                title: "Compatible bridge".to_owned(),
            },
        ),
    )?;
    assert_eq!(output.id, "todo-compatible");
    assert_eq!(output.title, "Compatible bridge");

    let encoded = serde_json::to_value(manifest)?;
    let decoded: BindingManifest = serde_json::from_value(encoded)?;
    assert_eq!(
        decoded.actual_program_digest(),
        installation_manifest.program().digest()
    );

    assert_equivalent_and_incompatible_bindings(&vector, &projection, &expected)?;
    Ok(())
}

fn assert_equivalent_and_incompatible_bindings(
    vector: &HostLifecycleVector,
    projection: &Projection,
    expected: &CompiledInteraction<CreateTodo>,
) -> Result<(), Box<dyn Error>> {
    let equivalent = compile_interaction::<EquivalentCreateTodo>()?;
    assert_eq!(equivalent.contract_digest(), expected.contract_digest());
    let equivalent_installation = install(
        InstallationId::new("installation:todos:equivalent-v1")?,
        [direct_realization(
            &equivalent,
            RealizationId::new("realization:todos.create:equivalent-direct:v1")?,
            EquivalentCreateHandler,
        )],
    )?;
    let equivalent_binding = match bind(
        projection,
        &equivalent_installation.installation,
        admit_all(),
    ) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(report) => {
            return Err(format!(
                "equivalent Installation did not bind: {:?}",
                report.issues()
            )
            .into());
        }
    };
    let equivalent_output = block_on(
        equivalent_binding.binding.caller().call(
            &(),
            &projection
                .handles()
                .get(&vector.interaction.alias, expected)?,
            CreateTodo {
                title: "Equivalent bridge".to_owned(),
            },
        ),
    )?;
    assert_eq!(equivalent_output.id, "todo-equivalent");

    let incompatible = compile_interaction::<RequiredPriorityCreateTodo>()?;
    let incompatible_installation = install(
        InstallationId::new("installation:todos:incompatible-v1")?,
        [direct_realization(
            &incompatible,
            RealizationId::new("realization:todos.create:incompatible-direct:v1")?,
            RequiredPriorityCreateHandler,
        )],
    )?;
    match bind(
        projection,
        &incompatible_installation.installation,
        admit_all(),
    ) {
        BindResult::Unrealized(report) => assert!(
            report
                .issues()
                .iter()
                .any(|issue| issue.reason() == UnrealizedReason::IncompatibleContract)
        ),
        BindResult::Bound(_) => return Err("incompatible Installation exposed a Binding".into()),
    }
    Ok(())
}

#[test]
fn shared_outcomes_are_serialized_from_live_execution() -> Result<(), Box<dyn Error>> {
    let vector: HostLifecycleVector = serde_json::from_str(VECTOR)?;
    let interaction = compile_interaction::<CreateTodo>()?;
    let projection = project([select(
        &vector.interaction.alias,
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    let request_identity = RequestIdentity::new(
        RequestControlDigest::parse(concat!(
            "sha256:",
            "2222222222222222222222222222222222222222222222222222222222222222"
        ))?,
        PortableSchema::from_value(json!({
            "type": "object",
            "properties": {
                "kind": {"const": "todo-create"},
                "title": {"type": "string"}
            },
            "required": ["kind", "title"],
            "additionalProperties": false
        }))?,
    );
    let installed = install(
        InstallationId::new("installation:outcomes:live-v1")?,
        [
            direct_realization(
                &interaction,
                RealizationId::new("realization:outcomes:direct:v1")?,
                CreateHandler,
            ),
            identified_request_realization(
                &interaction,
                RealizationId::new("realization:outcomes:request:v1")?,
                request_identity.clone(),
                CreateRequest,
            ),
        ],
    )?;
    let admitted = expect_binding(bind(&projection, &installed.installation, admit_all()))?;
    let denied = expect_binding(bind(&projection, &installed.installation, DenyAll))?;
    let failed = install(
        InstallationId::new("installation:outcomes:failure-v1")?,
        [
            dispatch_realization(
                &interaction,
                RealizationId::new("realization:outcomes:failure:v1")?,
                Arc::new(FailingDispatcher),
            ),
            identified_request_realization(
                &interaction,
                RealizationId::new("realization:outcomes:failure-request:v1")?,
                request_identity,
                CreateRequest,
            ),
        ],
    )?;
    let failed = expect_binding(bind(&projection, &failed.installation, admit_all()))?;

    let actual = vec![
        execute_outcome(
            "direct-returned",
            "return",
            &admitted.binding,
            &interaction,
            InteractionMode::Direct,
        )?,
        execute_outcome(
            "request-proposed",
            "return",
            &admitted.binding,
            &interaction,
            InteractionMode::Request,
        )?,
        execute_outcome(
            "admission-denied",
            "deny",
            &denied.binding,
            &interaction,
            InteractionMode::Direct,
        )?,
        execute_outcome(
            "direct-unexpected-failure",
            "throw",
            &failed.binding,
            &interaction,
            InteractionMode::Direct,
        )?,
    ];
    assert_eq!(
        serde_json::to_value(actual)?,
        serde_json::to_value(vector.outcomes)?
    );
    Ok(())
}

fn expect_binding<A: Admission>(
    result: BindResult<(), A>,
) -> Result<Box<boundary_core::lifecycle::Bound<(), A>>, Box<dyn Error>> {
    match result {
        BindResult::Bound(binding) => Ok(binding),
        BindResult::Unrealized(report) => {
            Err(format!("live outcome fixture did not bind: {:?}", report.issues()).into())
        }
    }
}

fn execute_outcome<A: Admission>(
    name: &str,
    behavior: &str,
    binding: &Binding<(), A>,
    interaction: &CompiledInteraction<CreateTodo>,
    mode: InteractionMode,
) -> Result<VectorOutcome, Box<dyn Error>> {
    let invocation = HandoffInvocation::new(
        binding.manifest(),
        interaction.interaction_id(),
        mode,
        json!({"title": "Live outcome"}),
    )?;
    let outcome = block_on(checked_handoff(binding).invoke(invocation, &()))?;
    let result_kind = match outcome.result() {
        HandoffResult::Returned { .. } => InvocationResultKind::Returned,
        HandoffResult::DeclaredError { .. } => InvocationResultKind::DeclaredError,
        HandoffResult::Proposed { .. } => InvocationResultKind::Proposed,
        HandoffResult::Denied { .. } => InvocationResultKind::Denied,
        HandoffResult::Fault { .. } => InvocationResultKind::Fault,
        _ => return Err("unsupported Handoff result in shared outcome vector".into()),
    };
    Ok(VectorOutcome {
        name: name.to_owned(),
        mode,
        behavior: behavior.to_owned(),
        certainty: outcome.certainty(),
        result_kind,
    })
}

#[test]
fn lifecycle_manifests_fail_closed_and_vector_certainties_are_exact() -> Result<(), Box<dyn Error>>
{
    let vector: HostLifecycleVector = serde_json::from_str(VECTOR)?;
    assert_certainty_vector(&vector)?;

    let interaction = compile_interaction::<CreateTodo>()?;
    let projection = project([select(
        &vector.interaction.alias,
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    let renamed = project([select(
        &vector.projection.renamed_alias,
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    assert_eq!(
        renamed.manifest().projection_digest().as_str(),
        vector.projection.renamed_projection_digest
    );
    assert_ne!(
        projection.manifest().projection_digest(),
        renamed.manifest().projection_digest()
    );
    let duplicate = project([
        select("create", &interaction, ProjectionModes::Direct)?,
        select("createAgain", &interaction, ProjectionModes::Request)?,
    ]);
    assert!(matches!(
        duplicate,
        Err(ProjectError::DuplicateInteraction(id)) if id == *interaction.interaction_id()
    ));
    let mut projection_value = serde_json::to_value(projection.manifest())?;
    let mut stale_alias = projection_value.clone();
    let alias = stale_alias
        .get_mut("interactions")
        .and_then(Value::as_array_mut)
        .and_then(|interactions| interactions.first_mut())
        .and_then(|interaction| interaction.get_mut("alias"))
        .ok_or_else(|| io::Error::other("Projection alias missing"))?;
    *alias = Value::String("createAgain".to_owned());
    assert!(serde_json::from_value::<ProjectionManifest>(stale_alias).is_err());
    let mut unknown_projection = projection_value.clone();
    insert_field(&mut unknown_projection, "unexpected", Value::Bool(true))?;
    assert!(serde_json::from_value::<ProjectionManifest>(unknown_projection).is_err());
    let modes = projection_value
        .get_mut("interactions")
        .and_then(Value::as_array_mut)
        .and_then(|interactions| interactions.first_mut())
        .and_then(|interaction| interaction.get_mut("modes"))
        .ok_or_else(|| io::Error::other("Projection modes missing"))?;
    *modes = json!(["request", "direct"]);
    assert!(serde_json::from_value::<ProjectionManifest>(projection_value).is_err());

    let installation = install(
        InstallationId::new(&vector.installation.installation_id)?,
        [direct_realization(
            &interaction,
            RealizationId::new(&vector.installation.realization_ids.direct)?,
            CreateHandler,
        )],
    )?;
    let mut installation_value = serde_json::to_value(installation.installation.manifest())?;
    let mut unknown_installation = installation_value.clone();
    insert_field(&mut unknown_installation, "unexpected", Value::Bool(true))?;
    assert!(serde_json::from_value::<InstallationManifest>(unknown_installation).is_err());
    set_string(
        &mut installation_value,
        "installationDigest",
        concat!(
            "sha256:",
            "0000000000000000000000000000000000000000000000000000000000000000"
        ),
    )?;
    assert!(serde_json::from_value::<InstallationManifest>(installation_value).is_err());
    let duplicate_catalog = format!(
        concat!(
            r#"{{"version":1,"programDigest":"{}","interactions":[{{"interactionId":"todos.create","direct":{{"realizationId":"realization:one"}}}},{{"interactionId":"todos.create","direct":{{"realizationId":"realization:two"}}}}]}}"#
        ),
        vector.interaction.program_digest
    );
    assert!(serde_json::from_str::<InstallationCatalog>(&duplicate_catalog).is_err());
    Ok(())
}

fn assert_certainty_vector(vector: &HostLifecycleVector) -> Result<(), Box<dyn Error>> {
    assert_eq!(vector.outcomes.len(), 4);
    assert_outcome(
        &vector.outcomes,
        "direct-returned",
        InvocationCertainty::Completed,
        InvocationResultKind::Returned,
    )?;
    assert_outcome(
        &vector.outcomes,
        "request-proposed",
        InvocationCertainty::NotStarted,
        InvocationResultKind::Proposed,
    )?;
    assert_outcome(
        &vector.outcomes,
        "admission-denied",
        InvocationCertainty::NotStarted,
        InvocationResultKind::Denied,
    )?;
    assert_outcome(
        &vector.outcomes,
        "direct-unexpected-failure",
        InvocationCertainty::Unknown,
        InvocationResultKind::Fault,
    )?;
    assert_eq!(vector.certainty_claims.len(), 4);
    let not_completed = vector
        .certainty_claims
        .iter()
        .find(|claim| claim.certainty == InvocationCertainty::NotCompleted)
        .ok_or_else(|| io::Error::other("missing not-completed certainty claim"))?;
    assert_eq!(
        not_completed.meaning,
        "execution began and the dispatcher proved the interaction did not complete"
    );
    assert_eq!(
        not_completed.legal_result_kinds,
        [InvocationResultKind::Fault]
    );
    assert_eq!(
        serde_json::to_value(&vector.native_dispatch_outcomes)?,
        serde_json::json!([
            {"name":"native-returned","certainty":"completed","resultKind":"returned"},
            {"name":"native-declared-error","certainty":"completed","resultKind":"declared-error"},
            {"name":"native-denied","certainty":"not-started","resultKind":"denied"},
            {"name":"native-not-started","certainty":"not-started","resultKind":"fault"},
            {"name":"native-not-completed","certainty":"not-completed","resultKind":"fault"},
            {"name":"native-unknown","certainty":"unknown","resultKind":"fault"}
        ])
    );
    Ok(())
}

fn assert_vector_metadata(vector: &HostLifecycleVector) {
    assert_eq!(
        vector.projection.durable_claims,
        ["alias", "interaction-identity", "input-arity", "modes"]
    );
    assert_eq!(
        vector.atomic_unrealized.available_modes,
        [InteractionMode::Direct]
    );
}

fn modes(modes: &[InteractionMode]) -> Result<ProjectionModes, Box<dyn Error>> {
    match modes {
        [InteractionMode::Direct] => Ok(ProjectionModes::Direct),
        [InteractionMode::Request] => Ok(ProjectionModes::Request),
        [InteractionMode::Direct, InteractionMode::Request] => {
            Ok(ProjectionModes::DirectAndRequest)
        }
        _ => Err("unsupported vector projection modes".into()),
    }
}

fn assert_binding_manifest_wire(manifest: &BindingManifest) -> Result<(), Box<dyn Error>> {
    let encoded = serde_json::to_value(manifest)?;
    assert_eq!(encoded.get("version"), Some(&Value::from(1)));
    let decoded: BindingManifest = serde_json::from_value(encoded.clone())?;
    assert_eq!(decoded.binding_digest(), manifest.binding_digest());

    let mut unsupported_version = encoded.clone();
    insert_field(&mut unsupported_version, "version", Value::from(99))?;
    assert!(serde_json::from_value::<BindingManifest>(unsupported_version).is_err());
    let mut unknown = encoded.clone();
    insert_field(&mut unknown, "unexpected", Value::Bool(true))?;
    assert!(serde_json::from_value::<BindingManifest>(unknown).is_err());
    let mut stale = encoded;
    set_string(
        &mut stale,
        "bindingDigest",
        concat!(
            "sha256:",
            "0000000000000000000000000000000000000000000000000000000000000000"
        ),
    )?;
    assert!(serde_json::from_value::<BindingManifest>(stale).is_err());
    Ok(())
}

fn set_string(value: &mut Value, key: &str, replacement: &str) -> Result<(), Box<dyn Error>> {
    let field = value
        .get_mut(key)
        .ok_or_else(|| io::Error::other(format!("missing {key}")))?;
    *field = Value::String(replacement.to_owned());
    Ok(())
}

fn insert_field(value: &mut Value, key: &str, field: Value) -> Result<(), Box<dyn Error>> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| io::Error::other("expected JSON object"))?;
    object.insert(key.to_owned(), field);
    Ok(())
}

fn assert_outcome(
    outcomes: &[VectorOutcome],
    name: &str,
    certainty: InvocationCertainty,
    result_kind: InvocationResultKind,
) -> Result<(), Box<dyn Error>> {
    let outcome = outcomes
        .iter()
        .find(|outcome| outcome.name == name)
        .ok_or_else(|| io::Error::other(format!("missing outcome {name}")))?;
    assert_eq!(outcome.certainty, certainty);
    assert_eq!(outcome.result_kind, result_kind);
    Ok(())
}

#[test]
fn observed_handoff_preserves_execution_when_publication_fails() -> Result<(), Box<dyn Error>> {
    let interaction = compile_interaction::<CreateTodo>()?;
    let projection = project([select("create", &interaction, ProjectionModes::Direct)?])?;
    let installed = install(
        InstallationId::new("observed:1")?,
        [direct_realization(
            &interaction,
            RealizationId::new("create:release-1")?,
            CreateHandler,
        )],
    )?;
    let bound = expect_binding(bind(&projection, &installed.installation, admit_all()))?;
    let invocation = HandoffInvocation::new(
        bound.binding.manifest(),
        interaction.interaction_id(),
        InteractionMode::Direct,
        json!({"title":"private input"}),
    )?;
    let mut observations = Vec::new();
    let outcome = block_on(checked_handoff(&bound.binding).invoke_observed(
        invocation,
        &(),
        Some(json!({"run":"run-7"})),
        |observation| {
            observations.push(observation);
            std::future::ready(Err::<(), ()>(()))
        },
    ))?;
    assert_eq!(outcome.certainty(), InvocationCertainty::Completed);
    assert_eq!(observations.len(), 1);
    let event = observations[0].as_value();
    assert_eq!(event["resultKind"], "returned");
    assert_eq!(event["changes"], json!(["todos"]));
    assert_eq!(event["correlation"], json!({"run":"run-7"}));
    assert!(!event.to_string().contains("private input"));
    Ok(())
}

#[test]
fn presentation_matches_reviewed_cross_language_digest() -> Result<(), Box<dyn Error>> {
    use boundary_core::lifecycle::{InteractionPresentationOverride, present_projection};
    let vector: Value = serde_json::from_str(include_str!(
        "../../../tests/conformance/v1/composition.json"
    ))?;
    let interaction = compile_interaction::<CreateTodo>()?;
    let projection = project([select(
        "create",
        &interaction,
        ProjectionModes::DirectAndRequest,
    )?])?;
    let prose = std::collections::BTreeMap::from([(
        "create".to_owned(),
        InteractionPresentationOverride {
            title: Some("Create todo".to_owned()),
            description: Some("Propose or create a todo.".to_owned()),
        },
    )]);
    let presentation = present_projection(&projection, &prose)?;
    assert_eq!(
        boundary_core::canonical_json(presentation.as_value())?,
        boundary_core::canonical_json(&vector["presentation"])?
    );
    let request = project([select("create", &interaction, ProjectionModes::Request)?])?;
    assert!(
        present_projection(&request, &prose)?.as_value()["interactions"][0]
            .get("directOutputSchema")
            .is_none()
    );
    Ok(())
}
