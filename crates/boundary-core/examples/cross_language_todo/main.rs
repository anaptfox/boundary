//! Test-only stdio host for the cross-language Todo acceptance scenario.

mod domain;

use boundary_core::{
    handoff::{HandoffInvocation, checked_handoff},
    lifecycle::{
        AdmitAll, BindResult, Bound, InstallationId, ProjectionModes, RealizationId, admit_all,
        bind, compile_interaction, direct_realization, install, project, select,
    },
};
use domain::{
    ClearCompleted, CreateTodo, ListTodos, RemoveTodo, RenameTodo, SetAllCompleted, SetCompleted,
    TodoContext, TodoHandler,
};
use futures::executor::block_on;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    error::Error,
    io::{self, BufRead, Write},
};

fn binding() -> Result<Box<Bound<TodoContext, AdmitAll>>, Box<dyn Error>> {
    let list = compile_interaction::<ListTodos>()?;
    let create = compile_interaction::<CreateTodo>()?;
    let rename = compile_interaction::<RenameTodo>()?;
    let set_completed = compile_interaction::<SetCompleted>()?;
    let remove = compile_interaction::<RemoveTodo>()?;
    let set_all = compile_interaction::<SetAllCompleted>()?;
    let clear = compile_interaction::<ClearCompleted>()?;
    let projection = project([
        select("list", &list, ProjectionModes::Direct)?,
        select("create", &create, ProjectionModes::Direct)?,
        select("rename", &rename, ProjectionModes::Direct)?,
        select("setCompleted", &set_completed, ProjectionModes::Direct)?,
        select("remove", &remove, ProjectionModes::Direct)?,
        select("setAllCompleted", &set_all, ProjectionModes::Direct)?,
        select("clearCompleted", &clear, ProjectionModes::Direct)?,
    ])?;
    let installed = install(
        InstallationId::new("fixture/todo/v1")?,
        [
            direct_realization(&list, RealizationId::new("todo/list/v1")?, TodoHandler),
            direct_realization(&create, RealizationId::new("todo/create/v1")?, TodoHandler),
            direct_realization(&rename, RealizationId::new("todo/rename/v1")?, TodoHandler),
            direct_realization(
                &set_completed,
                RealizationId::new("todo/setCompleted/v1")?,
                TodoHandler,
            ),
            direct_realization(&remove, RealizationId::new("todo/remove/v1")?, TodoHandler),
            direct_realization(
                &set_all,
                RealizationId::new("todo/setAllCompleted/v1")?,
                TodoHandler,
            ),
            direct_realization(
                &clear,
                RealizationId::new("todo/clearCompleted/v1")?,
                TodoHandler,
            ),
        ],
    )?;
    match bind(&projection, &installed.installation, admit_all()) {
        BindResult::Bound(bound) => Ok(bound),
        BindResult::Unrealized(_) => Err("fixture could not bind".into()),
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Inspect,
    Invoke { invocation: HandoffInvocation },
    Stats,
}

fn main() -> Result<(), Box<dyn Error>> {
    let bound = binding()?;
    let handoff = checked_handoff(&bound.binding);
    let context = TodoContext::new();
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut frame = Vec::new();
        // Read at most one bounded frame; oversized input terminates this host.
        let count = std::io::Read::take(&mut input, 1_048_577).read_until(b'\n', &mut frame)?;
        if count == 0 {
            break;
        }
        if frame.len() > 1_048_576 || frame.last() != Some(&b'\n') {
            return Err("invalid or oversized fixture frame".into());
        }
        let result: Result<Value, Box<dyn Error>> = (|| {
            Ok(match serde_json::from_slice::<Request>(&frame)? {
                Request::Inspect => serde_json::to_value(handoff.manifest())?,
                Request::Invoke { invocation } => {
                    serde_json::to_value(block_on(handoff.invoke(invocation, &context))?)?
                }
                Request::Stats => {
                    let (calls, rows) = context.stats().map_err(|()| "state unavailable")?;
                    json!({"calls": calls, "rows": rows})
                }
            })
        })();
        let response = match result {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(_) => json!({"ok": false, "error": "fixture request rejected"}),
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
