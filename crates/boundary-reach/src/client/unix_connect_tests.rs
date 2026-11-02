//! Backpressure on a real Unix accept queue must not escape the call deadline.
#![allow(clippy::expect_used, clippy::panic)]

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use socket2::{Domain, SockAddr, Socket, Type};
use ureq::unversioned::transport::time::Instant as TransportInstant;

use super::{
    ConnectionDetails, Connector, LazyBuffers, NextTimeout, Resolver, UnixConnector, UnixResolver,
    UnixTransport,
};

use crate::client::http::Target;
use crate::{ClientError, Route, Transport};

const CHILD_TEST: &str = "client::unix::tests::backlog_probe_child";
const CHILD_PATH: &str = "BOUNDARY_REACH_CONNECT_TEST_PATH";

struct SaturatedQueue {
    listener: Socket,
    queued: Vec<Socket>,
    path: String,
}

impl SaturatedQueue {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = format!(
            "/tmp/b-connect-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let address = SockAddr::unix(&path).expect("Unix address");
        let listener = Socket::new(Domain::UNIX, Type::STREAM, None).expect("Unix listener");
        listener.bind(&address).expect("bind");
        listener.listen(1).expect("minimal accept backlog");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");

        let mut queued = Vec::new();
        for _ in 0..256 {
            let socket = Socket::new(Domain::UNIX, Type::STREAM, None).expect("queue socket");
            match socket.connect_timeout(&address, Duration::from_millis(10)) {
                Ok(()) if socket.peer_addr().is_ok() => queued.push(socket),
                result => {
                    assert!(
                        !queued.is_empty(),
                        "listener must accept a connection before filling: {result:?}"
                    );
                    return Self {
                        listener,
                        queued,
                        path,
                    };
                }
            }
        }
        panic!("a backlog of one did not saturate after 256 connections");
    }
}

