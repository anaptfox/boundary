//! Real sockets qualify the pinned HTTP client and its Unix connector policy.
#![allow(clippy::expect_used, clippy::panic)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use ureq::tls::{Certificate, RootCerts, TlsConfig};

use super::{MAX_BODY, Target};
use crate::{ClientError, Route, Transport};

fn read_request(stream: &mut impl Read) -> (String, Vec<(String, String)>, Vec<u8>) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).expect("request line");
    let request_line = line.trim().to_owned();
    let mut headers = Vec::new();
    loop {
        line.clear();
        reader.read_line(&mut line).expect("request header");
        if line.trim().is_empty() {
            break;
        }
        let (key, value) = line.trim().split_once(':').expect("header");
        headers.push((key.to_ascii_lowercase(), value.trim().to_owned()));
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map_or(0, |(_, value)| value.parse().expect("content length"));
    let mut body = vec![0; length];
    reader.read_exact(&mut body).expect("request body");
    (request_line, headers, body)
}

fn serve(raw: Vec<u8>) -> (Transport, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://{}/boundary/v1",
        listener.local_addr().expect("address")
    );
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        read_request(&mut stream);
        // Cap checks deliberately close before reading the whole response.
        let _ = stream.write_all(&raw);
    });
    (Transport::Http { url }, handle)
}

fn response(raw: Vec<u8>) -> Result<super::HttpResponse, ClientError> {
    let (transport, handle) = serve(raw);
    let response = Target::new(&transport, Duration::from_secs(5))
        .expect("target")
        .request(Route::Manifest, &[]);
    handle.join().expect("server finishes");
    response
}

#[test]
fn reads_length_chunked_and_close_delimited_bodies() {
    for raw in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhe\r\n3\r\nllo\r\n0\r\n\r\n"
            .to_vec(),
        b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello".to_vec(),
    ] {
        assert_eq!(response(raw).expect("response").body, b"hello");
    }
}

fn capped_response(length: usize, framing: &str) -> Vec<u8> {
    let head = match framing {
        "length" => format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\n\r\n"),
        "chunked" => format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{length:x}\r\n"),
        _ => "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_owned(),
    };
    let mut raw = head.into_bytes();
    raw.extend(std::iter::repeat_n(b'x', length));
    if framing == "chunked" {
        raw.extend_from_slice(b"\r\n0\r\n\r\n");
    }
    raw
}

#[test]
fn exactly_at_cap_is_accepted_for_every_body_framing() {
    for framing in ["length", "chunked", "close"] {
        let body = response(capped_response(MAX_BODY, framing))
            .expect("body at cap")
            .body;
        assert_eq!(body.len(), MAX_BODY, "{framing}");
        assert!(body.iter().all(|byte| *byte == b'x'));
    }
}

#[test]
fn one_byte_above_cap_is_refused_for_every_body_framing() {
    for framing in ["length", "chunked", "close"] {
        let error = response(capped_response(MAX_BODY + 1, framing))
            .err()
            .expect("refused");
        assert!(
            matches!(error, ClientError::Io { .. }),
            "{framing}: {error}"
        );
        assert!(error.to_string().contains("cap"), "{framing}: {error}");
    }
}

#[test]
fn refuses_huge_claimed_length_before_waiting_for_a_body() {
    let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 999999999999\r\n\r\n".to_vec();
    let error = response(raw).err().expect("refused");
    assert!(error.to_string().contains("cap"), "{error}");
}

#[test]
fn malformed_http_is_refused() {
    for raw in [
        "BOGUS 200 OK\r\nContent-Length: 2\r\n\r\n{}",
        "HTTP/1.1 2000 OK\r\nContent-Length: 2\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nContent-Length: +2\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}XX0\r\n\r\n",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\n{}\r\n0\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n",
    ] {
        assert!(
            matches!(
                response(raw.as_bytes().to_vec()),
                Err(ClientError::Io { .. })
            ),
            "{raw:?}"
        );
    }
}

#[test]
fn transfer_encoding_takes_precedence_over_content_length() {
    let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n";
    assert_eq!(response(raw.to_vec()).expect("chunked body").body, b"{}");
}

#[test]
fn a_304_has_no_body_even_with_a_claimed_length() {
    let raw = b"HTTP/1.1 304 Not Modified\r\nContent-Length: 5\r\n\r\n";
    assert_eq!(response(raw.to_vec()).expect("304").body, [] as [u8; 0]);
}

