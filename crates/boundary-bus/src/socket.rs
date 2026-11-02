//! Unix domain socket transport for the bus.
//!
//! ## What makes this the user's bus
//!
//! Trust is the OS user, enforced by filesystem permissions rather than by a
//! credential check. The socket lives inside a directory created with mode
//! `0700`, so the kernel refuses another user's `connect` before any bus code
//! runs. This is deliberate over reading peer credentials: `SO_PEERCRED` and
//! its BSD equivalent differ by platform and are not in `std`, while directory
//! permissions are portable, older than all of it, and enforced in one place.
//!
//! Be exact about the claim. This establishes *which OS user* is on the other
//! end. It says nothing about which application, and the bus never pretends
//! otherwise: application identity stays an admission concern for the host that
//! actually executes the interaction.
//!
//! ## Liveness
//!
//! One thread per connection, and a connection owns the records it registered.
//! When the socket closes the registry withdraws them. A process that exited
//! cannot hold a socket open, so stale addresses disappear without a heartbeat
//! protocol.

#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::possession::{PossessionProof, prove_possession_by_manifest};
use crate::protocol::{Request, Response};
use crate::registry::{ConnectionId, Registry};

/// The portable ceiling for a Unix socket path.
///
/// `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux. Exceeding it
/// fails inside libc with a message that does not say what to do about it, so
/// the check happens here where the limit can be named.
const MAX_SOCKET_PATH: usize = 100;
/// Ceiling for one newline-delimited bus request or response. A Reach
/// record is JSON of a digest, a deployment id, and a handful of
/// transports; 64 KiB is far above any well-formed line and far below a
/// size that would exhaust the daemon.
const MAX_LINE: usize = 64 * 1024;
/// Connections served at once. The bus is a shared daemon: one application
/// opening sockets in a loop must not be able to exhaust the thread table and
/// take discovery down for every other application this user runs. Past the
/// cap a connection waits rather than being refused, because a resolver that
/// drops callers under load is worse than one that is briefly slow.
const MAX_CONNECTIONS: usize = 64;

/// Why the bus could not start or serve.
#[derive(Debug, thiserror::Error)]
pub enum BusError {
    /// The socket path is longer than the operating system allows.
    #[error(
        "socket path is {length} bytes, over the {MAX_SOCKET_PATH}-byte limit for a Unix socket: {path}. Choose a shorter path with --socket or BOUNDARY_BUS_SOCKET."
    )]
    PathTooLong {
        /// The path that was too long.
        path: String,
        /// Its length in bytes.
        length: usize,
    },
    /// A filesystem or socket interaction failed.
    #[error("bus io failed at {path}: {source}")]
    Io {
        /// What was being acted on.
        path: String,
        /// The underlying failure.
        source: std::io::Error,
    },
    /// Another `boundary bus` is already listening at this path.
    #[error("a bus is already listening at {path}")]
    AlreadyBound {
        /// The socket that is still live.
        path: String,
    },
    /// The registry lock was poisoned by a panicking thread.
    #[error("bus registry lock was poisoned")]
    Poisoned,
}

/// Binds `path`, removing a leftover socket only when nothing is listening.
fn bind_without_stealing(path: &Path) -> Result<UnixListener, BusError> {
    match UnixListener::bind(path) {
        Ok(listener) => Ok(listener),
        Err(error)
            if error.kind() == std::io::ErrorKind::AddrInUse
                || error.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            if UnixStream::connect(path).is_ok() {
                return Err(BusError::AlreadyBound {
                    path: path.display().to_string(),
                });
            }
            fs::remove_file(path).map_err(|remove| io(path, remove))?;
            UnixListener::bind(path).map_err(|retry| io(path, retry))
        }
        Err(error) => Err(io(path, error)),
    }
}

fn io(path: impl AsRef<Path>, source: std::io::Error) -> BusError {
    BusError::Io {
        path: path.as_ref().display().to_string(),
        source,
    }
}

/// A listening bus.
pub struct BusServer {
    listener: UnixListener,
    path: PathBuf,
    registry: Arc<Mutex<Registry>>,
    next_connection: AtomicU64,
    possession: PossessionProof,
}

impl BusServer {
    /// Binds the bus to a socket path, creating its directory `0700`.
    ///
    /// A leftover socket file from a process that did not shut down cleanly is
    /// removed first. That is safe because the directory is already private to
    /// this user: nobody else could have created it.
    ///
    /// # Errors
    ///
    /// Returns [`BusError::Io`] when the directory or socket cannot be created.
    pub fn bind(path: impl AsRef<Path>) -> Result<Self, BusError> {
        Self::bind_with_possession(path, Arc::new(prove_possession_by_manifest))
    }

