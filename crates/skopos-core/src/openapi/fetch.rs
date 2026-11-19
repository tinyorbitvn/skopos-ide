//! Reading `/openapi/v3` and one group version's document (spec L3, L4, L12, L13).

use std::collections::HashMap;

use http::{Request, StatusCode};
use kube::client::Body;
use kube::core::Status;
use kube::Client;
use serde_json::Value;

use crate::blocking::blocking;
use crate::error::{CoreResult, ErrorCode, IpcError};

/// Where the API server lists its OpenAPI v3 documents (spec L3).
pub(crate) const INDEX_PATH: &str = "/openapi/v3";

const NO_OPENAPI: &str = "This cluster does not publish OpenAPI v3, so API docs are not available.";
const FORBIDDEN: &str = "You may not read the cluster's API docs (/openapi/v3).";

/// `/openapi/v3`'s `paths`: each group version's document URL by its key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Index {
    urls: HashMap<String, String>,
}

impl Index {
    /// The `serverRelativeURL` of `api/v1` or `apis/‹group›/‹version›`.
    pub(crate) fn url(&self, key: &str) -> Option<&str> {
        self.urls.get(key).map(String::as_str)
    }
}

/// GETs `path` through the cluster's client and gives whatever came back (spec L12).
pub(crate) async fn get(client: &Client, path: &str) -> CoreResult<(StatusCode, Vec<u8>)> {
    let request = Request::get(path)
        .body(Vec::new())
        .map_err(|err| IpcError::new(ErrorCode::Internal, err.to_string()))?;
    let response = client.send(request.map(Body::from)).await?;
    let status = response.status();
    let body = response.into_body().collect_bytes().await?;
    Ok((status, body.to_vec()))
}

/// The index from `/openapi/v3`'s answer. A 404 there means no OpenAPI v3 at all (spec L13).
pub(crate) fn index_answer(
    status: StatusCode,
    body: &[u8],
    api_version: &str,
) -> CoreResult<Index> {
    if status == StatusCode::NOT_FOUND {
        return Err(IpcError::new(ErrorCode::NotFound, NO_OPENAPI).with_details("HTTP 404"));
    }
    if !status.is_success() {
        return Err(refused(status, body));
    }
    let answer: Value = serde_json::from_slice(body).map_err(|_| unreadable(api_version))?;
    let paths = answer
        .get("paths")
        .and_then(Value::as_object)
        .ok_or_else(|| unreadable(api_version))?;
    let urls = paths
        .iter()
        .filter_map(|(key, entry)| {
            let url = entry.get("serverRelativeURL")?.as_str()?;
            // Only a path on this API server, never another host.
            if url.starts_with('/') && !url.starts_with("//") {
                Some((key.clone(), url.to_owned()))
            } else {
                None
            }
        })
        .collect();
    Ok(Index { urls })
}

/// A group version's document, or `None` when it moved (a stale `?hash=` is redirected) or
/// went away: a miss, after which the index is read again (spec L6).
pub(crate) fn document_answer(
    status: StatusCode,
    body: &[u8],
    api_version: &str,
) -> CoreResult<Option<Value>> {
    if status == StatusCode::NOT_FOUND || status.is_redirection() {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(refused(status, body));
    }
    let document: Value = serde_json::from_slice(body).map_err(|_| unreadable(api_version))?;
    if !document
        .pointer("/components/schemas")
        .is_some_and(Value::is_object)
    {
        return Err(unreadable(api_version));
    }
    Ok(Some(document))
}

/// `index_answer` on a blocking thread: the answer can be megabytes of JSON.
pub(crate) async fn read_index(
    status: StatusCode,
    body: Vec<u8>,
    api_version: String,
) -> CoreResult<Index> {
    blocking(move || index_answer(status, &body, &api_version)).await
}

/// `document_answer` on a blocking thread: a group version's document can be megabytes.
pub(crate) async fn read_document(
    status: StatusCode,
    body: Vec<u8>,
    api_version: String,
) -> CoreResult<Option<Value>> {
    blocking(move || document_answer(status, &body, &api_version)).await
}

/// Any other refusal: 403 in the spec's words, the rest as every API error maps, 401 to
/// `Unauthorized` included (spec L13).
fn refused(status: StatusCode, body: &[u8]) -> IpcError {
    if status == StatusCode::FORBIDDEN {
        return IpcError::new(ErrorCode::Forbidden, FORBIDDEN).with_details("HTTP 403");
    }
    let code = status.as_u16();
    let mut answer: Status =
        serde_json::from_slice(body).unwrap_or_else(|_| Status::failure("", ""));
    if answer.message.is_empty() && answer.reason.is_empty() {
        let text = String::from_utf8_lossy(body).trim().to_owned();
        answer.message = if text.is_empty() {
            format!("HTTP {code}")
        } else {
            text
        };
    }
    IpcError::from(kube::Error::Api(answer.with_code(code).boxed()))
}

