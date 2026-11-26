//! A Prometheus-compatible API reached directly at a URL (spec §9): its HTTP client, its
//! authentication and the words of its errors.

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use http::header::{AUTHORIZATION, LOCATION};
use http::{HeaderMap, HeaderValue, Request, StatusCode};
use rustls::AlertDescription;
use serde_json::Value;
use url::Url;

use super::prometheus::{answer, Target};
use super::{is_loopback, read_pem_file, LabelMatcher, PemFile, RemoteAuth};
use crate::app_core::AppCore;
use crate::error::{error_chain, CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::invalid;
use crate::secrets::Secret;

const NO_SECRET: &str =
    "No password (or token) is saved for this cluster: enter it in the cluster settings.";
const UNSENDABLE_TOKEN: &str = "The token holds characters an HTTP header cannot carry.";

/// A `remote` setting, as its requests need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteEndpoint {
    pub(crate) url: Url,
    pub(crate) tenant: Option<String>,
    pub(crate) matcher: Option<LabelMatcher>,
    pub(crate) auth: RemoteAuth,
    pub(crate) ca_path: Option<String>,
    /// The cluster's tunnel gateway URL (`U(T)`), when the cluster has a tunnel. A `Secret`, so
    /// `Debug` never shows its token.
    pub(crate) proxy: Option<Secret>,
}

impl RemoteEndpoint {
    /// The URL's host, with `:port` when the URL names one other than its scheme's default
    /// (spec I52).
    pub(crate) fn host(&self) -> String {
        let host = self.url.host_str().unwrap_or_default();
        match self.url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        }
    }

    /// The URL without its trailing `/`.
    fn base(&self) -> &str {
        self.url.as_str().trim_end_matches('/')
    }

    /// How a 401, 403 or 404 reads (spec I46).
    pub(crate) fn refusal(&self, status: StatusCode) -> IpcError {
        let host = self.host();
        match status {
            StatusCode::NOT_FOUND => IpcError::new(
                ErrorCode::NotFound,
                format!(
                    "{host} has no Prometheus API at {}: check the path.",
                    self.base()
                ),
            ),
            StatusCode::FORBIDDEN => IpcError::new(
                ErrorCode::Forbidden,
                format!("{host} refused the credentials (HTTP 403)."),
            ),
            _ => IpcError::new(
                ErrorCode::Unauthorized,
                format!("{host} refused the credentials (HTTP {}).", status.as_u16()),
            ),
        }
    }
}

/// `‹url›/api/v1/‹endpoint›` (spec I38).
impl Target for RemoteEndpoint {
    fn url(&self, api: &str) -> String {
        format!("{}{api}", self.base())
    }

    fn tenant(&self) -> Option<&str> {
        self.tenant.as_deref()
    }

    fn matcher(&self) -> Option<&LabelMatcher> {
        self.matcher.as_ref()
    }
}

/// The HTTP client of one cluster's URL, built for its setting and its secret (spec I39 to
/// I41). Credentials go only to the URL: redirects are never followed.
#[derive(Debug)]
pub(crate) struct Remote {
    endpoint: RemoteEndpoint,
    secret: Option<Secret>,
    client: reqwest::Client,
}

