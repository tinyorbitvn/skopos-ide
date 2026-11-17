//! The `remote` metrics provider (spec I68) against a server started by each test on
//! 127.0.0.1: plain HTTP, and HTTPS with certificates from a test CA, with and without a
//! client certificate. Secrets live in memory; no keychain and no other network is used.

mod support;

use std::convert::Infallible;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hyper::body::Incoming;
use hyper::header::{HeaderValue, LOCATION};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig};
use serde_json::json;
use skopos_core::app_core::AppCore;
use skopos_core::error::{CoreResult, ErrorCode};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{
    MetricName, MetricsLimits, MetricsProvider, MetricsProviderSetting, MetricsRange,
    MetricsResult, MetricsTarget, RemoteAuth, RemoteChoice,
};
use skopos_core::secrets::{keychain_unavailable, MemorySecretStore, Secret, SecretStore};
use skopos_fakekube::FakeKubeConfig;
use support::{connected_fake, connected_fake_with};
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

const TENANT: &str = "team-a";

/// What the server saw of one request.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    authorization: Vec<String>,
    tenant: Vec<String>,
}

impl Seen {
    fn of(request: &Request<Incoming>) -> Self {
        let values = |name: &str| {
            request
                .headers()
                .get_all(name)
                .iter()
                .map(|value| value.to_str().unwrap().to_owned())
                .collect()
        };
        Self {
            path: request.uri().path().to_owned(),
            authorization: values("authorization"),
            tenant: values("x-scope-orgid"),
        }
    }
}

type Reply = Arc<dyn Fn(&Seen) -> Response<String> + Send + Sync>;

/// A server on 127.0.0.1 that answers every request with `reply` and records it.
struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    /// Plain HTTP without `tls`.
    async fn start(
        tls: Option<Arc<ServerConfig>>,
        reply: impl Fn(&Seen) -> Response<String> + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let reply: Reply = Arc::new(reply);
        let recorded = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (seen, reply, tls) = (Arc::clone(&recorded), Arc::clone(&reply), tls.clone());
                tokio::spawn(async move {
                    let Some(config) = tls else {
                        return serve(stream, seen, reply).await;
                    };
                    match TlsAcceptor::from(config)
                        .accept(stream)
                        .into_fallible()
                        .await
                    {
                        Ok(stream) => serve(stream, seen, reply).await,
                        // Reads what the client still sends, so the connection is not reset
                        // before the client reads the TLS alert.
                        Err((_, mut stream)) => {
                            let _ = tokio::io::copy(&mut stream, &mut tokio::io::sink()).await;
                        }
                    }
                });
            }
        });
        Self { port, seen }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// The API base, under `/prometheus` as a Mimir gateway serves it.
    fn url(&self, scheme: &str) -> String {
        format!("{scheme}://{}/prometheus", self.host())
    }
}

async fn serve(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    seen: Arc<Mutex<Vec<Seen>>>,
    reply: Reply,
) {
    let service = service_fn(move |request: Request<Incoming>| {
        let request = Seen::of(&request);
        let response = reply(&request);
        seen.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request);
        async move { Ok::<_, Infallible>(response) }
    });
    let _ = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await;
}

fn answer(status: u16, body: impl Into<String>) -> Response<String> {
    let mut response = Response::new(body.into());
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response
}

/// One sample for every query, so every metric has a series.
fn samples(_: &Seen) -> Response<String> {
    let data = json!({
        "status": "success",
        "data": {
            "resultType": "matrix",
            "result": [{ "metric": {}, "values": [[1_700_000_000, "1"]] }],
        },
    });
    answer(200, data.to_string())
}

/// A port nothing listens on.
async fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

/// A test CA, a server certificate for 127.0.0.1 and a client certificate, both signed by
/// the CA. The CA and the client's certificate and key are PEM files.
struct Pki {
    dir: TempDir,
    ca: CertificateDer<'static>,
    server: CertificateDer<'static>,
    server_key: PrivatePkcs8KeyDer<'static>,
}

