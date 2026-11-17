//! Prometheus requests and answers (spec §5.4, I37), and the two transports that carry them:
//! the API server's service proxy, with no port-forward and the user's own rights on
//! `services/proxy`, and a URL reached directly.

use std::collections::BTreeMap;
use std::time::Duration;

use http::{header, Method, Request, StatusCode};
use kube::client::Body;
use kube::Client;
use serde_json::Value;

use super::remote::Remote;
use super::templates::{up_query, Window};
use super::{LabelMatcher, PrometheusScheme};
use crate::error::{CoreResult, ErrorCode, IpcError};

/// A query string up to this many bytes goes as GET; a longer one as a form POST.
pub(crate) const GET_LIMIT: usize = 8 * 1024;
/// The header Mimir, Cortex and other multi-tenant APIs read the tenant from (spec I8).
pub(crate) const TENANT_HEADER: &str = "X-Scope-OrgID";
/// What Mimir answers, with HTTP 401, to a request that names no tenant.
const NO_TENANT_BODY: &str = "no org id";
const NO_TENANT_MESSAGE: &str =
    "Mimir needs a tenant: set Tenant in this cluster's metrics settings.";

/// A Prometheus Service port, reached through the API server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Endpoint {
    pub(crate) namespace: String,
    pub(crate) service: String,
    pub(crate) port: u16,
    pub(crate) scheme: Option<PrometheusScheme>,
    pub(crate) path_prefix: Option<String>,
    /// Sent as [`TENANT_HEADER`] with every request. A detected Service has none.
    pub(crate) tenant: Option<String>,
    /// Added to every selector of every query. A detected Service has none.
    pub(crate) matcher: Option<LabelMatcher>,
}

impl Endpoint {
    /// The proxy path of a Prometheus API such as `/api/v1/query_range`.
    pub(crate) fn path(&self, api: &str) -> String {
        let scheme = match self.scheme {
            None => "",
            Some(PrometheusScheme::Http) => "http:",
            Some(PrometheusScheme::Https) => "https:",
        };
        format!(
            "/api/v1/namespaces/{}/services/{scheme}{}:{}/proxy{}{api}",
            self.namespace,
            self.service,
            self.port,
            self.path_prefix.as_deref().unwrap_or("")
        )
    }
}

/// Where a Prometheus API is, as its requests need it: a Service behind the API server, or a
/// URL (spec I37).
pub(crate) trait Target: Sync {
    /// Where `api`, such as `/api/v1/query`, is: a proxy path or a URL.
    fn url(&self, api: &str) -> String;
    /// Sent as [`TENANT_HEADER`] with every request.
    fn tenant(&self) -> Option<&str>;
    /// Added to every selector of every query.
    fn matcher(&self) -> Option<&LabelMatcher>;
}

impl Target for Endpoint {
    fn url(&self, api: &str) -> String {
        self.path(api)
    }

    fn tenant(&self) -> Option<&str> {
        self.tenant.as_deref()
    }

    fn matcher(&self) -> Option<&LabelMatcher> {
        self.matcher.as_ref()
    }
}

/// How requests reach Prometheus (spec I37). Both transports send the same requests and read
/// the answers alike; they differ in how they send and in the words of a refusal.
#[derive(Clone, Copy)]
pub(crate) enum Transport<'a> {
    /// A Service through the API server's service proxy.
    ServiceProxy {
        client: &'a Client,
        endpoint: &'a Endpoint,
    },
    /// A URL reached directly (spec §9).
    Remote(&'a Remote),
}

