//! Taking a User or Group out of the bindings that name it (spec 2026-11-22 §5.1). Kubernetes
//! has no User or Group objects; they exist only as subjects of bindings.

use std::fmt::Debug;

use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding, Subject};
use kube::api::{DeleteParams, PostParams, Preconditions};
use kube::{Api, Resource};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::ops::{invalid, is_path_segment};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum SubjectKind {
    User,
    Group,
}

impl SubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "User",
            Self::Group => "Group",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SubjectRef {
    pub kind: SubjectKind,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum BindingKind {
    RoleBinding,
    ClusterRoleBinding,
}

/// A binding as the person saw it in the live list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BindingRef {
    pub kind: BindingKind,
    /// The RoleBinding's namespace; `None` for a ClusterRoleBinding.
    pub namespace: Option<String>,
    pub name: String,
    /// A binding whose version changed since is left as it is.
    pub resource_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemovalOutcome {
    /// The binding keeps its other subjects.
    Updated,
    /// The subject was the binding's only one, so the binding is gone.
    Deleted,
    /// The binding changed since the person saw it, and was left as it is.
    Conflict,
    Failed {
        error: IpcError,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SubjectRemoval {
    pub binding: BindingRef,
    pub outcome: RemovalOutcome,
}

#[derive(Debug, PartialEq)]
pub(crate) enum RemovalPlan {
    /// Keep these subjects, in their order.
    Update(Vec<Subject>),
    /// No subject is left.
    Delete,
    /// The binding does not name the subject.
    Absent,
}

/// What taking `subject` out does to a binding with these subjects. Only subjects of the
/// same kind and name go: a ServiceAccount or a Group called `alice` stays when User
/// `alice` is removed.
pub(crate) fn plan_removal(subjects: &[Subject], subject: &SubjectRef) -> RemovalPlan {
    let (gone, kept): (Vec<Subject>, Vec<Subject>) = subjects
        .iter()
        .cloned()
        .partition(|s| s.kind == subject.kind.as_str() && s.name == subject.name);
    if gone.is_empty() {
        RemovalPlan::Absent
    } else if kept.is_empty() {
        RemovalPlan::Delete
    } else {
        RemovalPlan::Update(kept)
    }
}

trait Binding:
    Resource<DynamicType = ()> + Clone + Debug + DeserializeOwned + Serialize + Send + Sync
{
    fn subjects_mut(&mut self) -> &mut Option<Vec<Subject>>;
}

impl Binding for RoleBinding {
    fn subjects_mut(&mut self) -> &mut Option<Vec<Subject>> {
        &mut self.subjects
    }
}

impl Binding for ClusterRoleBinding {
    fn subjects_mut(&mut self) -> &mut Option<Vec<Subject>> {
        &mut self.subjects
    }
}

async fn remove_in<K: Binding>(
    api: &Api<K>,
    binding: &BindingRef,
    subject: &SubjectRef,
) -> RemovalOutcome {
    match try_remove(api, binding, subject).await {
        Ok(outcome) => outcome,
        // A write that lost a race with another change.
        Err(error) if error.code == ErrorCode::Conflict => RemovalOutcome::Conflict,
        Err(error) => RemovalOutcome::Failed { error },
    }
}

async fn try_remove<K: Binding>(
    api: &Api<K>,
    binding: &BindingRef,
    subject: &SubjectRef,
) -> CoreResult<RemovalOutcome> {
    let mut current = api.get(&binding.name).await?;
    if current.meta().resource_version.as_deref() != Some(binding.resource_version.as_str()) {
        return Ok(RemovalOutcome::Conflict);
    }
    let subjects = current.subjects_mut().take().unwrap_or_default();
    match plan_removal(&subjects, subject) {
        RemovalPlan::Absent => Err(invalid(format!(
            "the binding does not name {} {}",
            subject.kind.as_str(),
            subject.name
        ))),
        RemovalPlan::Update(kept) => {
            *current.subjects_mut() = Some(kept);
            // `current` carries the version read, so a change since gives 409.
            api.replace(&binding.name, &PostParams::default(), &current)
                .await?;
            Ok(RemovalOutcome::Updated)
        }
        RemovalPlan::Delete => {
            let params = DeleteParams {
                preconditions: Some(Preconditions {
                    resource_version: Some(binding.resource_version.clone()),
                    uid: None,
                }),
                ..DeleteParams::default()
            };
            api.delete(&binding.name, &params).await?;
            Ok(RemovalOutcome::Deleted)
        }
    }
}

fn valid(binding: &BindingRef) -> bool {
    let namespace = match (binding.kind, binding.namespace.as_deref()) {
        (BindingKind::RoleBinding, Some(namespace)) => is_path_segment(namespace),
        (BindingKind::ClusterRoleBinding, None) => true,
        _ => false,
    };
    namespace && is_path_segment(&binding.name)
}

impl AppCore {
    /// Takes a User or Group out of each binding: one that keeps other subjects is updated,
    /// one left with none is deleted. Each binding is handled on its own, so one that
    /// fails or changed meanwhile does not stop the rest.
    pub async fn access_subject_remove(
        &self,
        id: &ClusterId,
        subject: &SubjectRef,
        bindings: &[BindingRef],
    ) -> CoreResult<Vec<SubjectRemoval>> {
        if subject.name.starts_with("system:") {
            return Err(invalid("Kubernetes manages system users and groups"));
        }
        if subject.name.is_empty() || !bindings.iter().all(valid) {
            return Err(invalid("the binding is not valid"));
        }
        let client = self.cluster_client(id)?;
        let mut removals = Vec::with_capacity(bindings.len());
        for binding in bindings {
            let outcome = match binding.namespace.as_deref() {
                Some(namespace) => {
                    let api = Api::<RoleBinding>::namespaced(client.clone(), namespace);
                    remove_in(&api, binding, subject).await
                }
                None => {
                    let api = Api::<ClusterRoleBinding>::all(client.clone());
                    remove_in(&api, binding, subject).await
                }
            };
            removals.push(SubjectRemoval {
                binding: binding.clone(),
                outcome,
            });
        }
        Ok(removals)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(kind: &str, name: &str) -> Subject {
        Subject {
            kind: kind.into(),
            name: name.into(),
            ..Subject::default()
        }
    }

    fn alice() -> SubjectRef {
        SubjectRef {
            kind: SubjectKind::User,
            name: "alice".into(),
        }
    }

    #[test]
    fn the_last_subject_deletes_the_binding() {
        assert_eq!(
            plan_removal(&[subject("User", "alice")], &alice()),
            RemovalPlan::Delete
        );
    }

    #[test]
    fn other_subjects_stay_in_their_order() {
        let subjects = [
            subject("Group", "devs"),
            subject("User", "alice"),
            subject("ServiceAccount", "alice"),
            subject("Group", "alice"),
        ];
        assert_eq!(
            plan_removal(&subjects, &alice()),
            RemovalPlan::Update(vec![
                subject("Group", "devs"),
                subject("ServiceAccount", "alice"),
                subject("Group", "alice"),
            ])
        );
    }

    #[test]
    fn a_subject_named_twice_goes_entirely() {
        let subjects = [
            subject("User", "alice"),
            subject("User", "alice"),
            subject("Group", "devs"),
        ];
        assert_eq!(
            plan_removal(&subjects, &alice()),
            RemovalPlan::Update(vec![subject("Group", "devs")])
        );
    }

    #[test]
    fn a_binding_without_the_subject_is_absent() {
        assert_eq!(
            plan_removal(&[subject("Group", "alice")], &alice()),
            RemovalPlan::Absent
        );
        assert_eq!(plan_removal(&[], &alice()), RemovalPlan::Absent);
    }
}
