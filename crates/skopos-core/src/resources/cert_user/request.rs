//! What the person asks for when creating a user, and its checks (spec §5.1, §5.3). The
//! dialog runs the same checks; the messages here are the dialog's.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::CoreResult;
#[cfg(test)]
use crate::error::ErrorCode;
use crate::resources::ops::{invalid, is_path_segment};

const MIN_LIFETIME_SECONDS: u32 = 600;
const MAX_LIFETIME_SECONDS: u32 = 31_536_000;
/// RFC 5280's upper bound for commonName, which group names share here.
const MAX_NAME_CHARS: usize = 64;
const SYSTEM_PREFIX: &str = "system:";
/// generateName adds five characters to the prefix.
const CSR_PREFIX_CHARS: usize = 50;
const OBJECT_NAME_CHARS: usize = 253;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum RoleKind {
    ClusterRole,
    Role,
}

impl RoleKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ClusterRole => "ClusterRole",
            Self::Role => "Role",
        }
    }
}

/// The role the new user gets: cluster-wide (a ClusterRoleBinding) without a namespace,
/// else a RoleBinding in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RoleGrant {
    pub role_kind: RoleKind,
    pub role_name: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CertUserRequest {
    pub user_name: String,
    pub groups: Vec<String>,
    /// Not `i64`, which ts-rs exports as `bigint`.
    pub lifetime_seconds: u32,
    pub binding: Option<RoleGrant>,
}

fn check_name(name: &str) -> CoreResult<()> {
    if name.starts_with(SYSTEM_PREFIX) {
        return Err(invalid(
            "Names that start with system: are reserved for Kubernetes.",
        ));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(invalid("Use at most 64 characters."));
    }
    Ok(())
}

impl CertUserRequest {
    /// The request with its names trimmed and empty groups dropped, or its first problem.
    pub(crate) fn normalized(mut self) -> CoreResult<Self> {
        self.user_name = self.user_name.trim().to_owned();
        self.groups = self
            .groups
            .iter()
            .map(|group| group.trim().to_owned())
            .filter(|group| !group.is_empty())
            .collect();
        if self.user_name.is_empty() {
            return Err(invalid("Enter a user name."));
        }
        check_name(&self.user_name)?;
        for (index, group) in self.groups.iter().enumerate() {
            check_name(group)?;
            if self.groups[..index].contains(group) {
                return Err(invalid("Each group appears once."));
            }
        }
        if !(MIN_LIFETIME_SECONDS..=MAX_LIFETIME_SECONDS).contains(&self.lifetime_seconds) {
            return Err(invalid(
                "the certificate lifetime must be between 10 minutes and one year",
            ));
        }
        if let Some(grant) = &mut self.binding {
            grant.role_name = grant.role_name.trim().to_owned();
            grant.namespace = grant
                .namespace
                .take()
                .map(|namespace| namespace.trim().to_owned())
                .filter(|namespace| !namespace.is_empty());
            if grant.role_kind == RoleKind::Role && grant.namespace.is_none() {
                return Err(invalid("Pick a namespace for a Role."));
            }
            if !is_path_segment(&grant.role_name)
                || grant
                    .namespace
                    .as_deref()
                    .is_some_and(|n| !is_path_segment(n))
            {
                return Err(invalid("the namespace or role name is not valid"));
            }
        }
        Ok(self)
    }
}

fn cut(text: &str, max: usize) -> String {
    let kept: String = text.chars().take(max).collect();
    kept.trim_end_matches('-').to_owned()
}

/// Lowercase; anything outside `[a-z0-9]` becomes one `-`; no `-` at either end; at most
/// `max` characters; `user` when nothing is left.
pub(crate) fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = cut(out.trim_start_matches('-'), max);
    if out.is_empty() {
        "user".to_owned()
    } else {
        out
    }
}

/// The `generateName` of the user's CSR.
pub(crate) fn csr_prefix(user: &str) -> String {
    format!("{}-", slug(user, CSR_PREFIX_CHARS))
}

