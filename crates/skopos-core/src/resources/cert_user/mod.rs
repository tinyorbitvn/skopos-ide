//! Creating a user that signs in with a client certificate (spec 2026-11-22 §5.1).

mod csr;
mod request;
mod run;

pub use request::{CertUserRequest, RoleGrant, RoleKind};
pub(crate) use run::RunningCertUser;
pub use run::{BoundBinding, CertUserEvent, CertUserLimits, CertUserStep};

/// A request PEM for tests in other modules.
#[cfg(test)]
pub(crate) fn generate_for_tests(user: &str, groups: &[String]) -> String {
    csr::generate(user, groups).unwrap().1
}

#[cfg(test)]
pub(crate) use csr::request_with_subject;
