// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

use std::sync::RwLock;

use boundary_core::{
    ChangeFootprint, ChangesState, Handler, InputArity, Interaction, InteractionDocs, JsonCodec,
    PortableSchema, WireCodec, WireError,
};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

pub(crate) const INTERACTION_IDS: [&str; 7] = [
    "todos.clearCompleted",
    "todos.create",
    "todos.list",
    "todos.remove",
    "todos.rename",
    "todos.setAllCompleted",
    "todos.setCompleted",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Todo {
    completed: bool,
    id: String,
    title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct TodoList {
    items: Vec<Todo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Count {
    count: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "lowercase")]
pub(crate) enum Filter {
    #[default]
    All,
    Active,
    Completed,
}

/// One `{ code, details }` error envelope, shared with the TypeScript declaration.
#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    thiserror::Error,
    Serialize,
    Deserialize,
    JsonSchema,
    boundary_core::Fault,
)]
#[serde(deny_unknown_fields, tag = "code", content = "details")]
pub(crate) enum TodoFault {
    #[error("todo_not_found: {id}")]
    #[fault(code = "todo_not_found")]
    #[serde(rename = "todo_not_found")]
    NotFound { id: String },
    #[error("todo_unavailable: {id}")]
    #[fault(code = "todo_unavailable")]
    #[serde(rename = "todo_unavailable")]
    Unavailable { id: String },
}

impl TodoFault {
    fn not_found(id: String) -> Self {
        Self::NotFound { id }
    }

    fn unavailable() -> Self {
        Self::Unavailable { id: String::new() }
    }
}

