//! CertificateSigningRequests: reading requests and certificates (spec §5.1).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use k8s_openapi::jiff::Timestamp;
use serde::Serialize;
use ts_rs::TS;
use x509_parser::prelude::*;
use x509_parser::public_key::PublicKey;

use super::ops::invalid;
use crate::error::{CoreResult, ErrorCode, IpcError};

/// What the CSR drawer shows of a request and its certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CertificateRequestInfo {
    pub common_name: String,
    pub organizations: Vec<String>,
    /// "ECDSA P-256", "RSA 2048", "Other".
    pub key_algorithm: String,
    /// When the issued certificate expires, RFC 3339. `None` until there is one.
    pub not_after: Option<String>,
}

/// The DER of the first PEM block.
fn pem_contents(bytes: &[u8]) -> Option<Vec<u8>> {
    parse_x509_pem(bytes).ok().map(|(_, block)| block.contents)
}

fn key_algorithm(key: &SubjectPublicKeyInfo<'_>) -> String {
    match key.parsed() {
        Ok(PublicKey::EC(point)) => match point.key_size() {
            256 => "ECDSA P-256".to_owned(),
            384 => "ECDSA P-384".to_owned(),
            // x509-parser counts P-521's 66-byte coordinates as 528 bits.
            528 => "ECDSA P-521".to_owned(),
            _ => "ECDSA".to_owned(),
        },
        Ok(PublicKey::RSA(rsa)) => format!("RSA {}", rsa.key_size()),
        _ => "Other".to_owned(),
    }
}

/// When the first certificate in `pem` expires, RFC 3339.
pub(crate) fn certificate_expiry(pem: &[u8]) -> CoreResult<String> {
    let unreadable = || {
        IpcError::new(
            ErrorCode::Internal,
            "the API server returned a certificate that cannot be read",
        )
    };
    let der = pem_contents(pem).ok_or_else(unreadable)?;
    let (_, certificate) = X509Certificate::from_der(&der).map_err(|_| unreadable())?;
    Timestamp::from_second(certificate.validity().not_after.timestamp())
        .map(|at| at.to_string())
        .map_err(|_| unreadable())
}

/// Describes a CSR's request and, once issued, its certificate. Both are base64, as in the
/// object's JSON. Nothing of an input that does not parse is quoted back.
pub fn certificate_request_describe(
    request: &str,
    certificate: Option<&str>,
) -> CoreResult<CertificateRequestInfo> {
    let unreadable = || invalid("the signing request cannot be read");
    let der = STANDARD
        .decode(request)
        .ok()
        .and_then(|pem| pem_contents(&pem))
        .ok_or_else(unreadable)?;
    let (_, parsed) = X509CertificationRequest::from_der(&der).map_err(|_| unreadable())?;
    let info = &parsed.certification_request_info;
    let common_name = info
        .subject
        .iter_common_name()
        .find_map(|v| v.as_str().ok())
        .unwrap_or_default()
        .to_owned();
    let organizations = info
        .subject
        .iter_organization()
        .filter_map(|v| v.as_str().ok())
        .map(str::to_owned)
        .collect();
    let not_after = match certificate {
        None => None,
        Some(text) => {
            let unreadable = || invalid("the certificate cannot be read");
            let pem = STANDARD.decode(text).map_err(|_| unreadable())?;
            Some(certificate_expiry(&pem).map_err(|_| unreadable())?)
        }
    };
    Ok(CertificateRequestInfo {
        common_name,
        organizations,
        key_algorithm: key_algorithm(&info.subject_pki),
        not_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::cert_user::generate_for_tests;

    const RSA_REQUEST: &str = include_str!("../../tests/fixtures/rsa-2048.csr");

    #[test]
    fn an_ecdsa_request_is_described() {
        let pem = generate_for_tests("carol", &["devs".to_owned(), "oncall".to_owned()]);
        let info = certificate_request_describe(&STANDARD.encode(pem), None).unwrap();
        assert_eq!(
            info,
            CertificateRequestInfo {
                common_name: "carol".into(),
                organizations: vec!["devs".into(), "oncall".into()],
                key_algorithm: "ECDSA P-256".into(),
                not_after: None,
            }
        );
    }

    #[test]
    fn an_rsa_request_is_described() {
        let info = certificate_request_describe(&STANDARD.encode(RSA_REQUEST), None).unwrap();
        assert_eq!(info.common_name, "rsa-user");
        assert_eq!(info.organizations, ["team"]);
        assert_eq!(info.key_algorithm, "RSA 2048");
    }

    #[test]
    fn a_certificate_gives_its_expiry() {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca = rcgen::CertificateParams::default();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let issuer = rcgen::Issuer::new(ca, ca_key);
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let mut leaf = rcgen::CertificateParams::default();
        leaf.not_after = rcgen::date_time_ymd(2031, 1, 2);
        let certificate = leaf.signed_by(&leaf_key, &issuer).unwrap().pem();

        let pem = generate_for_tests("carol", &[]);
        let info = certificate_request_describe(
            &STANDARD.encode(pem),
            Some(&STANDARD.encode(&certificate)),
        )
        .unwrap();
        assert_eq!(info.not_after.as_deref(), Some("2031-01-02T00:00:00Z"));
        assert_eq!(
            certificate_expiry(certificate.as_bytes()).unwrap(),
            "2031-01-02T00:00:00Z"
        );
    }

    #[test]
    fn what_does_not_parse_is_refused_without_quoting_it() {
        let garbage = STANDARD.encode("not a request");
        let error = certificate_request_describe(&garbage, None).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(
            !error.message.contains("not a request"),
            "{}",
            error.message
        );

        let pem = generate_for_tests("carol", &[]);
        let error =
            certificate_request_describe(&STANDARD.encode(pem), Some(&garbage)).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.message, "the certificate cannot be read");

        let error = certificate_expiry(b"not a certificate").unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(
            error.message,
            "the API server returned a certificate that cannot be read"
        );
    }
}
