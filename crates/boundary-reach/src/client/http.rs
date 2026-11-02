//! ureq supplies HTTP parsing; this module owns Reach's address and call policy.

use std::io::{self, Read};
use std::time::Duration;

use ureq::config::Config;
use ureq::http::{HeaderMap, Uri, header};
use ureq::{Agent, Body};

use super::unix::{UnixConnector, UnixResolver};
use super::{ClientError, REQUEST_CONTENT_TYPE, RESPONSE_CONTENT_TYPE, Route};
use crate::record::Transport;

/// Response bytes retained for one Handoff envelope.
pub(super) const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_HEADERS: usize = 100;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_HEADER_LINE: usize = 16 * 1024;

pub(super) struct HttpResponse {
    pub(super) status: u16,
    pub(super) etag: Option<String>,
    pub(super) body: Vec<u8>,
}

pub(super) struct Target {
    agent: Agent,
    base: String,
    address: String,
}

impl Target {
    pub(super) fn new(transport: &Transport, timeout: Duration) -> Result<Self, ClientError> {
        Self::with_config(transport, config(timeout))
    }

    pub(super) fn with_config(transport: &Transport, config: Config) -> Result<Self, ClientError> {
        let (agent, base, address) = match transport {
            Transport::Http { url } => {
                validate_http_base(url)?;
                (
                    config.new_agent(),
                    url.trim_end_matches('/').to_owned(),
                    url.clone(),
                )
            }
            Transport::Unix { path, base } => {
                if !path.starts_with('/') || path.contains('\0') || !base.starts_with('/') {
                    return Err(invalid_address(
                        "Unix socket and base paths must be absolute",
                    ));
                }
                let url = format!("http://localhost{}", base.trim_end_matches('/'));
                validate_http_base(&url)?;
                let agent = Agent::with_parts(config, UnixConnector::new(path), UnixResolver);
                (agent, url, path.clone())
            }
        };
        Ok(Self {
            agent,
            base,
            address,
        })
    }

    pub(super) fn address(&self) -> &str {
        &self.address
    }

    pub(super) fn request(&self, route: Route, body: &[u8]) -> Result<HttpResponse, ClientError> {
        let url = format!("{}{}", self.base, route.suffix());
        // One library call per invocation. Transport failures are returned, never
        // retried; redirects cannot cause another destination to receive input.
        let response = match route {
            Route::Manifest => self
                .agent
                .get(&url)
                .header("Accept", RESPONSE_CONTENT_TYPE)
                .header("Connection", "close")
                .call(),
            Route::Invoke => self
                .agent
                .post(&url)
                .header("Accept", RESPONSE_CONTENT_TYPE)
                .header("Content-Type", REQUEST_CONTENT_TYPE)
                .header("Connection", "close")
                .send(body),
        }
        .map_err(|error| self.io(error.into_io()))?;
        let (parts, mut body) = response.into_parts();
        check_headers(&parts.headers).map_err(|error| self.io(error))?;
        let etag = parts
            .headers
            .get(header::ETAG)
            .map(|value| {
                value
                    .to_str()
                    .map(str::to_owned)
                    .map_err(|error| self.io(io::Error::new(io::ErrorKind::InvalidData, error)))
            })
            .transpose()?;
        let bytes = read_body(&mut body).map_err(|error| self.io(error))?;
        Ok(HttpResponse {
            status: parts.status.as_u16(),
            etag,
            body: bytes,
        })
    }

    fn io(&self, source: io::Error) -> ClientError {
        ClientError::Io {
            address: self.address.clone(),
            source,
        }
    }
}

pub(super) fn config(timeout: Duration) -> Config {
    Config::builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .proxy(None)
        .timeout_global(Some(timeout))
        .max_response_header_size(MAX_HEADER_BYTES)
        .max_idle_connections(0)
        .max_idle_connections_per_host(0)
        .build()
}

fn validate_http_base(raw: &str) -> Result<(), ClientError> {
    // Keep Reach's no-userinfo/query/fragment profile. URI parsing, authority
    // validation, port handling and request-line encoding belong to ureq/http.
    if raw
        .chars()
        .any(|c| c.is_control() || !c.is_ascii() || matches!(c, ' ' | '@' | '?' | '#' | '[' | ']'))
    {
        return Err(invalid_address(
            "Reach URLs contain no userinfo, query, fragment, IPv6 literal or request-line controls",
        ));
    }
    let uri: Uri = raw
        .parse()
        .map_err(|error| invalid_address(format!("{error}")))?;
    match uri.scheme_str() {
        Some("http" | "https") => {}
        Some(_) => {
            return Err(ClientError::UnsupportedScheme {
                url: raw.to_owned(),
            });
        }
        None => return Err(invalid_address("Reach URLs must be absolute HTTP(S) URLs")),
    }
    if uri.host().is_none_or(str::is_empty) {
        return Err(invalid_address("Reach URL must have a host"));
    }
    // http::Authority accepts explicit ports that port_u16() cannot decode.
    // Refuse them here; the resolver otherwise substitutes the default port.
    if uri
        .authority()
        .is_some_and(|authority| authority.as_str().contains(':') && authority.port_u16().is_none())
    {
        return Err(invalid_address("Reach URL has an invalid explicit port"));
    }
    Ok(())
}

fn invalid_address(reason: impl Into<String>) -> ClientError {
    ClientError::InvalidAddress {
        reason: reason.into(),
    }
}

fn check_headers(headers: &HeaderMap) -> io::Result<()> {
    if headers.len() > MAX_HEADERS
        || headers
            .iter()
            .any(|(name, value)| name.as_str().len() + value.as_bytes().len() + 4 > MAX_HEADER_LINE)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "response headers exceed the Reach limits",
        ));
    }
    Ok(())
}

fn read_body(body: &mut Body) -> io::Result<Vec<u8>> {
    if body
        .content_length()
        .is_some_and(|length| length > MAX_BODY as u64)
    {
        return Err(body_too_large());
    }
    // Read one sentinel byte beyond the cap so exactly-at-cap responses can
    // reach EOF. ureq's limit reader otherwise errors before checking that EOF.
    let mut bytes = Vec::new();
    body.as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BODY {
        return Err(body_too_large());
    }
    Ok(bytes)
}

fn body_too_large() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "response body exceeds the 8388608-byte cap",
    )
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