/// Valid from yesterday for 30 days: some systems refuse a server certificate valid for
/// years.
fn valid_now(params: &mut CertificateParams) {
    let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let now = rcgen::date_time_ymd(1970, 1, 1) + since_epoch;
    params.not_before = now - Duration::from_secs(86_400);
    params.not_after = now + Duration::from_secs(30 * 86_400);
}

/// Valid for 30 days, until yesterday.
fn expired(params: &mut CertificateParams) {
    let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let now = rcgen::date_time_ymd(1970, 1, 1) + since_epoch;
    params.not_before = now - Duration::from_secs(31 * 86_400);
    params.not_after = now - Duration::from_secs(86_400);
}

impl Pki {
    fn new() -> Self {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.distinguished_name
            .push(DnType::CommonName, "SkoposIDE test CA");
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        valid_now(&mut ca);
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let issuer = Issuer::new(ca, ca_key);

        let leaf =
            |name: &str, usage: ExtendedKeyUsagePurpose, validity: fn(&mut CertificateParams)| {
                let key = KeyPair::generate().unwrap();
                let mut params = CertificateParams::new(vec![name.to_owned()]).unwrap();
                params.distinguished_name.push(DnType::CommonName, name);
                params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
                params.extended_key_usages = vec![usage];
                validity(&mut params);
                (params.signed_by(&key, &issuer).unwrap(), key)
            };
        let (server, server_key) =
            leaf("127.0.0.1", ExtendedKeyUsagePurpose::ServerAuth, valid_now);
        let (client, client_key) = leaf(
            "metrics-client",
            ExtendedKeyUsagePurpose::ClientAuth,
            valid_now,
        );
        let (old, old_key) = leaf(
            "metrics-client",
            ExtendedKeyUsagePurpose::ClientAuth,
            expired,
        );

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ca.pem"), ca_cert.pem()).unwrap();
        std::fs::write(dir.path().join("client.pem"), client.pem()).unwrap();
        std::fs::write(dir.path().join("client.key"), client_key.serialize_pem()).unwrap();
        std::fs::write(dir.path().join("expired.pem"), old.pem()).unwrap();
        std::fs::write(dir.path().join("expired.key"), old_key.serialize_pem()).unwrap();
        Self {
            dir,
            ca: ca_cert.der().clone(),
            server: server.der().clone(),
            server_key: PrivatePkcs8KeyDer::from(server_key.serialize_der()),
        }
    }

    fn path(&self, name: &str) -> String {
        self.dir.path().join(name).to_str().unwrap().to_owned()
    }

    fn mtls(&self) -> RemoteAuth {
        RemoteAuth::Mtls {
            cert_path: self.path("client.pem"),
            key_path: self.path("client.key"),
        }
    }

    /// The same client with a certificate from the same CA that expired yesterday.
    fn expired_mtls(&self) -> RemoteAuth {
        RemoteAuth::Mtls {
            cert_path: self.path("expired.pem"),
            key_path: self.path("expired.key"),
        }
    }

    /// The server's TLS, asking for a client certificate from the CA or not.
    fn server_config(&self, client_certificate: bool) -> Arc<ServerConfig> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let builder = ServerConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .unwrap();
        let builder = if client_certificate {
            let mut roots = RootCertStore::empty();
            roots.add(self.ca.clone()).unwrap();
            let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .unwrap();
            builder.with_client_cert_verifier(verifier)
        } else {
            builder.with_no_client_auth()
        };
        let key = PrivateKeyDer::Pkcs8(self.server_key.clone_key());
        Arc::new(
            builder
                .with_single_cert(vec![self.server.clone()], key)
                .unwrap(),
        )
    }
}

fn remote(url: &str, auth: RemoteAuth, ca_path: Option<String>) -> MetricsProviderSetting {
    MetricsProviderSetting::Remote {
        url: url.to_owned(),
        tenant: Some(TENANT.to_owned()),
        matcher: None,
        auth,
        ca_path,
    }
}

fn basic() -> RemoteAuth {
    RemoteAuth::Basic {
        username: "me".to_owned(),
    }
}

fn save(core: &AppCore, id: &ClusterId, setting: MetricsProviderSetting) -> CoreResult<()> {
    let mut settings = core.cluster_settings_get(id);
    settings.metrics_provider = setting;
    core.cluster_settings_set(id, settings)
}