impl Transport<'_> {
    fn target(&self) -> &dyn Target {
        match self {
            Self::ServiceProxy { endpoint, .. } => *endpoint,
            Self::Remote(remote) => remote.endpoint(),
        }
    }

    pub(crate) fn matcher(&self) -> Option<&LabelMatcher> {
        self.target().matcher()
    }

    /// One request, without retry, given up after `limit`. Returns Prometheus's `data`.
    async fn call(&self, request: Request<Vec<u8>>, limit: Duration) -> CoreResult<Value> {
        match self {
            Self::ServiceProxy { client, endpoint } => {
                proxy_call(client, endpoint, request, limit).await
            }
            Self::Remote(remote) => remote.call(request, limit).await,
        }
    }

    /// Whether Prometheus answers: `/api/v1/query?query=up`.
    pub(crate) async fn probe(&self, limit: Duration) -> CoreResult<()> {
        let data = self.call(probe_request(self.target())?, limit).await?;
        if data["resultType"].is_string() {
            Ok(())
        } else {
            Err(IpcError::new(
                ErrorCode::Internal,
                "the service answered, but not like Prometheus",
            ))
        }
    }

    /// One range query over `window`.
    pub(crate) async fn query_range(
        &self,
        query: &str,
        window: Window,
        limit: Duration,
    ) -> CoreResult<Vec<(f64, f64)>> {
        let request = range_request(self.target(), query, window)?;
        matrix_points(&self.call(request, limit).await?)
    }
}

/// A GET when the encoded parameters fit in [`GET_LIMIT`], a form POST otherwise, carrying
/// the tenant header when the target has a tenant.
pub(crate) fn build_request(
    target: &dyn Target,
    api: &str,
    params: &[(&str, String)],
) -> CoreResult<Request<Vec<u8>>> {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(key, value)| (*key, value.as_str())))
        .finish();
    let path = target.url(api);
    let (mut builder, body) = if encoded.len() <= GET_LIMIT {
        (Request::get(format!("{path}?{encoded}")), Vec::new())
    } else {
        (
            Request::post(path).header(header::CONTENT_TYPE, "application/x-www-form-urlencoded"),
            encoded.into_bytes(),
        )
    };
    if let Some(tenant) = target.tenant() {
        builder = builder.header(TENANT_HEADER, tenant);
    }
    builder.body(body).map_err(|e| {
        IpcError::new(
            ErrorCode::Internal,
            format!("could not build the Prometheus request: {e}"),
        )
    })
}

/// The detection probe: `/api/v1/query` for `up`, with the cluster label when there is one
/// (spec I15).
fn probe_request(target: &dyn Target) -> CoreResult<Request<Vec<u8>>> {
    build_request(
        target,
        "/api/v1/query",
        &[("query", up_query(target.matcher()))],
    )
}

/// One range query over `window`.
fn range_request(target: &dyn Target, query: &str, window: Window) -> CoreResult<Request<Vec<u8>>> {
    build_request(
        target,
        "/api/v1/query_range",
        &[
            ("query", query.to_owned()),
            ("start", window.start.to_string()),
            ("end", window.end.to_string()),
            ("step", window.step.to_string()),
        ],
    )
}

/// One request through the service proxy, without retry, given up after `limit`.
async fn proxy_call(
    client: &Client,
    endpoint: &Endpoint,
    request: Request<Vec<u8>>,
    limit: Duration,
) -> CoreResult<Value> {
    let verb = if request.method() == Method::GET {
        "get"
    } else {
        "create"
    };
    let exchange = async {
        let response = client.send(request.map(Body::from)).await?;
        let status = response.status();
        let body = response.into_body().collect_bytes().await?;
        Ok::<_, kube::Error>((status, body))
    };
    let (status, body) = tokio::time::timeout(limit, exchange).await.map_err(|_| {
        IpcError::new(
            ErrorCode::Unreachable,
            format!("Prometheus did not answer within {limit:?}"),
        )
    })??;
    answer(status, &body, |status, message| {
        proxy_refusal(endpoint, verb, status, message)
    })
}

/// How the service proxy words a 401, 403 or 404.
fn proxy_refusal(endpoint: &Endpoint, verb: &str, status: StatusCode, message: String) -> IpcError {
    match status {
        StatusCode::FORBIDDEN => IpcError::new(
            ErrorCode::Forbidden,
            format!(
                "Reading Prometheus needs permission to {verb} services/proxy in namespace {}: {message}",
                endpoint.namespace
            ),
        ),
        StatusCode::UNAUTHORIZED => IpcError::new(ErrorCode::Unauthorized, message),
        _ => IpcError::new(ErrorCode::NotFound, message),
    }
}

