//! Unix sockets carry bytes; ureq owns the HTTP state machine on those bytes.
//!
//! The connector seam is unversioned, hence the exact ureq dependency pin.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use socket2::{Domain, SockAddr, Socket, Type};

use ureq::Error;
use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport,
};

#[derive(Debug)]
pub(super) struct UnixConnector {
    path: PathBuf,
}

impl UnixConnector {
    pub(super) fn new(path: &str) -> Self {
        Self {
            path: PathBuf::from(path),
        }
    }
}

impl Connector for UnixConnector {
    type Out = UnixTransport;

    fn connect(
        &self,
        details: &ConnectionDetails,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, Error> {
        // Each Agent is tied to one absolute socket path. The synthetic origin
        // is an HTTP Host value, never a DNS name or a fallback TCP destination.
        let stream = connect_socket(&self.path, details.timeout)?;
        Ok(Some(UnixTransport {
            stream,
            buffers: LazyBuffers::new(
                details.config.input_buffer_size(),
                details.config.output_buffer_size(),
            ),
        }))
    }
}

fn connect_socket(path: &std::path::Path, timeout: NextTimeout) -> Result<UnixStream, Error> {
    let budget = socket_timeout(timeout)?.unwrap_or(super::DEFAULT_TIMEOUT);
    let started = Instant::now();
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None)?;
    let address = SockAddr::unix(path)?;
    let remaining = budget
        .checked_sub(started.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(Error::Timeout(timeout.reason))?;
    // socket2 performs nonblocking connect and an OS readiness wait bounded by
    // this budget. It restores blocking mode on success. On failure the local
    // socket is dropped here, so no connect worker or live attempt survives.
    socket
        .connect_timeout(&address, remaining)
        .map_err(|error| map_io(error, timeout))?;
    // Readiness is not itself success. Always check SO_ERROR, then establish
    // that the socket has a peer. A saturated Linux Unix queue may return
    // EAGAIN without initiating a connection, even when SO_ERROR is zero.
    verify_connection(&socket, timeout)?;
    if started.elapsed() >= budget {
        return Err(Error::Timeout(timeout.reason));
    }
    // OwnedFd transfers the socket without requiring socket2's `all` feature.
    let fd: OwnedFd = socket.into();
    Ok(UnixStream::from(fd))
}

fn verify_connection(socket: &Socket, timeout: NextTimeout) -> Result<(), Error> {
    if let Some(error) = socket.take_error()? {
        return Err(map_io(error, timeout));
    }
    socket.peer_addr()?;
    Ok(())
}

fn socket_timeout(timeout: NextTimeout) -> Result<Option<Duration>, Error> {
    // ureq's not_zero() grants an expired budget an additional second. An
    // exhausted Boundary deadline must instead fail before any socket I/O.
    if timeout.after.is_zero() {
        return Err(Error::Timeout(timeout.reason));
    }
    Ok((!timeout.after.is_not_happening()).then_some(*timeout.after))
}

#[derive(Debug)]
pub(super) struct UnixTransport {
    stream: UnixStream,
    buffers: LazyBuffers,
}

impl Transport for UnixTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), Error> {
        self.stream.set_write_timeout(socket_timeout(timeout)?)?;
        self.stream
            .write_all(&self.buffers.output()[..amount])
            .map_err(|error| map_io(error, timeout))
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, Error> {
        self.stream.set_read_timeout(socket_timeout(timeout)?)?;
        let read = self
            .stream
            .read(self.buffers.input_append_buf())
            .map_err(|error| map_io(error, timeout))?;
        self.buffers.input_appended(read);
        Ok(read > 0)
    }

    fn is_open(&mut self) -> bool {
        // Reach uses one request per socket; no liveness probe or pooling.
        false
    }
}

fn map_io(error: io::Error, timeout: NextTimeout) -> Error {
    if matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    ) {
        Error::Timeout(timeout.reason)
    } else {
        Error::Io(error)
    }
}

#[derive(Debug)]
pub(super) struct UnixResolver;

impl Resolver for UnixResolver {
    fn resolve(&self, _: &Uri, _: &Config, _: NextTimeout) -> Result<ResolvedSocketAddrs, Error> {
        // Resolver requires a nonempty address list. UnixConnector ignores it.
        let mut addresses = self.empty();
        addresses.push(SocketAddr::from((Ipv4Addr::LOCALHOST, 80)));
        Ok(addresses)
    }
}

#[cfg(test)]
#[path = "unix_connect_tests.rs"]
mod tests;