    /// Binds with a specific possession proof.
    ///
    /// Exists so a test can register without standing up a real surface, and
    /// so a host with a different way to prove ownership can supply it. There
    /// is deliberately no constructor that skips the proof entirely: a caller
    /// that wants none has to write one that says so.
    ///
    /// # Errors
    ///
    /// See [`BusServer::bind`].
    pub fn bind_with_possession(
        path: impl AsRef<Path>,
        possession: PossessionProof,
    ) -> Result<Self, BusError> {
        let path = path.as_ref().to_path_buf();
        let length = path.as_os_str().len();
        if length > MAX_SOCKET_PATH {
            return Err(BusError::PathTooLong {
                path: path.display().to_string(),
                length,
            });
        }
        if let Some(parent) = path.parent() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .or_else(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        Ok(())
                    } else {
                        Err(io(parent, error))
                    }
                })?;
            // `recursive` skips the mode on an existing directory, so set it
            // explicitly: a directory left world-readable by an earlier
            // version must not stay that way.
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| io(parent, error))?;
        }

        let listener = bind_without_stealing(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| io(&path, error))?;

        Ok(Self {
            listener,
            path,
            registry: Arc::new(Mutex::new(Registry::new())),
            next_connection: AtomicU64::new(1),
            possession,
        })
    }

    /// Returns the socket path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Returns a handle to the shared registry, for inspection in tests.
    #[must_use]
    pub fn registry(&self) -> Arc<Mutex<Registry>> {
        Arc::clone(&self.registry)
    }

    /// Accepts and serves exactly one connection on this thread.
    ///
    /// # Errors
    ///
    /// Returns [`BusError::Io`] when accepting fails.
    pub fn serve_one(&self) -> Result<(), BusError> {
        let (stream, _) = self
            .listener
            .accept()
            .map_err(|error| io(&self.path, error))?;
        let id = ConnectionId(self.next_connection.fetch_add(1, Ordering::SeqCst));
        serve_connection(
            stream,
            &Arc::clone(&self.registry),
            &Arc::clone(&self.possession),
            id,
        );
        Ok(())
    }

    /// Accepts connections forever, one thread per connection.
    ///
    /// # Errors
    ///
    /// Returns [`BusError::Io`] when the listener itself fails. A single
    /// connection failing never stops the bus.
    pub fn serve_forever(&self) -> Result<(), BusError> {
        let live = Arc::new((Mutex::new(0usize), Condvar::new()));
        for stream in self.listener.incoming() {
            let stream = stream.map_err(|error| io(&self.path, error))?;
            let id = ConnectionId(self.next_connection.fetch_add(1, Ordering::SeqCst));
            let registry = Arc::clone(&self.registry);
            let possession = Arc::clone(&self.possession);

            let (count, ready) = &*live;
            let mut open = count.lock().map_err(|_| BusError::Poisoned)?;
            while *open >= MAX_CONNECTIONS {
                open = ready.wait(open).map_err(|_| BusError::Poisoned)?;
            }
            *open += 1;
            drop(open);

            let live = Arc::clone(&live);
            std::thread::spawn(move || {
                serve_connection(stream, &registry, &possession, id);
                let (count, ready) = &*live;
                if let Ok(mut open) = count.lock() {
                    *open = open.saturating_sub(1);
                    ready.notify_one();
                }
            });
        }
        Ok(())
    }
}

impl Drop for BusServer {
    /// Removes the socket file so a later bind does not inherit a dead socket.
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

enum LineRead {
    TooLong,
    Io(std::io::Error),
}

fn write_response(writer: &mut UnixStream, response: &Response) -> std::io::Result<()> {
    let mut encoded = serde_json::to_string(response).map_err(std::io::Error::other)?;
    encoded.push('\n');
    writer.write_all(encoded.as_bytes())?;
    writer.flush()
}

fn read_bounded_line<R: BufRead>(reader: &mut R) -> Result<Option<String>, LineRead> {
    let mut raw = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(LineRead::Io)?;
        if buffer.is_empty() {
            if raw.is_empty() {
                return Ok(None);
            }
            break;
        }
        if let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
            raw.extend_from_slice(&buffer[..=index]);
            reader.consume(index + 1);
            break;
        }
        if raw.len() + buffer.len() > MAX_LINE {
            let consume = buffer.len();
            reader.consume(consume);
            drain_until_newline(reader);
            return Err(LineRead::TooLong);
        }
        raw.extend_from_slice(buffer);
        let consumed = buffer.len();
        reader.consume(consumed);
    }
    if raw.len() > MAX_LINE {
        return Err(LineRead::TooLong);
    }
    let text =
        std::str::from_utf8(&raw).map_err(|error| LineRead::Io(std::io::Error::other(error)))?;
    Ok(Some(text.trim_end_matches(['\r', '\n']).to_owned()))
}