fn deserialize_non_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Err(serde::de::Error::custom("title must not be empty"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, boundary_core::Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(
    id = "todos.list",
    output = TodoList,
    error = TodoFault,
    reads("todos")
)]
/// List todos through the shared state boundary.
pub(crate) struct ListTodos {
    filter: Filter,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, boundary_core::Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(
    id = "todos.create",
    output = Todo,
    error = TodoFault,
    reads("todos"),
    changes("todos")
)]
/// Create one todo.
pub(crate) struct CreateTodo {
    #[schemars(length(min = 1))]
    #[serde(deserialize_with = "deserialize_non_empty")]
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, boundary_core::Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(
    id = "todos.rename",
    output = Todo,
    error = TodoFault,
    reads("todos"),
    changes("todos")
)]
/// Rename one todo.
pub(crate) struct RenameTodo {
    id: String,
    #[schemars(length(min = 1))]
    #[serde(deserialize_with = "deserialize_non_empty")]
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, boundary_core::Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(
    id = "todos.setCompleted",
    output = Todo,
    error = TodoFault,
    reads("todos"),
    changes("todos")
)]
/// Set one todo's completion state.
pub(crate) struct SetCompleted {
    completed: bool,
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, boundary_core::Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(
    id = "todos.remove",
    output = Todo,
    error = TodoFault,
    reads("todos"),
    changes("todos")
)]
/// Remove one todo.
pub(crate) struct RemoveTodo {
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, boundary_core::Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(
    id = "todos.setAllCompleted",
    output = Count,
    error = TodoFault,
    reads("todos"),
    changes("todos")
)]
/// Set every todo's completion state.
pub(crate) struct SetAllCompleted {
    completed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Remove every completed todo.
pub(crate) struct ClearCompleted {}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ClearCompletedCodec;

impl WireCodec<ClearCompleted> for ClearCompletedCodec {
    fn schema() -> Result<PortableSchema, WireError> {
        PortableSchema::from_value(json!({ "type": "null" }))
            .map_err(|error| WireError::Schema(error.to_string()))
    }

    fn encode(_value: &ClearCompleted) -> Result<Value, WireError> {
        Ok(Value::Null)
    }

    fn decode(value: Value) -> Result<ClearCompleted, WireError> {
        match value {
            Value::Null => Ok(ClearCompleted {}),
            _ => Err(WireError::Decode("zero-input Handoff uses null".to_owned())),
        }
    }
}

impl Interaction for ClearCompleted {
    const ID: boundary_core::StaticInteractionId =
        boundary_core::interaction_id!("todos.clearCompleted");
    const INPUT_ARITY: InputArity = InputArity::Zero;

    type Output = Count;
    type Error = TodoFault;
    type Effect = ChangesState;
    type InputCodec = ClearCompletedCodec;
    type OutputCodec = JsonCodec<Count>;
    type ErrorCodec = JsonCodec<TodoFault>;

    fn footprint() -> ChangeFootprint {
        ChangeFootprint::new(&["todos"], &["todos"])
    }

    fn docs() -> InteractionDocs {
        InteractionDocs {
            summary: "Remove every completed todo.",
            description: "",
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct TodoContext {
    state: RwLock<TodoState>,
}

#[derive(Debug, Default)]
struct TodoState {
    calls: std::collections::BTreeMap<String, u64>,
    next_id: u64,
    todos: Vec<Todo>,
}

impl TodoContext {
    pub(crate) fn new() -> Self {
        let calls = INTERACTION_IDS
            .into_iter()
            .map(|id| (id.to_owned(), 0))
            .collect();
        Self {
            state: RwLock::new(TodoState {
                calls,
                next_id: 1,
                todos: Vec::new(),
            }),
        }
    }

    fn with_state<T>(
        &self,
        interaction_id: &'static str,
        update: impl FnOnce(&mut TodoState) -> Result<T, TodoFault>,
    ) -> Result<T, TodoFault> {
        let mut state = self.state.write().map_err(|_| TodoFault::unavailable())?;
        let calls = state
            .calls
            .get_mut(interaction_id)
            .ok_or_else(TodoFault::unavailable)?;
        *calls = calls.checked_add(1).ok_or_else(TodoFault::unavailable)?;
        update(&mut state)
    }

    pub(crate) fn stats(&self) -> Result<(std::collections::BTreeMap<String, u64>, usize), ()> {
        self.state
            .read()
            .map(|state| (state.calls.clone(), state.todos.len()))
            .map_err(|_| ())
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TodoHandler;

impl Handler<ListTodos, TodoContext> for TodoHandler {
    async fn handle(
        &self,
        context: &TodoContext,
        interaction: ListTodos,
    ) -> Result<TodoList, TodoFault> {
        context.with_state(ListTodos::ID.as_str(), |state| {
            let items = state
                .todos
                .iter()
                .filter(|todo| match interaction.filter {
                    Filter::All => true,
                    Filter::Active => !todo.completed,
                    Filter::Completed => todo.completed,
                })
                .cloned()
                .collect();
            Ok(TodoList { items })
        })
    }
}

impl Handler<CreateTodo, TodoContext> for TodoHandler {
    async fn handle(
        &self,
        context: &TodoContext,
        interaction: CreateTodo,
    ) -> Result<Todo, TodoFault> {
        context.with_state(CreateTodo::ID.as_str(), |state| {
            let id = state.next_id;
            state.next_id = id.checked_add(1).ok_or_else(TodoFault::unavailable)?;
            let todo = Todo {
                completed: false,
                id: format!("todo-{id}"),
                title: interaction.title,
            };
            state.todos.push(todo.clone());
            Ok(todo)
        })
    }
}

impl Handler<RenameTodo, TodoContext> for TodoHandler {
    async fn handle(
        &self,
        context: &TodoContext,
        interaction: RenameTodo,
    ) -> Result<Todo, TodoFault> {
        context.with_state(RenameTodo::ID.as_str(), |state| {
            let todo = state
                .todos
                .iter_mut()
                .find(|todo| todo.id == interaction.id)
                .ok_or_else(|| TodoFault::not_found(interaction.id))?;
            todo.title = interaction.title;
            Ok(todo.clone())
        })
    }
}

impl Handler<SetCompleted, TodoContext> for TodoHandler {
    async fn handle(
        &self,
        context: &TodoContext,
        interaction: SetCompleted,
    ) -> Result<Todo, TodoFault> {
        context.with_state(SetCompleted::ID.as_str(), |state| {
            let todo = state
                .todos
                .iter_mut()
                .find(|todo| todo.id == interaction.id)
                .ok_or_else(|| TodoFault::not_found(interaction.id))?;
            todo.completed = interaction.completed;
            Ok(todo.clone())
        })
    }
}

impl Handler<RemoveTodo, TodoContext> for TodoHandler {
    async fn handle(
        &self,
        context: &TodoContext,
        interaction: RemoveTodo,
    ) -> Result<Todo, TodoFault> {
        context.with_state(RemoveTodo::ID.as_str(), |state| {
            let index = state
                .todos
                .iter()
                .position(|todo| todo.id == interaction.id)
                .ok_or_else(|| TodoFault::not_found(interaction.id))?;
            Ok(state.todos.remove(index))
        })
    }
}

impl Handler<SetAllCompleted, TodoContext> for TodoHandler {
    async fn handle(
        &self,
        context: &TodoContext,
        interaction: SetAllCompleted,
    ) -> Result<Count, TodoFault> {
        context.with_state(SetAllCompleted::ID.as_str(), |state| {
            let mut count = 0_u64;
            for todo in &mut state.todos {
                if todo.completed != interaction.completed {
                    todo.completed = interaction.completed;
                    count = count.checked_add(1).ok_or_else(TodoFault::unavailable)?;
                }
            }
            Ok(Count {
                count: count.to_string(),
            })
        })
    }
}

impl Handler<ClearCompleted, TodoContext> for TodoHandler {
    async fn handle(
        &self,
        context: &TodoContext,
        _interaction: ClearCompleted,
    ) -> Result<Count, TodoFault> {
        context.with_state(ClearCompleted::ID.as_str(), |state| {
            let before = state.todos.len();
            state.todos.retain(|todo| !todo.completed);
            Ok(Count {
                count: before.saturating_sub(state.todos.len()).to_string(),
            })
        })
    }
}