#[test]
fn oversized_or_excessive_headers_are_refused() {
    let line = format!(
        "HTTP/1.1 200 OK\r\nX-Pad: {}\r\nContent-Length: 0\r\n\r\n",
        "x".repeat(17 * 1024)
    );
    assert!(response(line.into_bytes()).is_err());
    let mut raw = String::from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n");
    for index in 0..101 {
        use std::fmt::Write as _;
        write!(raw, "X-Pad-{index}: y\r\n").expect("format");
    }
    raw.push_str("\r\n");
    assert!(response(raw.into_bytes()).is_err());
}

#[test]
fn hostile_addresses_fail_before_connecting() {
    for url in [
        "example.invalid/boundary/v1",
        "http://user@example.invalid/boundary/v1",
        "http://example.invalid/boundary/v1?x=1",
        "http://example.invalid/boundary/v1#fragment",
        "http://[::1]:8080/boundary/v1",
        "http://example.invalid/boundary/v1 HTTP/1.1\r\nX: y",
        "http://example.invalid:abc/boundary/v1",
        "http://example.invalid:70000/boundary/v1",
        "http://example.invalid:/boundary/v1",
    ] {
        assert!(
            matches!(
                Target::new(
                    &Transport::Http {
                        url: url.to_owned()
                    },
                    Duration::from_secs(1)
                ),
                Err(ClientError::InvalidAddress { .. })
            ),
            "{url}"
        );
    }
    assert!(matches!(
        Target::new(
            &Transport::Http {
                url: "ftp://example.invalid/boundary/v1".to_owned()
            },
            Duration::from_secs(1)
        ),
        Err(ClientError::UnsupportedScheme { .. })
    ));
}

fn counted_post(raw: &'static [u8]) -> Result<super::HttpResponse, ClientError> {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://{}/boundary/v1",
        listener.local_addr().expect("address")
    );
    let count = Arc::new(AtomicUsize::new(0));
    let server_count = Arc::clone(&count);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let (line, headers, body) = read_request(&mut stream);
        assert_eq!(line, "POST /boundary/v1/invoke HTTP/1.1");
        assert_eq!(body, b"{}");
        assert!(!headers.iter().any(|(name, _)| matches!(
            name.as_str(),
            "cookie" | "accept-encoding" | "authorization"
        )));
        server_count.fetch_add(1, Ordering::SeqCst);
        let _ = stream.write_all(raw);
        drop(stream);
        listener.set_nonblocking(true).expect("nonblocking");
        let deadline = Instant::now() + Duration::from_millis(100);
        while Instant::now() < deadline {
            if let Ok((mut stream, _)) = listener.accept() {
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .expect("timeout");
                read_request(&mut stream);
                server_count.fetch_add(1, Ordering::SeqCst);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            }
            thread::sleep(Duration::from_millis(2));
        }
    });
    let result = Target::new(&Transport::Http { url }, Duration::from_secs(5))
        .expect("target")
        .request(Route::Invoke, b"{}");
    server.join().expect("server");
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "an invocation cannot be sent again"
    );
    result
}

#[test]
fn redirects_http_errors_and_disconnects_never_redispatch_a_post() {
    for raw in [
        b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /other\r\nContent-Length: 2\r\n\r\n{}"
            .as_slice(),
        b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 2\r\n\r\n{}"
            .as_slice(),
    ] {
        assert_eq!(
            counted_post(raw).expect("first response is retained").body,
            b"{}"
        );
    }
    assert!(matches!(counted_post(b""), Err(ClientError::Io { .. })));
    assert!(matches!(
        counted_post(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}"),
        Err(ClientError::Io { .. })
    ));
}

#[test]
fn unix_socket_uses_the_same_http_framing_and_body() {
    static NEXT_PATH: AtomicUsize = AtomicUsize::new(0);
    let path = format!(
        "/tmp/b-reach-{}-{}.sock",
        std::process::id(),
        NEXT_PATH.fetch_add(1, Ordering::Relaxed)
    );
    let listener = UnixListener::bind(&path).expect("Unix listener");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("Unix accept");
        let (line, headers, body) = read_request(&mut stream);
        assert_eq!(line, "POST /boundary/v1/invoke HTTP/1.1");
        assert!(headers.contains(&("host".to_owned(), "localhost".to_owned())));
        assert_eq!(body, b"{\"value\":1}");
        stream.write_all(b"HTTP/1.1 422 Unprocessable Content\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n").expect("Unix response");
    });
    let target = Target::new(
        &Transport::Unix {
            path: path.clone(),
            base: "/boundary/v1".to_owned(),
        },
        Duration::from_secs(5),
    )
    .expect("Unix target");
    let response = target
        .request(Route::Invoke, b"{\"value\":1}")
        .expect("Unix response");
    assert_eq!(response.status, 422);
    assert_eq!(response.body, b"{}");
    server.join().expect("Unix server");
    std::fs::remove_file(path).expect("remove socket");
}

