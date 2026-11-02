//! The `boundary` command.
//!
//! This binary composes library crates and owns no behavior of its own. That
//! is the point of the layout: everything it can do, an application can do by
//! calling the same libraries, so the command line is one door among several
//! rather than a privileged path.
//!
//! Argument parsing is hand-written. A handful of subcommands do not justify
//! a dependency, and the binary tier is the one place a stray dependency
//! would be least noticed.

mod call;
mod discovery;
mod mcp;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use boundary_bus::{BusClient, BusServer};

const USAGE: &str = "\
boundary — local interaction bus

USAGE:
    boundary bus [--socket PATH]     Run the per-user bus
    boundary list [--socket PATH]    List reachable interactions
    boundary call <interactionId> [--input JSON] [--mode direct|request]
        [--binding DIGEST] [--socket PATH]
                                Invoke one interaction
    boundary mcp [--socket PATH]     Serve reachable interactions to a model
    boundary --help

`boundary list` fetches each advertised manifest and prints its interaction IDs
and modes. An unavailable or changed manifest makes the listing incomplete
and the command exits non-zero. Discovery never grants execution authority.

`--binding` selects one exact Binding digest when an interaction is published
by several Bindings. It never falls back to another Binding.

The bus resolves where a Binding can be reached. It holds no authority and
records nothing about calls: a caller reaches a surface directly over the
transport a record names, and receipts stay with the application that executed
the effect.

`boundary call` prints the outcome envelope as JSON and exits non-zero unless the
result is `returned` or `proposed`. A fault or denial is not a crash; it is
reported and the process exits non-zero, without retrying anything.

`--mode` picks direct or request explicitly. Without it, a binding exposing
both is called in the *more* gated mode: preferring direct would step around
an approval the application deliberately required.

`boundary mcp` speaks the Model Context Protocol on stdio, offering every reachable
interaction as a tool. The Projection an application publishes is the only
narrowing: there is no second list that hides an interaction a Binding still
carries. Each application still admits every call it receives; this process
resolves addresses and carries pins, and sends each call over exactly one
transport.

The socket defaults to $BOUNDARY_BUS_SOCKET, else ~/.boundary/bus.sock. Its directory is
created 0700, so the kernel refuses another user before any bus code runs.
";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match run(&arguments) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("boundary: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: &[String]) -> Result<ExitCode, String> {
    let Some(command) = arguments.first() else {
        print!("{USAGE}");
        return Ok(ExitCode::SUCCESS);
    };

    match command.as_str() {
        "--help" | "-h" | "help" => {
            print!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        "bus" | "list" | "mcp" => {
            let Some(socket) = socket_from(command, &arguments[1..])? else {
                print!("{USAGE}");
                return Ok(ExitCode::SUCCESS);
            };
            match command.as_str() {
                "bus" => bus(&socket),
                "list" => discovery::list(&socket),
                _ => mcp::run(&socket),
            }
            .map(|()| ExitCode::SUCCESS)
        }
        "call" => call::run(&arguments[1..]),
        other => Err(format!(
            "unknown command {other:?}. Run `boundary --help` for usage."
        )),
    }
}

/// Parses the complete command before resolving a socket or performing I/O.
/// `None` requests help; malformed flags never start or contact a bus.
fn socket_from(command: &str, arguments: &[String]) -> Result<Option<PathBuf>, String> {
    let mut socket = None;
    let mut help = false;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--help" | "-h" => {
                help = true;
                index += 1;
            }
            "--socket" => {
                if socket.is_some() {
                    return Err("--socket may only be supplied once".to_owned());
                }
                let value = arguments
                    .get(index + 1)
                    .filter(|value| !value.trim().is_empty() && !value.starts_with('-'))
                    .ok_or_else(|| "--socket needs a path".to_owned())?;
                socket = Some(PathBuf::from(value));
                index += 2;
            }
            other => {
                return Err(format!(
                    "unrecognized argument {other:?} for `boundary {command}`"
                ));
            }
        }
    }
    if help {
        return Ok(None);
    }
    socket.map_or_else(
        || socket_from_env_or_default().map(Some),
        |path| Ok(Some(path)),
    )
}

/// Resolves the socket path from the environment or the per-user default,
/// without scanning for an explicit flag. A caller that already extracted its
/// own `--socket` value calls this directly for the fallback.
pub(crate) fn socket_from_env_or_default() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("BOUNDARY_BUS_SOCKET")
        && !value.trim().is_empty()
    {
        return Ok(PathBuf::from(value));
    }
    default_socket()
}

fn default_socket() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set; pass --socket or set BOUNDARY_BUS_SOCKET".to_owned())?;
    let mut path = PathBuf::from(home);
    path.push(".boundary");
    path.push("bus.sock");
    Ok(path)
}

fn bus(socket: &Path) -> Result<(), String> {
    let server = BusServer::bind(socket).map_err(|error| error.to_string())?;
    eprintln!("boundary bus listening on {}", server.path().display());
    server.serve_forever().map_err(|error| error.to_string())
}

/// Connects to the bus, naming it in the error so a caller knows to start it.
pub(crate) fn connect(socket: &Path) -> Result<BusClient, String> {
    BusClient::connect(socket).map_err(|error| {
        format!(
            "could not reach the bus at {}: {error}. Is `boundary bus` running?",
            socket.display()
        )
    })
}

pub(crate) fn describe(transport: &boundary_reach::Transport) -> String {
    match transport {
        boundary_reach::Transport::Unix { path, base } => format!("unix {path} at {base}"),
        boundary_reach::Transport::Http { url } => format!("http {url}"),
    }
}
