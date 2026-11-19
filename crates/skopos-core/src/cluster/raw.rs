//! A raw GET through the cluster's client, for endpoints that are not Kubernetes objects.

use http::{header, Request, StatusCode};
use kube::client::Body;
use kube::Client;

use crate::error::{CoreResult, ErrorCode, IpcError};

/// What the API server answered, whatever the status.
pub(crate) struct RawResponse {
    pub(crate) status: StatusCode,
    pub(crate) body: Vec<u8>,
    /// The `Date` header as sent, when it is text.
    pub(crate) date: Option<String>,
}

/// GETs `path` and gives the status, body and `Date` header. Only a failure to get an
/// answer at all is an error.
pub(crate) async fn get_raw(client: &Client, path: &str) -> CoreResult<RawResponse> {
    let request = Request::get(path)
        .body(Vec::new())
        .map_err(|err| IpcError::new(ErrorCode::Internal, err.to_string()))?;
    let response = client.send(request.map(Body::from)).await?;
    let status = response.status();
    let date = response
        .headers()
        .get(header::DATE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.into_body().collect_bytes().await?;
    Ok(RawResponse {
        status,
        body: body.to_vec(),
        date,
    })
}
