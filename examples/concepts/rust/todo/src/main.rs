// Synchronous fixture handlers retain the async authoring form used by hosts.
// unknown_lints keeps this new Clippy allowance compatible with the Rust 1.88 floor.
#![allow(unknown_lints, clippy::unused_async_trait_impl)]

//! Seven native Todo interactions through one durable Projection and live Binding.

use std::{
    error::Error,
    sync::{Arc, RwLock},
};

use boundary_core::{
    Fault, Handler, Interaction, PortableFault,
    lifecycle::{
        AdmitAll, BindResult, Bound, CompiledInteraction, InstallationId, Installed, Projection,
        ProjectionHandle, ProjectionModes, RealizationId, admit_all, bind, compile_interaction,
        direct_realization, install, project, select,
    },
};
use futures::executor::block_on;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Todo {
    id: String,
    title: String,
    completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct TodoList {
    items: Vec<Todo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Count {
    count: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "lowercase")]
enum Filter {
    #[default]
    All,
    Active,
    Completed,
}

#[derive(Debug, Error, Serialize, Deserialize, JsonSchema, Fault)]
#[serde(deny_unknown_fields, tag = "code", content = "details")]
enum TodoError {
    #[error("todo {id} was not found")]
    #[fault(code = "todo_not_found")]
    #[serde(rename = "todo_not_found")]
    NotFound { id: String },
    #[error("todo state is unavailable")]
    #[fault(code = "todo_unavailable")]
    #[serde(rename = "todo_unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.list", output = TodoList, error = TodoError, reads("todos"))]
/// List todos.
struct ListTodos {
    filter: Filter,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.create", output = Todo, error = TodoError, changes("todos"))]
/// Create one todo.
struct CreateTodo {
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.rename", output = Todo, error = TodoError, changes("todos"))]
/// Rename one todo.
struct RenameTodo {
    id: String,
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.set-completed", output = Todo, error = TodoError, changes("todos"))]
/// Set one todo's completion state.
struct SetCompleted {
    id: String,
    completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.remove", output = Todo, error = TodoError, changes("todos"))]
/// Remove one todo.
struct RemoveTodo {
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(id = "todos.set-all-completed", output = Count, error = TodoError, changes("todos"))]
/// Set all todos' completion state.
struct SetAllCompleted {
    completed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, Interaction)]
#[serde(deny_unknown_fields)]
#[interaction(
    id = "todos.clear-completed",
    output = Count,
    error = TodoError,
    changes("todos"),
    no_input
)]
/// Remove every completed todo.
struct ClearCompleted {}

#[derive(Clone, Default)]
struct TodoService {
    state: Arc<RwLock<State>>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    todos: Vec<Todo>,
}

impl TodoService {
    fn read(&self) -> Result<std::sync::RwLockReadGuard<'_, State>, TodoError> {
        self.state.read().map_err(|_| TodoError::Unavailable)
    }

    fn write(&self) -> Result<std::sync::RwLockWriteGuard<'_, State>, TodoError> {
        self.state.write().map_err(|_| TodoError::Unavailable)
    }
}

impl Handler<ListTodos> for TodoService {
    async fn handle(&self, _context: &(), interaction: ListTodos) -> Result<TodoList, TodoError> {
        let items = self
            .read()?
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
    }
}

impl Handler<CreateTodo> for TodoService {
    async fn handle(&self, _context: &(), interaction: CreateTodo) -> Result<Todo, TodoError> {
        let mut state = self.write()?;
        state.next_id += 1;
        let todo = Todo {
            id: format!("todo-{}", state.next_id),
            title: interaction.title,
            completed: false,
        };
        state.todos.push(todo.clone());
        Ok(todo)
    }
}

impl Handler<RenameTodo> for TodoService {
    async fn handle(&self, _context: &(), interaction: RenameTodo) -> Result<Todo, TodoError> {
        let mut state = self.write()?;
        let todo = state
            .todos
            .iter_mut()
            .find(|todo| todo.id == interaction.id)
            .ok_or(TodoError::NotFound { id: interaction.id })?;
        todo.title = interaction.title;
        Ok(todo.clone())
    }
}

impl Handler<SetCompleted> for TodoService {
    async fn handle(&self, _context: &(), interaction: SetCompleted) -> Result<Todo, TodoError> {
        let mut state = self.write()?;
        let todo = state
            .todos
            .iter_mut()
            .find(|todo| todo.id == interaction.id)
            .ok_or(TodoError::NotFound { id: interaction.id })?;
        todo.completed = interaction.completed;
        Ok(todo.clone())
    }
}

impl Handler<RemoveTodo> for TodoService {
    async fn handle(&self, _context: &(), interaction: RemoveTodo) -> Result<Todo, TodoError> {
        let mut state = self.write()?;
        let index = state
            .todos
            .iter()
            .position(|todo| todo.id == interaction.id)
            .ok_or(TodoError::NotFound { id: interaction.id })?;
        Ok(state.todos.remove(index))
    }
}

impl Handler<SetAllCompleted> for TodoService {
    async fn handle(
        &self,
        _context: &(),
        interaction: SetAllCompleted,
    ) -> Result<Count, TodoError> {
        let mut state = self.write()?;
        let mut count = 0;
        for todo in &mut state.todos {
            if todo.completed != interaction.completed {
                todo.completed = interaction.completed;
                count += 1;
            }
        }
        Ok(Count {
            count: count.to_string(),
        })
    }
}

impl Handler<ClearCompleted> for TodoService {
    async fn handle(
        &self,
        _context: &(),
        _interaction: ClearCompleted,
    ) -> Result<Count, TodoError> {
        let mut state = self.write()?;
        let before = state.todos.len();
        state.todos.retain(|todo| !todo.completed);
        Ok(Count {
            count: (before - state.todos.len()).to_string(),
        })
    }
}

struct TodoDefinitions {
    list: CompiledInteraction<ListTodos>,
    create: CompiledInteraction<CreateTodo>,
    rename: CompiledInteraction<RenameTodo>,
    set_completed: CompiledInteraction<SetCompleted>,
    remove: CompiledInteraction<RemoveTodo>,
    set_all_completed: CompiledInteraction<SetAllCompleted>,
    clear_completed: CompiledInteraction<ClearCompleted>,
}

impl TodoDefinitions {
    fn compile() -> Result<Self, Box<dyn Error>> {
        Ok(Self {
            list: compile_interaction::<ListTodos>()?,
            create: compile_interaction::<CreateTodo>()?,
            rename: compile_interaction::<RenameTodo>()?,
            set_completed: compile_interaction::<SetCompleted>()?,
            remove: compile_interaction::<RemoveTodo>()?,
            set_all_completed: compile_interaction::<SetAllCompleted>()?,
            clear_completed: compile_interaction::<ClearCompleted>()?,
        })
    }
}

struct TodoHandles {
    list: ProjectionHandle<ListTodos>,
    create: ProjectionHandle<CreateTodo>,
    rename: ProjectionHandle<RenameTodo>,
    set_completed: ProjectionHandle<SetCompleted>,
    remove: ProjectionHandle<RemoveTodo>,
    set_all_completed: ProjectionHandle<SetAllCompleted>,
    clear_completed: ProjectionHandle<ClearCompleted>,
}

fn desired_surface(
    definitions: &TodoDefinitions,
) -> Result<(Projection, TodoHandles), Box<dyn Error>> {
    let projection = project([
        select("list", &definitions.list, ProjectionModes::Direct)?,
        select("create", &definitions.create, ProjectionModes::Direct)?,
        select("rename", &definitions.rename, ProjectionModes::Direct)?,
        select(
            "setCompleted",
            &definitions.set_completed,
            ProjectionModes::Direct,
        )?,
        select("remove", &definitions.remove, ProjectionModes::Direct)?,
        select(
            "setAllCompleted",
            &definitions.set_all_completed,
            ProjectionModes::Direct,
        )?,
        select(
            "clearCompleted",
            &definitions.clear_completed,
            ProjectionModes::Direct,
        )?,
    ])?;
    let handles = projection.handles();
    let handles = TodoHandles {
        list: handles.get("list", &definitions.list)?,
        create: handles.get("create", &definitions.create)?,
        rename: handles.get("rename", &definitions.rename)?,
        set_completed: handles.get("setCompleted", &definitions.set_completed)?,
        remove: handles.get("remove", &definitions.remove)?,
        set_all_completed: handles.get("setAllCompleted", &definitions.set_all_completed)?,
        clear_completed: handles.get("clearCompleted", &definitions.clear_completed)?,
    };
    Ok((projection, handles))
}

fn live_installation(definitions: &TodoDefinitions) -> Result<Installed, Box<dyn Error>> {
    let service = TodoService::default();
    Ok(install(
        InstallationId::new("todo/local/v1")?,
        [
            direct_realization(
                &definitions.list,
                RealizationId::new("todo/list/v1")?,
                service.clone(),
            ),
            direct_realization(
                &definitions.create,
                RealizationId::new("todo/create/v1")?,
                service.clone(),
            ),
            direct_realization(
                &definitions.rename,
                RealizationId::new("todo/rename/v1")?,
                service.clone(),
            ),
            direct_realization(
                &definitions.set_completed,
                RealizationId::new("todo/set-completed/v1")?,
                service.clone(),
            ),
            direct_realization(
                &definitions.remove,
                RealizationId::new("todo/remove/v1")?,
                service.clone(),
            ),
            direct_realization(
                &definitions.set_all_completed,
                RealizationId::new("todo/set-all-completed/v1")?,
                service.clone(),
            ),
            direct_realization(
                &definitions.clear_completed,
                RealizationId::new("todo/clear-completed/v1")?,
                service,
            ),
        ],
    )?)
}

struct TodoRuntime {
    binding: Box<Bound<(), AdmitAll>>,
    handles: TodoHandles,
}

fn build_runtime() -> Result<TodoRuntime, Box<dyn Error>> {
    let definitions = TodoDefinitions::compile()?;

    // Desired caller surface is durable and valid before this process has any
    // realization for it. A host may install and bind it now or later.
    let (projection, handles) = desired_surface(&definitions)?;
    let installation = live_installation(&definitions)?;
    let binding = match bind(&projection, &installation.installation, admit_all()) {
        BindResult::Bound(binding) => binding,
        BindResult::Unrealized(report) => {
            return Err(format!("Todo Projection is unrealized: {:?}", report.issues()).into());
        }
    };
    Ok(TodoRuntime { binding, handles })
}

async fn run() -> Result<(), Box<dyn Error>> {
    let runtime = build_runtime()?;
    let caller = runtime.binding.binding.caller();

    let created = caller
        .call(
            &(),
            &runtime.handles.create,
            CreateTodo {
                title: "Draft interaction".to_owned(),
            },
        )
        .await?;
    let renamed = caller
        .call(
            &(),
            &runtime.handles.rename,
            RenameTodo {
                id: created.id,
                title: "Rust-shaped interaction".to_owned(),
            },
        )
        .await?;
    let _second = caller
        .call(
            &(),
            &runtime.handles.create,
            CreateTodo {
                title: "Controlled interaction".to_owned(),
            },
        )
        .await?;
    let changed_all = caller
        .call(
            &(),
            &runtime.handles.set_all_completed,
            SetAllCompleted { completed: true },
        )
        .await?;
    let listed = caller
        .call(
            &(),
            &runtime.handles.list,
            ListTodos {
                filter: Filter::Completed,
            },
        )
        .await?;
    let reactivated = caller
        .call(
            &(),
            &runtime.handles.set_completed,
            SetCompleted {
                id: renamed.id,
                completed: false,
            },
        )
        .await?;
    let removed = caller
        .call(
            &(),
            &runtime.handles.remove,
            RemoveTodo { id: reactivated.id },
        )
        .await?;
    let cleared = caller
        .call(&(), &runtime.handles.clear_completed, ClearCompleted {})
        .await?;

    println!(
        "{} [{}] changed_all={} listed={} cleared={}",
        removed.title,
        TodoError::NotFound {
            id: "missing".to_owned(),
        }
        .code(),
        changed_all.count,
        listed.items.len(),
        cleared.count
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    block_on(run())
}