async fn query(core: &AppCore, id: &ClusterId) -> CoreResult<MetricsResult> {
    core.metrics_query(id, &MetricsTarget::Cluster, MetricsRange::OneHour)
        .await
}

#[tokio::test]
async fn none_basic_and_bearer_send_exactly_their_headers_and_the_tenant() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let server = Server::start(None, samples).await;
    let url = server.url("http");

    save(&core, &id, remote(&url, RemoteAuth::Anonymous, None)).unwrap();
    // A pinned URL is used as it is: naming the provider asks the server nothing (I43).
    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        MetricsProvider::Remote {
            host: server.host(),
            tenant: Some(TENANT.to_owned()),
            matcher: None,
            chosen_by: RemoteChoice::Setting,
        }
    );
    assert!(server.seen().is_empty());

    let cases = [
        (RemoteAuth::Anonymous, None, Vec::new()),
        (
            basic(),
            Some("pa:ss wörd"),
            vec![format!("Basic {}", STANDARD.encode("me:pa:ss wörd"))],
        ),
        (
            RemoteAuth::Bearer,
            Some("tok-123"),
            vec!["Bearer tok-123".to_owned()],
        ),
    ];
    for (auth, secret, authorization) in cases {
        if let Some(secret) = secret {
            core.metrics_secret_set(&id, Secret::new(secret)).unwrap();
        }
        save(&core, &id, remote(&url, auth.clone(), None)).unwrap();
        let before = server.seen().len();
        let result = query(&core, &id).await.unwrap();
        assert!(
            result.series.contains_key(&MetricName::CpuUsage),
            "{auth:?}"
        );
        let seen = server.seen().split_off(before);
        assert!(!seen.is_empty(), "{auth:?}");
        for request in seen {
            assert_eq!(request.path, "/prometheus/api/v1/query_range");
            assert_eq!(request.authorization, authorization, "{auth:?}");
            assert_eq!(request.tenant, [TENANT], "{auth:?}");
        }
    }
}

#[tokio::test]
async fn a_server_that_asks_for_a_client_certificate_accepts_the_configured_one() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let pki = Pki::new();
    let server = Server::start(Some(pki.server_config(true)), samples).await;
    let url = server.url("https");
    let ca = Some(pki.path("ca.pem"));

    save(&core, &id, remote(&url, RemoteAuth::Anonymous, ca.clone())).unwrap();
    let err = query(&core, &id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unauthorized, "{err:?}");
    assert_eq!(
        err.message,
        format!("{} asks for a client certificate.", server.host())
    );
    assert!(server.seen().is_empty());

    save(&core, &id, remote(&url, pki.mtls(), ca)).unwrap();
    let result = query(&core, &id).await.unwrap();
    assert!(result.series.contains_key(&MetricName::CpuUsage));
    assert!(server
        .seen()
        .iter()
        .all(|request| request.authorization.is_empty()));
}

#[tokio::test]
async fn a_server_certificate_from_the_test_ca_needs_its_ca_file() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let pki = Pki::new();
    let server = Server::start(Some(pki.server_config(false)), samples).await;
    let url = server.url("https");

    save(&core, &id, remote(&url, RemoteAuth::Anonymous, None)).unwrap();
    let err = query(&core, &id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable, "{err:?}");
    assert_eq!(
        err.message,
        format!(
            "The certificate of {} is not trusted: add its CA file in the cluster settings.",
            server.host()
        )
    );

    save(
        &core,
        &id,
        remote(&url, RemoteAuth::Anonymous, Some(pki.path("ca.pem"))),
    )
    .unwrap();
    let result = query(&core, &id).await.unwrap();
    assert!(result.series.contains_key(&MetricName::CpuUsage));
}