#[test]
fn response_timeout_stops_a_stalled_http_peer() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://{}/boundary/v1",
        listener.local_addr().expect("address")
    );
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        read_request(&mut stream);
        thread::sleep(Duration::from_millis(200));
    });
    let target = Target::new(&Transport::Http { url }, Duration::from_millis(50)).expect("target");
    let start = Instant::now();
    assert!(matches!(
        target.request(Route::Manifest, &[]),
        Err(ClientError::Io { .. })
    ));
    assert!(start.elapsed() < Duration::from_secs(1));
    server.join().expect("server");
}

#[test]
fn unix_socket_timeout_stops_a_stalled_response_body() {
    let path = format!("/tmp/b-reach-timeout-{}.sock", std::process::id());
    let listener = UnixListener::bind(&path).expect("Unix listener");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("Unix accept");
        read_request(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{")
            .expect("partial body");
        thread::sleep(Duration::from_millis(200));
    });
    let target = Target::new(
        &Transport::Unix {
            path: path.clone(),
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
    assert!(start.elapsed() < Duration::from_secs(1));
    server.join().expect("Unix server");
    std::fs::remove_file(path).expect("remove socket");
}

fn tls_server() -> (u16, RootCerts, thread::JoinHandle<bool>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("address").port();
    let cert = rcgen::generate_simple_self_signed(["localhost".to_owned()]).expect("certificate");
    let roots = RootCerts::new_with_certs(&[Certificate::from_der(cert.cert.der()).to_owned()]);
    let cert_der = CertificateDer::from(cert.cert.der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let handle = thread::spawn(move || {
        let (tcp, _) = listener.accept().expect("accept TLS");
        tcp.set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("TLS versions")
                .with_no_client_auth()
                .with_single_cert(vec![cert_der], key)
                .expect("TLS server config");
        let connection = ServerConnection::new(Arc::new(config)).expect("TLS server connection");
        let mut tls = StreamOwned::new(connection, tcp);
        while tls.conn.is_handshaking() {
            if tls.conn.complete_io(&mut tls.sock).is_err() {
                return false;
            }
        }
        let (line, _, _) = read_request(&mut tls);
        assert_eq!(line, "GET /boundary/v1/manifest HTTP/1.1");
        tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
            .expect("TLS response");
        tls.conn.send_close_notify();
        tls.flush().expect("TLS flush");
        true
    });
    (port, roots, handle)
}

#[test]
fn https_verifies_trust_and_hostname_before_sending_http() {
    let (port, roots, server) = tls_server();
    let configured = ureq::config::Config::builder()
        .proxy(None)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .tls_config(TlsConfig::builder().root_certs(roots).build())
        .build();
    let target = Target::with_config(
        &Transport::Http {
            url: format!("https://localhost:{port}/boundary/v1"),
        },
        configured,
    )
    .expect("TLS target");
    assert_eq!(
        target
            .request(Route::Manifest, &[])
            .expect("TLS response")
            .body,
        b"{}"
    );
    assert!(server.join().expect("TLS server"));

    let (port, roots, server) = tls_server();
    let configured = ureq::config::Config::builder()
        .proxy(None)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .tls_config(TlsConfig::builder().root_certs(roots).build())
        .build();
    let target = Target::with_config(
        &Transport::Http {
            url: format!("https://127.0.0.1:{port}/boundary/v1"),
        },
        configured,
    )
    .expect("TLS target");
    assert!(matches!(
        target.request(Route::Manifest, &[]),
        Err(ClientError::Io { .. })
    ));
    assert!(
        !server.join().expect("TLS server"),
        "wrong hostname must prevent HTTP dispatch"
    );

    let (port, _, server) = tls_server();
    let target = Target::new(
        &Transport::Http {
            url: format!("https://localhost:{port}/boundary/v1"),
        },
        Duration::from_secs(5),
    )
    .expect("TLS target");
    assert!(matches!(
        target.request(Route::Manifest, &[]),
        Err(ClientError::Io { .. })
    ));
    assert!(
        !server.join().expect("TLS server"),
        "untrusted certificate must prevent HTTP dispatch"
    );
}