fn drain_until_newline<R: BufRead>(reader: &mut R) {
    loop {
        let Ok(buffer) = reader.fill_buf() else {
            return;
        };
        if buffer.is_empty() {
            return;
        }
        if let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
            reader.consume(index + 1);
            return;
        }
        let consumed = buffer.len();
        reader.consume(consumed);
    }
}

/// Reads requests until the peer closes, then withdraws its records.
fn serve_connection(
    stream: UnixStream,
    registry: &Arc<Mutex<Registry>>,
    possession: &PossessionProof,
    id: ConnectionId,
) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    });
    let mut writer = stream;

    loop {
        let line = match read_bounded_line(&mut reader) {
            Ok(Some(line)) => line,
            Ok(None) | Err(LineRead::Io(_)) => break,
            Err(LineRead::TooLong) => {
                let response = Response::error(
                    "LINE_TOO_LONG",
                    format!("bus line exceeds the {MAX_LINE}-byte cap"),
                );
                if write_response(&mut writer, &response).is_err() {
                    break;
                }
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => apply(registry, possession, id, request),
            Err(error) => Response::error("INVALID_REQUEST", error.to_string()),
        };
        if write_response(&mut writer, &response).is_err() {
            break;
        }
    }

    // The peer is gone. Whatever it announced is no longer reachable.
    if let Ok(mut registry) = registry.lock() {
        registry.drop_connection(id);
    }
}

/// Applies one request against the shared registry.
fn apply(
    registry: &Arc<Mutex<Registry>>,
    possession: &PossessionProof,
    id: ConnectionId,
    request: Request,
) -> Response {
    // Possession is proved before the lock is taken. It dials a socket, and
    // holding the registry mutex across a network round trip would let one
    // slow surface stall discovery for every other application.
    if let Request::Register { record } = &request
        && let Err(reason) = possession(record)
    {
        return Response::error("NOT_POSSESSED", reason);
    }

    let Ok(mut registry) = registry.lock() else {
        return Response::error("BUS_UNAVAILABLE", "the bus registry is unavailable");
    };
    match request {
        Request::Register { record } => match registry.register(id, *record) {
            Ok(()) => Response::ok(),
            Err(error) => Response::error("REGISTER_REFUSED", error.to_string()),
        },
        Request::Unregister { binding_digest } => match registry.unregister(id, &binding_digest) {
            Ok(()) => Response::ok(),
            Err(error) => Response::error("UNREGISTER_REFUSED", error.to_string()),
        },
        Request::List => Response::records(registry.list()),
    }
}

/// A client connection to the bus.
pub struct BusClient {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl BusClient {
    /// Connects to a bus socket.
    ///
    /// # Errors
    ///
    /// Returns [`BusError::Io`] when the socket cannot be reached.
    pub fn connect(path: impl AsRef<Path>) -> Result<Self, BusError> {
        let path = path.as_ref();
        let stream = UnixStream::connect(path).map_err(|error| io(path, error))?;
        let reader = BufReader::new(stream.try_clone().map_err(|error| io(path, error))?);
        Ok(Self {
            reader,
            writer: stream,
        })
    }

    /// Sends one request and reads its response.
    ///
    /// The connection is held open by the caller. A host keeps it open for the
    /// life of its Installation, because closing it withdraws its records.
    ///
    /// # Errors
    ///
    /// Returns [`BusError::Io`] when the exchange fails.
    pub fn send(&mut self, request: &Request) -> Result<Response, BusError> {
        let mut encoded = serde_json::to_string(request).map_err(|error| BusError::Io {
            path: "request".to_owned(),
            source: std::io::Error::other(error),
        })?;
        encoded.push('\n');
        self.writer
            .write_all(encoded.as_bytes())
            .map_err(|error| io("bus", error))?;
        self.writer.flush().map_err(|error| io("bus", error))?;

        let line = match read_bounded_line(&mut self.reader) {
            Ok(Some(line)) => line,
            Ok(None) => {
                return Err(io(
                    "bus",
                    std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "bus closed"),
                ));
            }
            Err(LineRead::TooLong) => {
                return Err(io(
                    "bus",
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("bus line exceeds the {MAX_LINE}-byte cap"),
                    ),
                ));
            }
            Err(LineRead::Io(error)) => return Err(io("bus", error)),
        };
        serde_json::from_str(&line).map_err(|error| BusError::Io {
            path: "response".to_owned(),
            source: std::io::Error::other(error),
        })
    }
}