impl Remote {
    /// Reads the CA file and the client certificate now, so a later change to the files
    /// needs a new client.
    pub(crate) fn new(endpoint: RemoteEndpoint, secret: Option<Secret>) -> CoreResult<Self> {
        // reqwest has no TLS crypto provider of its own here, so it takes the process default.
        // kube uses ring; a second provider would make every kube connection panic.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut headers = HeaderMap::new();
        if let Some(value) = authorization(&endpoint.auth, secret.as_ref())? {
            headers.insert(AUTHORIZATION, value);
        }
        // The cluster's tunnel when it has one, otherwise the system proxy; never for this
        // machine (spec I44, I33; tunnels spec §5.7).
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .default_headers(headers);
        if !uses_proxy(&endpoint.url) {
            builder = builder.no_proxy();
        } else if let Some(gateway) = &endpoint.proxy {
            let proxy = reqwest::Proxy::all(gateway.expose()).map_err(|_| {
                crate::error::IpcError::new(
                    crate::error::ErrorCode::Internal,
                    "the tunnel gateway URL is not valid",
                )
            })?;
            builder = builder.proxy(proxy);
        }
        if let Some(ca_path) = &endpoint.ca_path {
            let pem = read_pem_file(ca_path, PemFile::Ca)?;
            let roots =
                reqwest::Certificate::from_pem_bundle(&pem).map_err(|e| unusable(&endpoint, &e))?;
            builder = builder.tls_certs_merge(roots);
        }
        if let RemoteAuth::Mtls {
            cert_path,
            key_path,
        } = &endpoint.auth
        {
            let mut pem = read_pem_file(cert_path, PemFile::Certificate)?;
            pem.push(b'\n');
            pem.extend(read_pem_file(key_path, PemFile::Key)?);
            let identity =
                reqwest::Identity::from_pem(&pem).map_err(|e| unusable(&endpoint, &e))?;
            builder = builder.identity(identity);
        }
        let client = builder.build().map_err(|e| unusable(&endpoint, &e))?;
        Ok(Self {
            endpoint,
            secret,
            client,
        })
    }

    pub(crate) fn endpoint(&self) -> &RemoteEndpoint {
        &self.endpoint
    }

    /// Whether this client was built for `endpoint` and `secret`.
    pub(crate) fn serves(&self, endpoint: &RemoteEndpoint, secret: Option<&Secret>) -> bool {
        self.endpoint == *endpoint && self.secret.as_ref() == secret
    }

    /// One request, without retry, given up after `limit` (spec I42). Returns Prometheus's
    /// `data`.
    pub(crate) async fn call(
        &self,
        request: Request<Vec<u8>>,
        limit: Duration,
    ) -> CoreResult<Value> {
        let host = self.endpoint.host();
        let request = reqwest::Request::try_from(request).map_err(|e| {
            IpcError::new(
                ErrorCode::Internal,
                format!("could not build the Prometheus request: {e}"),
            )
        })?;
        let exchange = async {
            let response = self.client.execute(request).await?;
            let status = response.status();
            let location = response.headers().get(LOCATION).cloned();
            let body = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, location, body))
        };
        let (status, location, body) = tokio::time::timeout(limit, exchange)
            .await
            .map_err(|_| {
                IpcError::new(
                    ErrorCode::Unreachable,
                    format!("Cannot reach {host}: no answer within {limit:?}."),
                )
            })?
            .map_err(|e| unanswered(&host, &e))?;
        if status.is_redirection() {
            let location = location
                .as_ref()
                .and_then(|value| value.to_str().ok())
                .unwrap_or("nowhere");
            return Err(IpcError::new(
                ErrorCode::Unreachable,
                format!("{host} answered with a redirect to {location}; set the URL it points to."),
            )
            .with_details(format!("HTTP {}", status.as_u16())));
        }
        answer(status, &body, |status, _| self.endpoint.refusal(status))
    }
}

/// Whether requests to `url` may go through the system proxy (spec I44). Never to this
/// machine, where Basic and Bearer may travel over plain `http` (I33): a proxy would carry
/// them off it in clear text.
fn uses_proxy(url: &Url) -> bool {
    !is_loopback(url)
}

/// The `Authorization` header of Basic or Bearer (spec I31), marked sensitive so `Debug`
/// never shows it. `None` for the other kinds, or without a secret.
fn authorization(auth: &RemoteAuth, secret: Option<&Secret>) -> CoreResult<Option<HeaderValue>> {
    let value = match (auth, secret) {
        (RemoteAuth::Basic { username }, Some(password)) => {
            let pair = format!("{username}:{}", password.expose());
            format!("Basic {}", STANDARD.encode(pair))
        }
        (RemoteAuth::Bearer, Some(token)) => format!("Bearer {}", token.expose()),
        _ => return Ok(None),
    };
    let mut value = HeaderValue::from_str(&value).map_err(|_| invalid(UNSENDABLE_TOKEN))?;
    value.set_sensitive(true);
    Ok(Some(value))
}

