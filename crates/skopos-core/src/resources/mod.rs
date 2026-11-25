//! The resource engine: what a cluster serves, and what the user may do with it.

mod access;
mod actions;
mod apply;
mod argocd;
mod cert_user;
mod csr;
mod discovery;
mod drain;
mod hub;
mod kubeconfig_export;
mod names;
mod object_watch;
mod ops;
mod patch;
mod sanitize;
mod service_account;
mod single_flight;
mod subjects;
mod trim;
mod types;

pub(crate) use actions::{restartable, scalable};
pub use actions::{DataChange, SecretChange, SecretData, SecretValue};
pub(crate) use apply::parse_documents;
pub use apply::ApplyResult;
pub use argocd::{
    ArgoRollbackOptions, ArgoSyncOptions, ArgoSyncResource, ArgoSyncStrategy,
    SYNC_WINDOWS_UNVERIFIED,
};
pub(crate) use cert_user::RunningCertUser;
pub use cert_user::{
    BoundBinding, CertUserEvent, CertUserLimits, CertUserRequest, CertUserStep, RoleGrant, RoleKind,
};
pub use csr::{
    certificate_request_describe, CertificateRequestInfo, CsrDecision, CsrReview, IdentityGrant,
};
pub(crate) use discovery::state_name;
pub(crate) use drain::RunningDrain;
pub use drain::{DrainEvent, DrainOptions, DrainOutcome, PodRef, SkipReason, SkippedPod};
pub use hub::NAMESPACE_LISTS_AT_ONCE;
pub(crate) use hub::{RowShape, Scope, WatchHub};
pub(crate) use names::NAMES_TTL;
pub use names::{ObjectName, ObjectNames};
pub(crate) use ops::{invalid, is_path_segment};
pub use ops::{InvolvedRef, Propagation};
pub use patch::PatchKind;
pub use sanitize::strip_for_list;
pub use service_account::SavedKubeconfig;
pub(crate) use single_flight::SingleFlight;
pub use subjects::{
    BindingKind, BindingRef, RemovalOutcome, SubjectKind, SubjectRef, SubjectRemoval,
};
pub use types::{
    ApiResourceInfo, ObjectKey, ResourceRef, Row, WatchEvent, WatchStatus, SNAPSHOT_PART_BYTES,
    SNAPSHOT_PART_ROWS,
};
