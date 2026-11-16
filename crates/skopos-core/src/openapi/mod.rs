//! One kind's API docs, read from the cluster's OpenAPI v3 (spec L).

// Until `api_schema` (spec L1) calls into this module, parts of it have no caller.
#![allow(dead_code)]

mod tree;
mod types;

pub use types::{KindSchema, SchemaField};

use crate::error::CoreResult;
use crate::resources::invalid;

/// The answer to an apiVersion that is neither form (spec L2).
const BAD_API_VERSION: &str = "apiVersion must read ‹version› or ‹group›/‹version›.";
const NO_KIND: &str = "kind is empty.";

/// What `api_schema` looks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    /// As asked, which the messages quote and the result carries.
    pub(crate) api_version: String,
    /// "" for the core group.
    pub(crate) group: String,
    pub(crate) version: String,
    pub(crate) kind: String,
}

impl Target {
    /// `‹version›` or `‹group›/‹version›` with no spaces, and a non-empty kind (spec L2).
    pub(crate) fn parse(api_version: &str, kind: &str) -> CoreResult<Target> {
        let (group, version) = match api_version.split('/').collect::<Vec<_>>().as_slice() {
            [version] => ("", *version),
            [group, version] if !group.is_empty() => (*group, *version),
            _ => return Err(invalid(BAD_API_VERSION)),
        };
        if version.is_empty() || api_version.chars().any(char::is_whitespace) {
            return Err(invalid(BAD_API_VERSION));
        }
        let kind = kind.trim();
        if kind.is_empty() {
            return Err(invalid(NO_KIND));
        }
        Ok(Target {
            api_version: api_version.to_owned(),
            group: group.to_owned(),
            version: version.to_owned(),
            kind: kind.to_owned(),
        })
    }

    /// The group version's key in `/openapi/v3`'s `paths` (spec L3).
    pub(crate) fn key(&self) -> String {
        if self.group.is_empty() {
            format!("api/{}", self.version)
        } else {
            format!("apis/{}/{}", self.group, self.version)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn an_api_version_is_a_version_or_a_group_and_a_version() {
        let core = Target::parse("v1", "ConfigMap").unwrap();
        assert_eq!((core.group.as_str(), core.version.as_str()), ("", "v1"));
        assert_eq!(core.key(), "api/v1");
        let apps = Target::parse("apps/v1", " Deployment ").unwrap();
        assert_eq!(
            (
                apps.api_version.as_str(),
                apps.group.as_str(),
                apps.version.as_str()
            ),
            ("apps/v1", "apps", "v1")
        );
        assert_eq!(apps.kind, "Deployment");
        assert_eq!(apps.key(), "apis/apps/v1");
    }

    #[test]
    fn anything_else_is_refused_with_the_spec_text() {
        for bad in ["", "/v1", "apps/", "a/b/c", "apps /v1", " v1"] {
            let err = Target::parse(bad, "Kind").unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{bad:?}");
            assert_eq!(
                err.message, "apiVersion must read ‹version› or ‹group›/‹version›.",
                "{bad:?}"
            );
        }
        for kind in ["", "  "] {
            let err = Target::parse("v1", kind).unwrap_err();
            assert_eq!(
                (err.code, err.message.as_str()),
                (ErrorCode::InvalidInput, "kind is empty.")
            );
        }
    }
}