/// The TLS files or settings could not make a client.
fn unusable(endpoint: &RemoteEndpoint, error: &(dyn Error + 'static)) -> IpcError {
    IpcError::new(
        ErrorCode::InvalidInput,
        format!(
            "The TLS settings for {} cannot be used: {}.",
            endpoint.host(),
            root_cause(error)
        ),
    )
    .with_details(error_chain(error))
}

/// The error of an exchange that got no HTTP answer (spec I46).
fn unanswered(host: &str, error: &(dyn Error + 'static)) -> IpcError {
    let failure = match tls_error(error) {
        Some(rustls::Error::InvalidCertificate(_)) => IpcError::new(
            ErrorCode::Unreachable,
            format!(
                "The certificate of {host} is not trusted: add its CA file in the cluster settings."
            ),
        ),
        Some(rustls::Error::AlertReceived(AlertDescription::CertificateRequired)) => IpcError::new(
            ErrorCode::Unauthorized,
            format!("{host} asks for a client certificate."),
        ),
        _ => IpcError::new(
            ErrorCode::Unreachable,
            format!("Cannot reach {host}: {}.", root_cause(error)),
        ),
    };
    failure.with_details(error_chain(error))
}

/// The TLS error under `error`, if TLS failed.
fn tls_error<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a rustls::Error> {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(tls) = error.downcast_ref::<rustls::Error>() {
            return Some(tls);
        }
        current = cause(error);
    }
    None
}

/// The deepest cause's text, without a final `.`, such as "Connection refused (os error 111)".
fn root_cause(error: &(dyn Error + 'static)) -> String {
    let mut deepest = error;
    while let Some(next) = cause(deepest) {
        deepest = next;
    }
    deepest.to_string().trim_end_matches('.').to_owned()
}

/// What `error` wraps. An `io::Error` hides the error it wraps from `source()`, and
/// reqwest reports a TLS failure as an `io::Error` inside another.
fn cause<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a (dyn Error + 'static)> {
    match error
        .downcast_ref::<std::io::Error>()
        .and_then(|io| io.get_ref())
    {
        Some(inner) => Some(inner as &(dyn Error + 'static)),
        None => error.source(),
    }
}

impl AppCore {
    /// The client of the cluster's URL, with the secret its setting sends, kept until the
    /// setting or the secret change (spec I41). `InvalidInput` when Basic or Bearer has no
    /// secret saved.
    pub(crate) async fn remote(
        &self,
        id: &ClusterId,
        endpoint: &RemoteEndpoint,
    ) -> CoreResult<Arc<Remote>> {
        let secret = match endpoint.auth {
            RemoteAuth::Basic { .. } | RemoteAuth::Bearer => Some(
                self.metrics_secret(id)
                    .await?
                    .ok_or_else(|| invalid(NO_SECRET))?,
            ),
            RemoteAuth::Anonymous | RemoteAuth::Mtls { .. } => None,
        };
        let gateway = match self.cluster_tunnel(id) {
            Some(def) if !is_loopback(&endpoint.url) => {
                if endpoint.url.scheme() != "https" {
                    return Err(invalid(
                        "A remote metrics URL needs https:// to go through the cluster's tunnel",
                    ));
                }
                Some(self.tunnel_url(&def)?)
            }
            _ => None,
        };
        let endpoint = RemoteEndpoint {
            proxy: gateway,
            ..endpoint.clone()
        };
        self.metrics().remote(id, &endpoint, secret)
    }
}

#[cfg(test)]
mod tests {
    use std::fmt;
    use std::io;

    use std::time::Instant;

    use http::{Method, StatusCode};
    use rustls::{AlertDescription, CertificateError};

    use super::*;
    use crate::error::ErrorCode;
    use crate::metrics::prometheus::{answer, build_request, TENANT_HEADER};
    use crate::metrics::Metrics;
    use crate::paths::AppPaths;
    use crate::secrets::{Secret, SecretStore};

    fn endpoint(url: &str, auth: RemoteAuth) -> RemoteEndpoint {
        RemoteEndpoint {
            url: Url::parse(url).unwrap(),
            tenant: None,
            matcher: None,
            auth,
            ca_path: None,
            proxy: None,
        }
    }

    fn anonymous(url: &str) -> RemoteEndpoint {
        endpoint(url, RemoteAuth::Anonymous)
    }

    /// A wrapper whose source is `inner`, as reqwest and hyper wrap what failed.
    #[derive(Debug)]
    struct Wrapped(Box<dyn Error + Send + Sync>);

    impl fmt::Display for Wrapped {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("error sending request")
        }
    }

    impl Error for Wrapped {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(self.0.as_ref())
        }
    }

    /// `tls` as reqwest reports it: inside an `io::Error` inside another, under a wrapper.
    fn tls_failure(tls: rustls::Error) -> Wrapped {
        let inner = io::Error::new(io::ErrorKind::InvalidData, tls);
        Wrapped(Box::new(io::Error::other(inner)))
    }

    #[test]
    fn the_host_keeps_a_port_only_when_the_url_names_one() {
        for (url, host) in [
            ("https://mimir.example.com/prometheus", "mimir.example.com"),
            ("http://127.0.0.1:9009/prometheus", "127.0.0.1:9009"),
            ("https://[::1]:8443", "[::1]:8443"),
            ("https://MIMIR.example.com:443", "mimir.example.com"),
        ] {
            assert_eq!(anonymous(url).host(), host, "{url}");
        }
    }

    #[test]
    fn only_a_url_off_this_machine_may_use_the_system_proxy() {
        for url in [
            "http://localhost:9009/prometheus",
            "http://127.0.0.2:9009",
            "http://[::1]:9009",
            "https://localhost",
        ] {
            assert!(!uses_proxy(&Url::parse(url).unwrap()), "{url}");
        }
        for url in [
            "https://mimir.example.com/prometheus",
            "http://10.0.0.1:9009",
        ] {
            assert!(uses_proxy(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn requests_go_under_the_url_with_the_tenant_header() {
        let mut target = anonymous("https://mimir.example.com/prometheus");
        target.tenant = Some("team-a".to_owned());
        assert_eq!(
            target.url("/api/v1/query_range"),
            "https://mimir.example.com/prometheus/api/v1/query_range"
        );
        assert_eq!(
            anonymous("https://mimir.example.com").url("/api/v1/query"),
            "https://mimir.example.com/api/v1/query"
        );

        let get = build_request(&target, "/api/v1/query", &[("query", "up".to_owned())]).unwrap();
        assert_eq!(*get.method(), Method::GET);
        assert_eq!(
            get.uri().to_string(),
            "https://mimir.example.com/prometheus/api/v1/query?query=up"
        );
        assert_eq!(get.headers()[TENANT_HEADER], "team-a");
        let long = "a".repeat(9000);
        let post = build_request(&target, "/api/v1/query", &[("query", long)]).unwrap();
        assert_eq!(*post.method(), Method::POST);
        assert_eq!(
            post.uri().to_string(),
            "https://mimir.example.com/prometheus/api/v1/query"
        );
        assert_eq!(post.headers()[TENANT_HEADER], "team-a");
    }

    #[test]
    fn basic_and_bearer_send_an_authorization_header_that_debug_never_shows() {
        let password = Secret::new("pa:ss wörd");
        let basic = RemoteAuth::Basic {
            username: "me".to_owned(),
        };
        let header = authorization(&basic, Some(&password)).unwrap().unwrap();
        // base64("me:pa:ss wörd")
        assert_eq!(header, "Basic bWU6cGE6c3Mgd8O2cmQ=");
        assert!(header.is_sensitive());
        let token = Secret::new("tok-123");
        let header = authorization(&RemoteAuth::Bearer, Some(&token))
            .unwrap()
            .unwrap();
        assert_eq!(header, "Bearer tok-123");
        assert!(header.is_sensitive());
        assert_eq!(authorization(&RemoteAuth::Anonymous, None).unwrap(), None);

        let err = authorization(&RemoteAuth::Bearer, Some(&Secret::new("tok\nen"))).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(
            err.message,
            "The token holds characters an HTTP header cannot carry."
        );

        let remote = Remote::new(
            endpoint("https://mimir.example.com", RemoteAuth::Bearer),
            Some(token),
        )
        .unwrap();
        let shown = format!("{remote:?}");
        assert!(!shown.contains("tok-123"), "{shown}");
        let remote =
            Remote::new(endpoint("https://mimir.example.com", basic), Some(password)).unwrap();
        let shown = format!("{remote:?}");
        assert!(!shown.contains("pa:ss"), "{shown}");
        assert!(!shown.contains("bWU6cGE6c3Mgd8O2cmQ="), "{shown}");
    }

    #[test]
    fn a_client_is_kept_until_the_setting_or_the_secret_changes() {
        let metrics = Metrics::default();
        let id = "c".repeat(32);
        let bearer = endpoint("https://mimir.example.com", RemoteAuth::Bearer);
        let client = |endpoint: &RemoteEndpoint, secret: &str| {
            metrics
                .remote(&id, endpoint, Some(Secret::new(secret)))
                .unwrap()
        };
        let first = client(&bearer, "a");
        assert!(Arc::ptr_eq(&first, &client(&bearer, "a")));
        let new_secret = client(&bearer, "b");
        assert!(!Arc::ptr_eq(&first, &new_secret));
        let tenant = RemoteEndpoint {
            tenant: Some("team-a".to_owned()),
            ..bearer
        };
        let new_setting = client(&tenant, "b");
        assert!(!Arc::ptr_eq(&new_secret, &new_setting));
        assert!(Arc::ptr_eq(&new_setting, &client(&tenant, "b")));
        metrics.forget_remote(&id);
        assert!(!Arc::ptr_eq(&new_setting, &client(&tenant, "b")));
    }

    #[tokio::test]
    async fn basic_and_bearer_need_a_saved_secret() {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
        let core = AppCore::start_with_kubeconfig_env(paths, None)
            .await
            .unwrap();
        let id = "c".repeat(32);
        let basic = endpoint(
            "https://mimir.example.com",
            RemoteAuth::Basic {
                username: "me".to_owned(),
            },
        );
        for target in [
            basic.clone(),
            endpoint("https://mimir.example.com", RemoteAuth::Bearer),
        ] {
            let err = core.remote(&id, &target).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput);
            assert_eq!(
                err.message,
                "No password (or token) is saved for this cluster: enter it in the cluster settings."
            );
        }
        assert!(core
            .remote(&id, &anonymous("https://mimir.example.com"))
            .await
            .is_ok());
        core.metrics_secret_set(&id, Secret::new("pw")).unwrap();
        assert!(core.remote(&id, &basic).await.is_ok());
    }

    /// A keychain that takes its time, as one that waits for its user to unlock it does.
    struct SlowKeychain(Duration);

    impl SecretStore for SlowKeychain {
        fn get(&self, _: &ClusterId) -> CoreResult<Option<Secret>> {
            std::thread::sleep(self.0);
            Ok(Some(Secret::new("pw")))
        }

        fn set(&self, _: &ClusterId, _: &Secret) -> CoreResult<()> {
            Ok(())
        }

        fn delete(&self, _: &ClusterId) -> CoreResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_slow_keychain_read_does_not_hold_the_async_thread() {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
        let keychain = Arc::new(SlowKeychain(Duration::from_millis(400)));
        let core = AppCore::start_with_secret_store(paths, None, keychain)
            .await
            .unwrap();
        let id = "c".repeat(32);
        let bearer = endpoint("https://mimir.example.com", RemoteAuth::Bearer);

        // This test's runtime has one thread, so a read made on it keeps the timer waiting.
        let started = Instant::now();
        let (remote, ticked) = tokio::join!(core.remote(&id, &bearer), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            started.elapsed()
        });

        assert!(remote.is_ok());
        assert!(
            ticked < Duration::from_millis(300),
            "the timer waited {ticked:?} for the keychain"
        );
    }

    #[test]
    fn refusals_name_the_host_and_the_url() {
        let target = anonymous("https://mimir.example.com:8443/prometheus/");
        let fail = |status: u16, body: &str| {
            answer(
                StatusCode::from_u16(status).unwrap(),
                body.as_bytes(),
                |s, _| target.refusal(s),
            )
            .unwrap_err()
        };
        let no_tenant = fail(401, "no org id\n");
        assert_eq!(no_tenant.code, ErrorCode::Unauthorized);
        assert_eq!(
            no_tenant.message,
            "Mimir needs a tenant: set Tenant in this cluster's metrics settings."
        );
        for (status, code) in [(401, ErrorCode::Unauthorized), (403, ErrorCode::Forbidden)] {
            let refused = fail(status, "invalid credentials");
            assert_eq!(refused.code, code);
            assert_eq!(
                refused.message,
                format!("mimir.example.com:8443 refused the credentials (HTTP {status}).")
            );
            assert_eq!(refused.details, Some(format!("HTTP {status}")));
        }
        let missing = fail(404, "404 page not found");
        assert_eq!(missing.code, ErrorCode::NotFound);
        assert_eq!(
            missing.message,
            "mimir.example.com:8443 has no Prometheus API at https://mimir.example.com:8443/prometheus: check the path."
        );
        let bad_query = fail(
            400,
            r#"{"status":"error","errorType":"bad_data","error":"parse error at char 5"}"#,
        );
        assert_eq!(bad_query.code, ErrorCode::Internal);
        assert_eq!(bad_query.message, "parse error at char 5");
        assert_eq!(fail(503, "busy").code, ErrorCode::Unreachable);
    }

    #[test]
    fn exchanges_that_got_no_answer_are_named_by_what_failed() {
        let host = "mimir.example.com";
        let untrusted = unanswered(
            host,
            &tls_failure(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer,
            )),
        );
        assert_eq!(untrusted.code, ErrorCode::Unreachable);
        assert_eq!(
            untrusted.message,
            "The certificate of mimir.example.com is not trusted: add its CA file in the cluster settings."
        );

        let asks = unanswered(
            host,
            &tls_failure(rustls::Error::AlertReceived(
                AlertDescription::CertificateRequired,
            )),
        );
        assert_eq!(asks.code, ErrorCode::Unauthorized);
        assert_eq!(
            asks.message,
            "mimir.example.com asks for a client certificate."
        );

        let refused = unanswered(
            host,
            &Wrapped(Box::new(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "Connection refused (os error 111)",
            ))),
        );
        assert_eq!(refused.code, ErrorCode::Unreachable);
        assert_eq!(
            refused.message,
            "Cannot reach mimir.example.com: Connection refused (os error 111)."
        );
        assert_eq!(
            refused.details.as_deref(),
            Some("error sending request: Connection refused (os error 111)")
        );
    }

    /// Review Focus 2: the path is kept as typed, and the API path goes under it.
    #[test]
    fn a_path_prefix_is_kept_as_typed_under_the_api_path() {
        let saved =
            |typed: &str| anonymous(crate::metrics::remote_url_of(typed).unwrap().1.as_str());
        for (typed, query_range) in [
            (
                " https://grafana.example.net/api/prom/ ",
                "https://grafana.example.net/api/prom/api/v1/query_range",
            ),
            (
                "https://Mimir.Example.com/Team-A/Prometheus//",
                "https://mimir.example.com/Team-A/Prometheus/api/v1/query_range",
            ),
            (
                "https://mimir.example.com/my prefix",
                "https://mimir.example.com/my%20prefix/api/v1/query_range",
            ),
        ] {
            assert_eq!(
                saved(typed).url("/api/v1/query_range"),
                query_range,
                "{typed:?}"
            );
        }
        // The query endpoint pasted whole: the 404 names the URL as saved.
        let pasted = saved("https://mimir.example.com/prometheus/api/v1/query");
        let missing = pasted.refusal(StatusCode::NOT_FOUND);
        assert_eq!(missing.code, ErrorCode::NotFound);
        assert_eq!(
            missing.message,
            "mimir.example.com has no Prometheus API at https://mimir.example.com/prometheus/api/v1/query: check the path."
        );
    }

    /// Review Focus 5: the tenant goes out unchanged, in one header.
    #[test]
    fn the_tenant_header_carries_every_character_mimir_allows() {
        let mut target = anonymous("https://mimir.example.com/prometheus");
        target.tenant = Some("Team.A_1-(prod)*'!".to_owned());
        let get = build_request(&target, "/api/v1/query", &[("query", "up".to_owned())]).unwrap();
        assert_eq!(get.headers()[TENANT_HEADER], "Team.A_1-(prod)*'!");
        assert_eq!(get.headers().get_all(TENANT_HEADER).iter().count(), 1);
    }
}