/// The name of the binding the grant makes: `<user slug>-<role slug>`.
pub(crate) fn binding_name(user: &str, role: &str) -> String {
    let joined = format!(
        "{}-{}",
        slug(user, OBJECT_NAME_CHARS),
        slug(role, OBJECT_NAME_CHARS)
    );
    cut(&joined, OBJECT_NAME_CHARS)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn request(user: &str, groups: &[&str]) -> CertUserRequest {
        CertUserRequest {
            user_name: user.into(),
            groups: groups.iter().map(|g| (*g).to_owned()).collect(),
            lifetime_seconds: 604_800,
            binding: None,
        }
    }

    fn refusal(r: CertUserRequest) -> String {
        let error = r.normalized().unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        error.message
    }

    #[test]
    fn names_are_trimmed_and_empty_groups_dropped() {
        let r = request("  carol ", &[" devs ", "", "   ", "oncall"])
            .normalized()
            .unwrap();
        assert_eq!(r.user_name, "carol");
        assert_eq!(r.groups, ["devs", "oncall"]);
    }

    #[test]
    fn each_refusal_uses_the_dialog_words() {
        assert_eq!(refusal(request("  ", &[])), "Enter a user name.");
        assert_eq!(
            refusal(request("system:admin", &[])),
            "Names that start with system: are reserved for Kubernetes."
        );
        assert_eq!(
            refusal(request("carol", &["system:masters"])),
            "Names that start with system: are reserved for Kubernetes."
        );
        assert_eq!(
            refusal(request(&"a".repeat(65), &[])),
            "Use at most 64 characters."
        );
        assert_eq!(
            refusal(request("carol", &[&"g".repeat(65)])),
            "Use at most 64 characters."
        );
        assert_eq!(
            refusal(request("carol", &["devs", " devs"])),
            "Each group appears once."
        );
    }

    #[test]
    fn sixty_four_characters_count_as_characters_not_bytes() {
        assert!(request(&"é".repeat(64), &[]).normalized().is_ok());
    }

    #[test]
    fn the_lifetime_is_ten_minutes_to_one_year() {
        for (seconds, ok) in [
            (599, false),
            (600, true),
            (31_536_000, true),
            (31_536_001, false),
        ] {
            let mut r = request("carol", &[]);
            r.lifetime_seconds = seconds;
            assert_eq!(r.normalized().is_ok(), ok, "{seconds}");
        }
    }

    fn granted(kind: RoleKind, role: &str, namespace: Option<&str>) -> CertUserRequest {
        let mut r = request("carol", &[]);
        r.binding = Some(RoleGrant {
            role_kind: kind,
            role_name: role.into(),
            namespace: namespace.map(str::to_owned),
        });
        r
    }

    #[test]
    fn a_role_needs_a_namespace_and_names_must_be_path_segments() {
        assert_eq!(
            refusal(granted(RoleKind::Role, "reader", None)),
            "Pick a namespace for a Role."
        );
        assert_eq!(
            refusal(granted(RoleKind::Role, "reader", Some("  "))),
            "Pick a namespace for a Role."
        );
        assert!(granted(RoleKind::ClusterRole, "view", None)
            .normalized()
            .is_ok());
        assert!(granted(RoleKind::ClusterRole, "view", Some("payments"))
            .normalized()
            .is_ok());
        assert_eq!(
            refusal(granted(RoleKind::ClusterRole, "a/b", None)),
            "the namespace or role name is not valid"
        );
        assert_eq!(
            refusal(granted(RoleKind::Role, "reader", Some("../x"))),
            "the namespace or role name is not valid"
        );
    }

    #[test]
    fn a_role_kind_is_named_as_kubernetes_names_it() {
        assert_eq!(RoleKind::ClusterRole.as_str(), "ClusterRole");
        assert_eq!(RoleKind::Role.as_str(), "Role");
    }

    #[test]
    fn slugs_are_lowercase_dashed_and_cut() {
        assert_eq!(slug("Carol.Smith@Corp", 253), "carol-smith-corp");
        assert_eq!(slug("--A--B--", 253), "a-b");
        assert_eq!(slug("system:node:x", 253), "system-node-x");
        assert_eq!(slug("", 253), "user");
        assert_eq!(slug("!!!", 253), "user");
        assert_eq!(slug("Zoë", 253), "zo");
        // A cut that ends on a dash drops the dash.
        let long = format!("{}.b", "a".repeat(49));
        assert_eq!(slug(&long, 50), "a".repeat(49));
    }

    #[test]
    fn the_csr_prefix_and_binding_name_come_from_slugs() {
        assert_eq!(csr_prefix("Carol.Smith@Corp"), "carol-smith-corp-");
        assert_eq!(csr_prefix(&"a".repeat(60)), format!("{}-", "a".repeat(50)));
        assert_eq!(binding_name("Carol", "edit"), "carol-edit");
        assert_eq!(binding_name("!!!", "edit"), "user-edit");
        let long = binding_name(&"u".repeat(200), &"r".repeat(200));
        assert_eq!(long.chars().count(), 253);
        assert!(!long.ends_with('-'));
    }
}