#[tokio::test]
async fn basic_over_plain_http_is_refused_at_save_except_to_this_machine() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    core.metrics_secret_set(&id, Secret::new("pw")).unwrap();
    let err = save(
        &core,
        &id,
        remote("http://mimir.example.com/prometheus", basic(), None),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(
        err.message,
        "Basic and Bearer credentials need https://, except to localhost."
    );

    let server = Server::start(None, samples).await;
    save(&core, &id, remote(&server.url("http"), basic(), None)).unwrap();
    query(&core, &id).await.unwrap();
    let expected = format!("Basic {}", STANDARD.encode("me:pw"));
    assert!(server
        .seen()
        .iter()
        .all(|request| request.authorization == [expected.as_str()]));
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    core.metrics_secret_set(&id, Secret::new("tok-123"))
        .unwrap();
    let server = Server::start(None, |request| {
        if request.path.starts_with("/elsewhere") {
            return samples(request);
        }
        let mut moved = answer(302, "");
        moved.headers_mut().insert(
            LOCATION,
            HeaderValue::from_static("/elsewhere/api/v1/query_range"),
        );
        moved
    })
    .await;
    save(
        &core,
        &id,
        remote(&server.url("http"), RemoteAuth::Bearer, None),
    )
    .unwrap();

    let err = query(&core, &id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
    assert_eq!(
        err.message,
        format!(
            "{} answered with a redirect to /elsewhere/api/v1/query_range; set the URL it points to.",
            server.host()
        )
    );
    let seen = server.seen();
    assert!(!seen.is_empty());
    assert!(seen
        .iter()
        .all(|request| request.path.starts_with("/prometheus/")));
}

#[tokio::test]
async fn http_refusals_name_the_host_and_keep_prometheus_errors() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let bad_query = r#"{"status":"error","errorType":"bad_data","error":"parse error at char 5"}"#;
    let cases = [
        (401, "no org id\n", ErrorCode::Unauthorized),
        (401, "invalid credentials", ErrorCode::Unauthorized),
        (403, "forbidden", ErrorCode::Forbidden),
        (404, "404 page not found", ErrorCode::NotFound),
        (400, bad_query, ErrorCode::Internal),
    ];
    for (status, body, code) in cases {
        let server = Server::start(None, move |_| answer(status, body)).await;
        let url = server.url("http");
        save(&core, &id, remote(&url, RemoteAuth::Anonymous, None)).unwrap();
        let err = query(&core, &id).await.unwrap_err();
        let host = server.host();
        let message = match (status, body) {
            (401, "no org id\n") => {
                "Mimir needs a tenant: set Tenant in this cluster's metrics settings.".to_owned()
            }
            (401 | 403, _) => format!("{host} refused the credentials (HTTP {status})."),
            (404, _) => format!("{host} has no Prometheus API at {url}: check the path."),
            _ => "parse error at char 5".to_owned(),
        };
        assert_eq!((err.code, err.message), (code, message), "{status} {body}");
    }
}

#[tokio::test]
async fn a_server_that_cannot_be_reached_is_named_with_the_reason() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let limits = MetricsLimits {
        query: Duration::from_millis(300),
        ..MetricsLimits::default()
    };
    core.set_metrics_limits_for_test(limits);
    let reach = |port: u16| {
        let setting = remote(
            &format!("http://127.0.0.1:{port}/prometheus"),
            RemoteAuth::Anonymous,
            None,
        );
        save(&core, &id, setting).unwrap();
        query(&core, &id)
    };

    let refused = closed_port().await;
    let err = reach(refused).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
    let prefix = format!("Cannot reach 127.0.0.1:{refused}: ");
    assert!(
        err.message.starts_with(&prefix) && err.message.len() > prefix.len() + 1,
        "{}",
        err.message
    );

    // Accepts, then closes without answering.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closing = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            drop(stream);
        }
    });
    let err = reach(closing).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
    assert!(
        err.message
            .starts_with(&format!("Cannot reach 127.0.0.1:{closing}: ")),
        "{}",
        err.message
    );

    // Accepts, then never answers.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let silent = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut open = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            open.push(stream);
        }
    });
    let err = reach(silent).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
    assert_eq!(
        err.message,
        format!("Cannot reach 127.0.0.1:{silent}: no answer within 300ms.")
    );
}

