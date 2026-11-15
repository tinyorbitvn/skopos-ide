//! Prometheus through the API server's service proxy (spec §5.4): no port-forward, and the
//! user's own rights on `services/proxy`.

use std::collections::BTreeMap;
use std::time::Duration;

use http::{header, Method, Request, StatusCode};
use kube::client::Body;
use kube::Client;
use serde_json::Value;

use super::templates::Window;
use super::PrometheusScheme;
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

/// A GET when the encoded parameters fit in [`GET_LIMIT`], a form POST otherwise, carrying
/// the tenant header when the Endpoint has a tenant.
pub(crate) fn build_request(
    endpoint: &Endpoint,
    api: &str,
    params: &[(&str, String)],
) -> CoreResult<Request<Vec<u8>>> {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(key, value)| (*key, value.as_str())))
        .finish();
    let path = endpoint.path(api);
    let (mut builder, body) = if encoded.len() <= GET_LIMIT {
        (Request::get(format!("{path}?{encoded}")), Vec::new())
    } else {
        (
            Request::post(path).header(header::CONTENT_TYPE, "application/x-www-form-urlencoded"),
            encoded.into_bytes(),
        )
    };
    if let Some(tenant) = &endpoint.tenant {
        builder = builder.header(TENANT_HEADER, tenant.as_str());
    }
    builder.body(body).map_err(|e| {
        IpcError::new(
            ErrorCode::Internal,
            format!("could not build the Prometheus request: {e}"),
        )
    })
}

/// The detection probe: `/api/v1/query` for `up`.
fn probe_request(endpoint: &Endpoint) -> CoreResult<Request<Vec<u8>>> {
    build_request(endpoint, "/api/v1/query", &[("query", "up".to_owned())])
}

/// One range query over `window`.
fn range_request(endpoint: &Endpoint, query: &str, window: Window) -> CoreResult<Request<Vec<u8>>> {
    build_request(
        endpoint,
        "/api/v1/query_range",
        &[
            ("query", query.to_owned()),
            ("start", window.start.to_string()),
            ("end", window.end.to_string()),
            ("step", window.step.to_string()),
        ],
    )
}

/// One request, without retry, given up after `limit`. Returns Prometheus's `data`.
async fn call(
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
    answer(status, &body, endpoint, verb)
}

/// Prometheus's `data` from a successful answer, or the contract's error for any other.
fn answer(status: StatusCode, body: &[u8], endpoint: &Endpoint, verb: &str) -> CoreResult<Value> {
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
        403 => IpcError::new(
            ErrorCode::Forbidden,
            format!(
                "Reading Prometheus needs permission to {verb} services/proxy in namespace {}: {message}",
                endpoint.namespace
            ),
        ),
        // Mimir with multi-tenancy on, asked without a tenant (spec I10).
        401 if String::from_utf8_lossy(body).trim() == NO_TENANT_BODY => {
            IpcError::new(ErrorCode::Unauthorized, NO_TENANT_MESSAGE)
        }
        401 => IpcError::new(ErrorCode::Unauthorized, message),
        404 => IpcError::new(ErrorCode::NotFound, message),
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

/// Whether `endpoint` answers like Prometheus: `/api/v1/query?query=up`.
pub(crate) async fn probe(client: &Client, endpoint: &Endpoint, limit: Duration) -> CoreResult<()> {
    let data = call(client, endpoint, probe_request(endpoint)?, limit).await?;
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
    client: &Client,
    endpoint: &Endpoint,
    query: &str,
    window: Window,
    limit: Duration,
) -> CoreResult<Vec<(f64, f64)>> {
    let data = call(
        client,
        endpoint,
        range_request(endpoint, query, window)?,
        limit,
    )
    .await?;
    matrix_points(&data)
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
        }
    }

    fn fail(code: u16, body: &str, verb: &str) -> IpcError {
        answer(
            StatusCode::from_u16(code).unwrap(),
            body.as_bytes(),
            &endpoint(),
            verb,
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
            answer(
                StatusCode::OK,
                ok.to_string().as_bytes(),
                &endpoint(),
                "get"
            )
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
}