impl Drop for SaturatedQueue {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[test]
fn saturated_queue_connect_is_bounded() {
    let queue = SaturatedQueue::new();
    let mut child = Command::new(std::env::current_exe().expect("unit test executable"))
        .args(["--exact", CHILD_TEST, "--nocapture"])
        .env(CHILD_PATH, &queue.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("connect child");
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if child.try_wait().expect("poll child").is_some() {
            let output = child.wait_with_output().expect("child output");
            assert!(
                output.status.success(),
                "connect deadline child failed: {output:?}"
            );
            break;
        }
        if Instant::now() >= deadline {
            child.kill().expect("kill blocked connect");
            let output = child.wait_with_output().expect("reap blocked child");
            panic!(
                "Unix connect escaped its 50ms deadline; child required termination: {output:?}"
            );
        }
        thread::sleep(Duration::from_millis(2));
    }

    // The child is gone and every accepted socket must be one of the idle
    // fillers or a closed attempt. No timed-out request may have written bytes.
    let mut accepted = 0;
    while let Ok((mut socket, _)) = queue.listener.accept() {
        socket
            .set_nonblocking(true)
            .expect("nonblocking accepted socket");
        let mut byte = [0];
        match socket.read(&mut byte) {
            Ok(0) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            result => panic!("a failed connect wrote request bytes: {result:?}"),
        }
        accepted += 1;
    }
    assert!(
        accepted >= queue.queued.len(),
        "all queue fillers remain accounted for"
    );
}

#[test]
fn backlog_probe_child() {
    let Ok(path) = std::env::var(CHILD_PATH) else {
        return;
    };
    let target = Target::new(
        &Transport::Unix {
            path,
            base: "/boundary/v1".to_owned(),
        },
        Duration::from_millis(50),
    )
    .expect("Unix target");
    let start = Instant::now();
    assert!(matches!(
        target.request(Route::Manifest, &[]),
        Err(ClientError::Io { .. })
    ));
    assert!(
        start.elapsed() < Duration::from_millis(750),
        "connect failure must arrive inside the parent harness budget"
    );
}

fn connector_result(path: &str, budget: Duration) -> Result<Option<UnixTransport>, ureq::Error> {
    let configured = crate::client::http::config(Duration::from_secs(5));
    let uri = "http://localhost/boundary/v1/manifest"
        .parse()
        .expect("synthetic origin");
    let resolver = UnixResolver;
    let details = ConnectionDetails {
        uri: &uri,
        addrs: resolver.empty(),
        resolver: &resolver,
        config: &configured,
        request_level: false,
        now: TransportInstant::now(),
        timeout: NextTimeout {
            after: budget.into(),
            reason: ureq::Timeout::Global,
        },
        current_time: Arc::new(TransportInstant::now),
        run_connector: Arc::new(|_| Err(ureq::Error::ConnectionFailed)),
    };
    UnixConnector::new(path).connect(&details, None)
}

#[test]
fn depleted_connect_budget_rejects_before_socket_open() {
    let queue = SaturatedQueue::new();
    assert!(matches!(
        connector_result(&queue.path, Duration::ZERO),
        Err(ureq::Error::Timeout(ureq::Timeout::Global))
    ));
}

#[test]
fn nanosecond_connect_budget_does_not_receive_a_grace_period() {
    let queue = SaturatedQueue::new();
    assert!(matches!(
        connector_result(&queue.path, Duration::from_nanos(1)),
        Err(ureq::Error::Timeout(ureq::Timeout::Global))
    ));
}

#[test]
fn successful_connect_verifies_peer_and_restores_blocking_mode() {
    use ureq::unversioned::transport::Transport as _;
    let queue = SaturatedQueue::new();
    while queue.listener.accept().is_ok() {}
    let mut transport = connector_result(&queue.path, Duration::from_secs(1))
        .expect("connect succeeds")
        .expect("transport");
    assert!(
        !socket2::SockRef::from(&transport.stream)
            .nonblocking()
            .expect("blocking flag")
    );
    assert!(
        !transport
            .stream
            .peer_addr()
            .expect("verified peer")
            .is_unnamed()
    );
    let (mut peer, _) = queue.listener.accept().expect("accepted connection");
    transport.buffers().output()[0] = b'x';
    let timeout = NextTimeout {
        after: Duration::from_secs(1).into(),
        reason: ureq::Timeout::Global,
    };
    transport
        .transmit_output(1, timeout)
        .expect("send on established socket");
    let mut byte = [0];
    peer.read_exact(&mut byte).expect("received byte");
    assert_eq!(byte, [b'x']);
}

#[test]
fn zero_socket_error_does_not_make_an_unconnected_socket_successful() {
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None).expect("unconnected socket");
    assert!(socket.take_error().expect("SO_ERROR").is_none());
    let timeout = NextTimeout {
        after: Duration::from_secs(1).into(),
        reason: ureq::Timeout::Global,
    };
    assert!(matches!(
        super::verify_connection(&socket, timeout),
        Err(ureq::Error::Io(_))
    ));
}

fn transport_pair() -> (UnixTransport, UnixStream) {
    let (stream, peer) = UnixStream::pair().expect("Unix pair");
    (
        UnixTransport {
            stream,
            buffers: LazyBuffers::new(1024, 1024),
        },
        peer,
    )
}

fn zero_timeout() -> NextTimeout {
    NextTimeout {
        after: Duration::ZERO.into(),
        reason: ureq::Timeout::Global,
    }
}

#[test]
fn depleted_read_budget_rejects_even_when_data_is_ready() {
    use ureq::unversioned::transport::Transport as _;
    let (mut transport, mut peer) = transport_pair();
    peer.write_all(b"already buffered").expect("peer bytes");
    assert!(matches!(
        transport.await_input(zero_timeout()),
        Err(ureq::Error::Timeout(ureq::Timeout::Global))
    ));
}

#[test]
fn depleted_write_budget_rejects_before_any_bytes_leave() {
    use ureq::unversioned::transport::Transport as _;
    let (mut transport, mut peer) = transport_pair();
    transport.buffers().output()[0] = b'x';
    assert!(matches!(
        transport.transmit_output(1, zero_timeout()),
        Err(ureq::Error::Timeout(ureq::Timeout::Global))
    ));
    peer.set_nonblocking(true).expect("nonblocking peer");
    assert_eq!(
        peer.read(&mut [0]).expect_err("no bytes were sent").kind(),
        io::ErrorKind::WouldBlock
    );
}