/// An index or a document that is not what OpenAPI v3 sends (spec L13).
fn unreadable(api_version: &str) -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        format!("The cluster's API docs for {api_version} could not be read."),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn bytes(value: Value) -> Vec<u8> {
        serde_json::to_vec(&value).unwrap()
    }

    #[tokio::test]
    async fn the_readers_answer_as_the_plain_functions_do() {
        let index = bytes(json!({ "paths": {
            "api/v1": { "serverRelativeURL": "/openapi/v3/api/v1?hash=AB" },
        } }));
        let read = read_index(StatusCode::OK, index.clone(), "v1".to_owned())
            .await
            .unwrap();
        assert_eq!(read, index_answer(StatusCode::OK, &index, "v1").unwrap());

        let document = json!({ "components": { "schemas": { "a": {} } } });
        assert_eq!(
            read_document(StatusCode::OK, bytes(document.clone()), "v1".to_owned())
                .await
                .unwrap(),
            Some(document)
        );
        assert_eq!(
            read_document(StatusCode::NOT_FOUND, Vec::new(), "v1".to_owned())
                .await
                .unwrap(),
            None
        );

        let error = read_document(StatusCode::OK, b"[".to_vec(), "apps/v1".to_owned())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(
            error.message,
            "The cluster's API docs for apps/v1 could not be read."
        );
        let forbidden = read_index(StatusCode::FORBIDDEN, Vec::new(), "v1".to_owned())
            .await
            .unwrap_err();
        assert_eq!(forbidden.code, ErrorCode::Forbidden);
    }

    fn status_body(code: u16, reason: &str, message: &str) -> Vec<u8> {
        bytes(json!({
            "kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
            "message": message, "reason": reason, "code": code,
        }))
    }

    #[test]
    fn the_index_gives_each_document_url_on_this_server() {
        let body = bytes(json!({ "paths": {
            "api/v1": { "serverRelativeURL": "/openapi/v3/api/v1?hash=AB" },
            "apis/apps/v1": { "serverRelativeURL": "/openapi/v3/apis/apps/v1?hash=CD" },
            "apis/other/v1": { "serverRelativeURL": "//elsewhere.example.com/x" },
            "apis/far/v1": { "serverRelativeURL": "https://elsewhere.example.com/x" },
            "apis/none/v1": {},
        } }));
        let index = index_answer(StatusCode::OK, &body, "v1").unwrap();
        assert_eq!(index.url("api/v1"), Some("/openapi/v3/api/v1?hash=AB"));
        assert_eq!(
            index.url("apis/apps/v1"),
            Some("/openapi/v3/apis/apps/v1?hash=CD")
        );
        for key in [
            "apis/other/v1",
            "apis/far/v1",
            "apis/none/v1",
            "apis/batch/v1",
        ] {
            assert_eq!(index.url(key), None, "{key}");
        }
    }

    #[test]
    fn no_index_means_no_openapi_v3() {
        let body = status_body(
            404,
            "NotFound",
            "the server could not find the requested resource",
        );
        let err = index_answer(StatusCode::NOT_FOUND, &body, "apps/v1").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(
            err.message,
            "This cluster does not publish OpenAPI v3, so API docs are not available."
        );
        assert_eq!(err.details.as_deref(), Some("HTTP 404"));
    }

    #[test]
    fn refusals_map_as_the_spec_says() {
        let forbidden = index_answer(
            StatusCode::FORBIDDEN,
            &status_body(403, "Forbidden", "no"),
            "v1",
        )
        .unwrap_err();
        assert_eq!(
            (forbidden.code, forbidden.message.as_str()),
            (
                ErrorCode::Forbidden,
                "You may not read the cluster's API docs (/openapi/v3)."
            )
        );
        let forbidden = document_answer(StatusCode::FORBIDDEN, b"", "v1").unwrap_err();
        assert_eq!(forbidden.code, ErrorCode::Forbidden);

        let body = status_body(401, "Unauthorized", "Unauthorized");
        let unauthorized = index_answer(StatusCode::UNAUTHORIZED, &body, "v1").unwrap_err();
        assert_eq!(
            (unauthorized.code, unauthorized.message.as_str()),
            (ErrorCode::Unauthorized, "Unauthorized")
        );

        let broken = index_answer(StatusCode::INTERNAL_SERVER_ERROR, b"boom\n", "v1").unwrap_err();
        assert_eq!(
            (broken.code, broken.message.as_str()),
            (ErrorCode::Internal, "boom")
        );
        assert_eq!(broken.details.as_deref(), Some("HTTP 500"));

        let busy = document_answer(StatusCode::SERVICE_UNAVAILABLE, b"", "v1").unwrap_err();
        assert_eq!(
            (busy.code, busy.message.as_str()),
            (ErrorCode::Unreachable, "HTTP 503")
        );
    }

    #[test]
    fn an_answer_that_is_not_openapi_cannot_be_read() {
        let unreadable = "The cluster's API docs for apps/v1 could not be read.";
        for body in [b"<html>".to_vec(), bytes(json!({ "openapi": "3.0.0" }))] {
            let err = index_answer(StatusCode::OK, &body, "apps/v1").unwrap_err();
            assert_eq!(
                (err.code, err.message.as_str()),
                (ErrorCode::Internal, unreadable)
            );
        }
        for body in [
            b"[".to_vec(),
            bytes(json!({ "components": {} })),
            bytes(json!({ "components": { "schemas": [] } })),
        ] {
            let err = document_answer(StatusCode::OK, &body, "apps/v1").unwrap_err();
            assert_eq!(
                (err.code, err.message.as_str()),
                (ErrorCode::Internal, unreadable)
            );
        }
    }

    #[test]
    fn a_document_that_moved_or_went_is_a_miss() {
        let document = json!({ "components": { "schemas": { "a": {} } } });
        assert_eq!(
            document_answer(StatusCode::OK, &bytes(document.clone()), "v1").unwrap(),
            Some(document)
        );
        assert_eq!(
            document_answer(StatusCode::MOVED_PERMANENTLY, b"", "v1").unwrap(),
            None
        );
        assert_eq!(
            document_answer(StatusCode::NOT_FOUND, b"", "v1").unwrap(),
            None
        );
    }
}