/// Prometheus's `data` from a successful answer, or the contract's error for any other.
/// `refusal` words a 401 (other than Mimir's missing tenant), a 403 or a 404 for the
/// transport, given the status and the answer's own message.
pub(crate) fn answer(
    status: StatusCode,
    body: &[u8],
    refusal: impl FnOnce(StatusCode, String) -> IpcError,
) -> CoreResult<Value> {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    if status.is_success() {
        let Some(parsed) = parsed else {
            return Err(IpcError::new(
                ErrorCode::Internal,
                "Prometheus answered with something that is not JSON",
            ));
        };
        if parsed["status"] == "success" {
            return Ok(parsed["data"].clone());
        }
        return Err(IpcError::new(
            ErrorCode::Internal,
            format!(
                "Prometheus refused the query: {}",
                parsed["error"].as_str().unwrap_or("no reason given")
            ),
        ));
    }
    let code = status.as_u16();
    // A Status from the API server, an error from Prometheus, or the proxy's plain text.
    let message = parsed
        .as_ref()
        .and_then(|v| v["message"].as_str().or(v["error"].as_str()))
        .map(str::to_owned)
        .or_else(|| {
            let text = String::from_utf8_lossy(body).trim().to_owned();
            (!text.is_empty()).then_some(text)
        })
        .unwrap_or_else(|| format!("HTTP {code}"));
    let error = match code {
        // Mimir with multi-tenancy on, asked without a tenant (spec I10).
        401 if String::from_utf8_lossy(body).trim() == NO_TENANT_BODY => {
            IpcError::new(ErrorCode::Unauthorized, NO_TENANT_MESSAGE)
        }
        401 | 403 | 404 => refusal(status, message),
        408 | 429 | 502 | 503 | 504 => IpcError::new(ErrorCode::Unreachable, message),
        _ => IpcError::new(ErrorCode::Internal, message),
    };
    Err(error.with_details(format!("HTTP {code}")))
}