#[tokio::test]
async fn basic_and_bearer_without_a_saved_secret_ask_for_it() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let server = Server::start(None, samples).await;
    for auth in [basic(), RemoteAuth::Bearer] {
        save(&core, &id, remote(&server.url("http"), auth, None)).unwrap();
        let err = query(&core, &id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(
            err.message,
            "No password (or token) is saved for this cluster: enter it in the cluster settings."
        );
    }
    assert!(server.seen().is_empty());
}

#[tokio::test]
async fn switching_to_no_authentication_deletes_the_secret() {
    let store = Arc::new(MemorySecretStore::default());
    let (core, _fake, id, _root) =
        connected_fake_with(FakeKubeConfig::default(), store.clone()).await;
    let url = "https://mimir.example.com/prometheus";
    core.metrics_secret_set(&id, Secret::new("pw")).unwrap();
    save(&core, &id, remote(url, basic(), None)).unwrap();
    assert_eq!(store.get(&id).unwrap(), Some(Secret::new("pw")));

    save(&core, &id, remote(url, RemoteAuth::Anonymous, None)).unwrap();
    assert_eq!(store.get(&id).unwrap(), None);
    assert!(!core.metrics_secret_saved(&id).unwrap());
}

/// A Linux desktop without Secret Service.
struct NoKeychain;

impl SecretStore for NoKeychain {
    fn get(&self, _: &ClusterId) -> CoreResult<Option<Secret>> {
        Err(keychain_unavailable("no Secret Service"))
    }

    fn set(&self, _: &ClusterId, _: &Secret) -> CoreResult<()> {
        Err(keychain_unavailable("no Secret Service"))
    }

    fn delete(&self, _: &ClusterId) -> CoreResult<()> {
        Err(keychain_unavailable("no Secret Service"))
    }
}

#[tokio::test]
async fn a_query_that_needs_the_secret_says_the_keychain_is_missing() {
    let (core, _fake, id, _root) =
        connected_fake_with(FakeKubeConfig::default(), Arc::new(NoKeychain)).await;
    let server = Server::start(None, samples).await;
    save(
        &core,
        &id,
        remote(&server.url("http"), RemoteAuth::Bearer, None),
    )
    .unwrap();
    let err = query(&core, &id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
    assert_eq!(
        err.message,
        "The system keychain is not available (no Secret Service). Use a client certificate or no authentication."
    );
    assert!(server.seen().is_empty());
}

/// Review Focus 1: a password keeps its spaces; a token with a line break is never sent.
#[tokio::test]
async fn a_password_is_sent_as_typed_and_a_token_with_a_line_break_never_leaves() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let server = Server::start(None, samples).await;
    let url = server.url("http");

    core.metrics_secret_set(&id, Secret::new(" pa ss \t"))
        .unwrap();
    save(&core, &id, remote(&url, basic(), None)).unwrap();
    query(&core, &id).await.unwrap();
    let expected = format!("Basic {}", STANDARD.encode("me: pa ss \t"));
    let seen = server.seen();
    assert!(!seen.is_empty());
    assert!(seen
        .iter()
        .all(|request| request.authorization == [expected.as_str()]));

    core.metrics_secret_set(&id, Secret::new("tok-123\n"))
        .unwrap();
    save(&core, &id, remote(&url, RemoteAuth::Bearer, None)).unwrap();
    let err = query(&core, &id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(
        err.message,
        "The token holds characters an HTTP header cannot carry."
    );
    assert!(!err.message.contains("tok-123"));
    assert_eq!(server.seen().len(), seen.len());
}

/// Review Focus 4: the save takes an expired client certificate (I35 reads PEM, not dates);
/// the server's TLS alert then refuses it before any HTTP request.
#[tokio::test]
async fn an_expired_client_certificate_is_refused_before_any_request() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let pki = Pki::new();
    let server = Server::start(Some(pki.server_config(true)), samples).await;
    let ca = Some(pki.path("ca.pem"));

    save(
        &core,
        &id,
        remote(&server.url("https"), pki.expired_mtls(), ca),
    )
    .unwrap();
    let err = query(&core, &id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable, "{err:?}");
    let prefix = format!("Cannot reach {}: ", server.host());
    assert!(
        err.message.starts_with(&prefix) && err.message.len() > prefix.len() + 1,
        "{}",
        err.message
    );
    assert!(server.seen().is_empty());
}
