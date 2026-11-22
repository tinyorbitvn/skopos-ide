//! Creating a user that signs in with a client certificate (spec 2026-11-22 §5.1).

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the create run uses the key and the request")
)]
mod csr;

/// A request PEM for tests in other modules.
#[cfg(test)]
pub(crate) fn generate_for_tests(user: &str, groups: &[String]) -> String {
    csr::generate(user, groups).unwrap().1
}