/// The points of a range answer, `[unix seconds, value]`, summed over its series. Values that
/// are not finite numbers are dropped.
fn matrix_points(data: &Value) -> CoreResult<Vec<(f64, f64)>> {
    if data["resultType"] != "matrix" {
        return Err(IpcError::new(
            ErrorCode::Internal,
            format!(
                "Prometheus answered a range query with {}",
                data["resultType"]
            ),
        ));
    }
    // Keyed by milliseconds, so equal times from different series meet.
    let mut sums: BTreeMap<i64, f64> = BTreeMap::new();
    for series in data["result"].as_array().into_iter().flatten() {
        for point in series["values"].as_array().into_iter().flatten() {
            let time = point[0].as_f64();
            let value = point[1].as_str().and_then(|v| v.parse::<f64>().ok());
            let (Some(time), Some(value)) = (time, value) else {
                continue;
            };
            if !time.is_finite() || !value.is_finite() {
                continue;
            }
            *sums.entry((time * 1000.0).round() as i64).or_insert(0.0) += value;
        }
    }
    Ok(sums
        .into_iter()
        .map(|(millis, value)| (millis as f64 / 1000.0, value))
        .collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn endpoint() -> Endpoint {
        Endpoint {
            namespace: "monitoring".to_owned(),
            service: "prom".to_owned(),
            port: 9090,
            scheme: None,
            path_prefix: None,
            tenant: None,
            matcher: None,
        }
    }

    fn fail(code: u16, body: &str, verb: &str) -> IpcError {
        answer(
            StatusCode::from_u16(code).unwrap(),
            body.as_bytes(),
            |status, message| proxy_refusal(&endpoint(), verb, status, message),
        )
        .unwrap_err()
    }

    #[test]
    fn proxy_paths_name_the_scheme_port_and_prefix() {
        assert_eq!(
            endpoint().path("/api/v1/query"),
            "/api/v1/namespaces/monitoring/services/prom:9090/proxy/api/v1/query"
        );
        let behind_a_prefix = Endpoint {
            scheme: Some(PrometheusScheme::Https),
            path_prefix: Some("/prom".to_owned()),
            ..endpoint()
        };
        assert_eq!(
            behind_a_prefix.path("/api/v1/query_range"),
            "/api/v1/namespaces/monitoring/services/https:prom:9090/proxy/prom/api/v1/query_range"
        );
    }

    #[test]
    fn a_query_string_up_to_8_kib_is_a_get_and_a_longer_one_a_form_post() {
        let at_limit = "a".repeat(GET_LIMIT - "query=".len());
        let get =
            build_request(&endpoint(), "/api/v1/query", &[("query", at_limit.clone())]).unwrap();
        assert_eq!(*get.method(), Method::GET);
        assert_eq!(get.uri().query().map(str::len), Some(GET_LIMIT));
        assert!(get.body().is_empty());

        let over = format!("{at_limit}a");
        let post = build_request(&endpoint(), "/api/v1/query", &[("query", over.clone())]).unwrap();
        assert_eq!(*post.method(), Method::POST);
        assert_eq!(
            post.uri().path(),
            "/api/v1/namespaces/monitoring/services/prom:9090/proxy/api/v1/query"
        );
        assert_eq!(post.uri().query(), None);
        assert_eq!(
            post.headers()[header::CONTENT_TYPE],
            "application/x-www-form-urlencoded"
        );
        assert_eq!(post.body().as_slice(), format!("query={over}").as_bytes());
    }

    #[test]
    fn parameters_are_form_encoded() {
        let request = build_request(
            &endpoint(),
            "/api/v1/query",
            &[
                ("query", r#"sum(x{a="b c"})"#.to_owned()),
                ("step", "60".to_owned()),
            ],
        )
        .unwrap();
        assert_eq!(
            request.uri().query(),
            Some("query=sum%28x%7Ba%3D%22b+c%22%7D%29&step=60")
        );
    }

    #[test]
    fn answers_become_data_or_contract_errors() {
        let ok = json!({ "status": "success", "data": { "resultType": "vector", "result": [] } });
        assert_eq!(
            answer(StatusCode::OK, ok.to_string().as_bytes(), |_, _| {
                unreachable!("a success is no refusal")
            })
            .unwrap(),
            ok["data"]
        );

        let status = json!({
            "kind": "Status",
            "code": 403,
            "message": "services \"prom\" is forbidden",
        });
        let forbidden = fail(403, &status.to_string(), "create");
        assert_eq!(forbidden.code, ErrorCode::Forbidden);
        assert!(
            forbidden
                .message
                .starts_with("Reading Prometheus needs permission to create services/proxy in namespace monitoring: "),
            "{}",
            forbidden.message
        );
        assert!(forbidden
            .message
            .ends_with(r#"services "prom" is forbidden"#));
        assert_eq!(forbidden.details.as_deref(), Some("HTTP 403"));

        let bad_query = fail(
            400,
            r#"{"status":"error","errorType":"bad_data","error":"parse error at char 5"}"#,
            "get",
        );
        assert_eq!(bad_query.code, ErrorCode::Internal);
        assert_eq!(bad_query.message, "parse error at char 5");

        let no_endpoints = fail(503, "no endpoints available for service \"prom\"\n", "get");
        assert_eq!(no_endpoints.code, ErrorCode::Unreachable);
        assert_eq!(
            no_endpoints.message,
            r#"no endpoints available for service "prom""#
        );

        let gone = fail(404, "", "get");
        assert_eq!(gone.code, ErrorCode::NotFound);
        assert_eq!(gone.message, "HTTP 404");
        assert_eq!(fail(401, "", "get").code, ErrorCode::Unauthorized);
        assert_eq!(fail(504, "", "get").code, ErrorCode::Unreachable);
        assert_eq!(fail(500, "", "get").code, ErrorCode::Internal);

        let refused = fail(
            200,
            r#"{"status":"error","error":"query timed out"}"#,
            "get",
        );
        assert_eq!(refused.code, ErrorCode::Internal);
        assert!(
            refused.message.contains("query timed out"),
            "{}",
            refused.message
        );
        assert_eq!(fail(200, "<html></html>", "get").code, ErrorCode::Internal);
    }

    #[test]
    fn range_answers_sum_their_series_and_drop_values_that_are_not_finite() {
        let data = json!({
            "resultType": "matrix",
            "result": [
                { "metric": { "instance": "a" }, "values": [[60, "1.5"], [120, "NaN"], [180, "2"]] },
                { "metric": { "instance": "b" }, "values": [[60, "0.5"], [120, "+Inf"], [180.0, "x"]] },
            ],
        });
        assert_eq!(matrix_points(&data).unwrap(), [(60.0, 2.0), (180.0, 2.0)]);
        let empty = json!({ "resultType": "matrix", "result": [] });
        assert!(matrix_points(&empty).unwrap().is_empty());
    }

    #[test]
    fn an_instant_answer_is_not_a_range() {
        let err = matrix_points(&json!({ "resultType": "vector", "result": [] })).unwrap_err();
        assert_eq!(err.code, ErrorCode::Internal);
    }

    #[test]
    fn a_tenant_goes_in_the_header_of_the_probe_and_of_get_and_post_queries() {
        let window = Window {
            start: 0,
            end: 3_600,
            step: 60,
        };
        let long = "a".repeat(GET_LIMIT);
        let built = |endpoint: &Endpoint| {
            vec![
                probe_request(endpoint).unwrap(),
                range_request(endpoint, "up", window).unwrap(),
                range_request(endpoint, &long, window).unwrap(),
            ]
        };
        let tenant = Endpoint {
            tenant: Some("team-a".to_owned()),
            ..endpoint()
        };
        let with = built(&tenant);
        assert_eq!(
            with.iter().map(|r| r.method().clone()).collect::<Vec<_>>(),
            [Method::GET, Method::GET, Method::POST]
        );
        for request in &with {
            let values: Vec<&str> = request
                .headers()
                .get_all(TENANT_HEADER)
                .iter()
                .map(|value| value.to_str().unwrap())
                .collect();
            assert_eq!(values, ["team-a"], "{request:?}");
        }
        for request in built(&endpoint()) {
            assert!(
                request.headers().get(TENANT_HEADER).is_none(),
                "{request:?}"
            );
        }
    }

    #[test]
    fn mimir_without_a_tenant_names_the_setting_and_another_401_keeps_its_text() {
        let no_tenant = fail(401, "no org id\n", "get");
        assert_eq!(no_tenant.code, ErrorCode::Unauthorized);
        assert_eq!(
            no_tenant.message,
            "Mimir needs a tenant: set Tenant in this cluster's metrics settings."
        );
        assert_eq!(no_tenant.details.as_deref(), Some("HTTP 401"));

        let other = fail(401, "invalid bearer token\n", "get");
        assert_eq!(other.code, ErrorCode::Unauthorized);
        assert_eq!(other.message, "invalid bearer token");
        let status = fail(
            401,
            r#"{"kind":"Status","code":401,"message":"Unauthorized"}"#,
            "get",
        );
        assert_eq!(status.message, "Unauthorized");
    }

    #[test]
    fn the_probe_asks_up_with_the_cluster_label() {
        let labelled = Endpoint {
            matcher: Some(LabelMatcher {
                name: "cluster".to_owned(),
                value: "prod".to_owned(),
            }),
            ..endpoint()
        };
        assert_eq!(
            probe_request(&labelled).unwrap().uri().query(),
            Some("query=up%7Bcluster%3D%22prod%22%7D")
        );
        assert_eq!(
            probe_request(&endpoint()).unwrap().uri().query(),
            Some("query=up")
        );
    }
}
