//! CertificateSigningRequests: reading requests and certificates (spec §5.1).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use k8s_openapi::jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use x509_parser::prelude::*;
use x509_parser::public_key::PublicKey;

use super::ops::{invalid, is_path_segment};
use super::subjects::{BindingKind, BindingRef, SubjectKind, SubjectRef};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use k8s_openapi::api::certificates::v1::{
    CertificateSigningRequest, CertificateSigningRequestCondition,
};
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding, RoleRef, Subject};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use kube::api::{ListParams, PostParams};
use kube::Api;

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
///
/// The subject is read as the API server reads it, or refused: a request with more than one
/// CN, or a CN or O value in a string type read here differently or not at all (the API server
/// also reads T61String and BMPString), would otherwise show one identity and grant another.
pub fn certificate_request_describe(
    request: &str,
    certificate: Option<&str>,
) -> CoreResult<CertificateRequestInfo> {
    let request = STANDARD
        .decode(request)
        .map_err(|_| invalid("the signing request cannot be read"))?;
    let certificate = certificate
        .map(|text| STANDARD.decode(text))
        .transpose()
        .map_err(|_| invalid("the certificate cannot be read"))?;
    describe_pem(&request, certificate.as_deref())
}

/// [`certificate_request_describe`] of the PEM texts, as the typed object holds them.
fn describe_pem(request: &[u8], certificate: Option<&[u8]>) -> CoreResult<CertificateRequestInfo> {
    let unreadable = || invalid("the signing request cannot be read");
    let der = pem_contents(request).ok_or_else(unreadable)?;
    let (_, parsed) = X509CertificationRequest::from_der(&der).map_err(|_| unreadable())?;
    let info = &parsed.certification_request_info;
    let value_unreadable =
        || invalid("the signing request has a CN or O value that cannot be read");
    let common_names = info
        .subject
        .iter_common_name()
        .map(|v| v.as_str().map_err(|_| value_unreadable()))
        .collect::<CoreResult<Vec<_>>>()?;
    if common_names.len() > 1 {
        return Err(invalid(
            "the signing request has more than one CN, so the user it names is not clear",
        ));
    }
    let common_name = common_names.first().copied().unwrap_or_default().to_owned();
    let organizations = info
        .subject
        .iter_organization()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .map_err(|_| value_unreadable())
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let not_after = certificate
        .map(|pem| certificate_expiry(pem).map_err(|_| invalid("the certificate cannot be read")))
        .transpose()?;
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
    use crate::resources::cert_user::{generate_for_tests, request_with_subject};

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

    const UTF8: u8 = 0x0c;
    const PRINTABLE: u8 = 0x13;
    const BMP: u8 = 0x1e;

    #[test]
    fn a_request_with_two_common_names_is_refused() {
        // The API server takes the last CN; showing the first would name someone else.
        let pem = request_with_subject(&[("CN", UTF8, b"carol"), ("CN", UTF8, b"system:admin")]);
        let error = certificate_request_describe(&STANDARD.encode(pem), None).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(
            error.message,
            "the signing request has more than one CN, so the user it names is not clear"
        );
    }

    #[test]
    fn a_value_in_a_string_type_not_read_here_is_refused() {
        // "system:nodes" in UTF-16: the API server reads it, so dropping it would hide a group.
        let bmp: Vec<u8> = "system:nodes"
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect();
        for subject in [
            vec![("CN", UTF8, b"carol".as_slice()), ("O", BMP, &bmp)],
            vec![("CN", BMP, bmp.as_slice())],
        ] {
            let pem = request_with_subject(&subject);
            let error = certificate_request_describe(&STANDARD.encode(pem), None).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput);
            assert_eq!(
                error.message,
                "the signing request has a CN or O value that cannot be read"
            );
        }
    }

    #[test]
    fn printable_strings_and_a_missing_common_name_are_read() {
        let pem = request_with_subject(&[("CN", PRINTABLE, b"carol"), ("O", PRINTABLE, b"devs")]);
        let info = certificate_request_describe(&STANDARD.encode(pem), None).unwrap();
        assert_eq!(info.common_name, "carol");
        assert_eq!(info.organizations, ["devs"]);

        let pem = request_with_subject(&[("O", UTF8, b"devs")]);
        let info = certificate_request_describe(&STANDARD.encode(pem), None).unwrap();
        assert_eq!(info.common_name, "");
    }

    fn grant(kind: SubjectKind, name: &str, role_kind: &str, role_name: &str) -> IdentityGrant {
        IdentityGrant {
            binding: BindingRef {
                kind: BindingKind::ClusterRoleBinding,
                namespace: None,
                name: format!("{name}-binding"),
                resource_version: "1".into(),
            },
            subject: SubjectRef {
                kind,
                name: name.into(),
            },
            role_kind: role_kind.into(),
            role_name: role_name.into(),
        }
    }

    fn requested(user: &str, groups: &[&str]) -> CertificateRequestInfo {
        CertificateRequestInfo {
            common_name: user.into(),
            organizations: groups.iter().map(|g| g.to_string()).collect(),
            key_algorithm: "ECDSA P-256".into(),
            not_after: None,
        }
    }

    #[test]
    fn system_names_and_the_kubeadm_admins_are_privileged() {
        let info = requested(
            "system:kube-controller-manager",
            &["devs", "system:nodes", "kubeadm:cluster-admins"],
        );
        assert_eq!(
            privileged(&info, Some(&[])),
            [
                "system:kube-controller-manager",
                "system:nodes",
                "kubeadm:cluster-admins"
            ]
        );
        // The kubeadm group as a user name is only a name.
        assert!(privileged(&requested("kubeadm:cluster-admins", &[]), None).is_empty());
    }

    #[test]
    fn a_name_bound_to_cluster_admin_is_privileged_by_its_own_kind() {
        let info = requested("carol", &["admins", "devs"]);
        let grants = [
            grant(SubjectKind::Group, "admins", "ClusterRole", "cluster-admin"),
            grant(SubjectKind::Group, "devs", "ClusterRole", "edit"),
            // A Role of that name in a namespace is not the ClusterRole.
            grant(SubjectKind::User, "carol", "Role", "cluster-admin"),
            // A user with a group's name is not that group.
            grant(SubjectKind::User, "devs", "ClusterRole", "cluster-admin"),
        ];
        assert_eq!(privileged(&info, Some(&grants)), ["admins"]);
        assert!(privileged(&info, None).is_empty());
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CsrDecision {
    Approve,
    Deny,
}

/// What the Approve confirm shows, all from one read of the request (spec §5.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CsrReview {
    /// The request read. Approving with it fails if the request was replaced since.
    pub uid: String,
    pub signer: String,
    pub requestor: String,
    pub expiration_seconds: Option<i32>,
    pub info: CertificateRequestInfo,
    /// The bindings that already name the requested user or one of its groups; `None` when
    /// they cannot be read, and `grants_error` says why.
    pub grants: Option<Vec<IdentityGrant>>,
    pub grants_error: Option<String>,
    /// The requested user and groups that hold privileged access, in the subject's order: a
    /// `system:` name, `kubeadm:cluster-admins`, or one a binding gives the ClusterRole
    /// `cluster-admin`.
    pub privileged: Vec<String>,
}

/// A binding that names the requested user or one of its groups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IdentityGrant {
    pub binding: BindingRef,
    pub subject: SubjectRef,
    pub role_kind: String,
    pub role_name: String,
}

/// The group kubeadm binds to `cluster-admin`. The API server refuses `system:masters` in
/// requests to this signer, but not this group.
const KUBEADM_ADMINS: &str = "kubeadm:cluster-admins";

/// Adds a grant for each subject of one binding that is the requested user or one of its
/// groups.
fn add_grants(
    grants: &mut Vec<IdentityGrant>,
    binding: BindingRef,
    subjects: Option<&[Subject]>,
    role: &RoleRef,
    info: &CertificateRequestInfo,
) {
    for subject in subjects.unwrap_or_default() {
        let kind = match subject.kind.as_str() {
            "User" if !info.common_name.is_empty() && subject.name == info.common_name => {
                SubjectKind::User
            }
            "Group" if info.organizations.contains(&subject.name) => SubjectKind::Group,
            _ => continue,
        };
        grants.push(IdentityGrant {
            binding: binding.clone(),
            subject: SubjectRef {
                kind,
                name: subject.name.clone(),
            },
            role_kind: role.kind.clone(),
            role_name: role.name.clone(),
        });
    }
}

/// The ClusterRoleBindings, then the RoleBindings of every namespace, that name the requested
/// user or one of its groups.
async fn grants_naming(
    client: &kube::Client,
    info: &CertificateRequestInfo,
) -> CoreResult<Vec<IdentityGrant>> {
    let mut grants = Vec::new();
    let everything = ListParams::default();
    for binding in Api::<ClusterRoleBinding>::all(client.clone())
        .list(&everything)
        .await?
    {
        let reference = BindingRef {
            kind: BindingKind::ClusterRoleBinding,
            namespace: None,
            name: binding.metadata.name.clone().unwrap_or_default(),
            resource_version: binding
                .metadata
                .resource_version
                .clone()
                .unwrap_or_default(),
        };
        let subjects = binding.subjects.as_deref();
        add_grants(&mut grants, reference, subjects, &binding.role_ref, info);
    }
    for binding in Api::<RoleBinding>::all(client.clone())
        .list(&everything)
        .await?
    {
        let reference = BindingRef {
            kind: BindingKind::RoleBinding,
            namespace: binding.metadata.namespace.clone(),
            name: binding.metadata.name.clone().unwrap_or_default(),
            resource_version: binding
                .metadata
                .resource_version
                .clone()
                .unwrap_or_default(),
        };
        let subjects = binding.subjects.as_deref();
        add_grants(&mut grants, reference, subjects, &binding.role_ref, info);
    }
    Ok(grants)
}

/// See [`CsrReview::privileged`].
fn privileged(info: &CertificateRequestInfo, grants: Option<&[IdentityGrant]>) -> Vec<String> {
    let requested = std::iter::once((SubjectKind::User, &info.common_name)).chain(
        info.organizations
            .iter()
            .map(|group| (SubjectKind::Group, group)),
    );
    let mut out: Vec<String> = Vec::new();
    for (kind, name) in requested {
        if name.is_empty() || out.contains(name) {
            continue;
        }
        let cluster_admin = grants.unwrap_or_default().iter().any(|g| {
            g.subject.kind == kind
                && g.subject.name == *name
                && g.role_kind == "ClusterRole"
                && g.role_name == "cluster-admin"
        });
        if name.starts_with("system:")
            || (kind == SubjectKind::Group && name == KUBEADM_ADMINS)
            || cluster_admin
        {
            out.push(name.clone());
        }
    }
    out
}

fn replaced() -> IpcError {
    IpcError::new(
        ErrorCode::Conflict,
        "the request was replaced since you reviewed it",
    )
}

/// Approves or denies the request `name` whose uid is `uid`, as `kubectl certificate approve`
/// does: a PUT to `/approval`, which needs `update` there, carrying the version read. A request
/// that changed meanwhile is read again once.
///
/// A request's spec cannot change, so the uid pins what was reviewed. A request with another
/// uid was deleted and made again under the same name, perhaps for someone else, and is left as
/// it is.
pub(crate) async fn set_approval(
    api: &Api<CertificateSigningRequest>,
    name: &str,
    uid: &str,
    decision: CsrDecision,
) -> CoreResult<()> {
    let (kind, reason, message) = match decision {
        CsrDecision::Approve => ("Approved", "ApprovedInSkoposIDE", "Approved in SkoposIDE"),
        CsrDecision::Deny => ("Denied", "DeniedInSkoposIDE", "Denied in SkoposIDE"),
    };
    let mut retried = false;
    loop {
        let mut csr = api.get(name).await?;
        if csr.metadata.uid.as_deref() != Some(uid) {
            return Err(replaced());
        }
        let conditions = csr
            .status
            .get_or_insert_with(Default::default)
            .conditions
            .get_or_insert_with(Vec::new);
        let decided = conditions
            .iter()
            .find(|c| c.status == "True" && (c.type_ == "Approved" || c.type_ == "Denied"));
        if let Some(decided) = decided {
            let word = if decided.type_ == "Approved" {
                "approved"
            } else {
                "denied"
            };
            return Err(IpcError::new(
                ErrorCode::Conflict,
                format!("the request was already {word}"),
            ));
        }
        conditions.push(CertificateSigningRequestCondition {
            type_: kind.to_owned(),
            status: "True".to_owned(),
            reason: Some(reason.to_owned()),
            message: Some(message.to_owned()),
            last_update_time: Some(Time(Timestamp::now())),
            ..CertificateSigningRequestCondition::default()
        });
        match api
            .replace_subresource("approval", name, &PostParams::default(), &csr)
            .await
            .map_err(IpcError::from)
        {
            Ok(_) => return Ok(()),
            Err(error) if error.code == ErrorCode::Conflict && !retried => retried = true,
            Err(error) => return Err(error),
        }
    }
}

impl AppCore {
    /// Reads another's CertificateSigningRequest for the Approve confirm (spec §5.4): what it
    /// asks for, and the access its user and groups already have.
    pub async fn csr_review(&self, id: &ClusterId, name: &str) -> CoreResult<CsrReview> {
        if !is_path_segment(name) {
            return Err(invalid("the request name is not valid"));
        }
        let client = self.cluster_client(id)?;
        let csr = Api::<CertificateSigningRequest>::all(client.clone())
            .get(name)
            .await?;
        let uid = csr.metadata.uid.clone().ok_or_else(|| {
            IpcError::new(
                ErrorCode::Internal,
                "the API server gave the request no uid",
            )
        })?;
        let certificate = csr
            .status
            .as_ref()
            .and_then(|status| status.certificate.as_ref())
            .map(|certificate| certificate.0.as_slice())
            .filter(|certificate| !certificate.is_empty());
        let info = describe_pem(&csr.spec.request.0, certificate)?;
        let (grants, grants_error) = match grants_naming(&client, &info).await {
            Ok(grants) => (Some(grants), None),
            Err(error) => (None, Some(error.message)),
        };
        let privileged = privileged(&info, grants.as_deref());
        Ok(CsrReview {
            uid,
            signer: csr.spec.signer_name,
            requestor: csr.spec.username.unwrap_or_default(),
            expiration_seconds: csr.spec.expiration_seconds,
            info,
            grants,
            grants_error,
            privileged,
        })
    }

    /// Approves or denies another's CertificateSigningRequest (spec §5.4), the one with the
    /// uid the person reviewed.
    pub async fn csr_set_approval(
        &self,
        id: &ClusterId,
        name: &str,
        uid: &str,
        decision: CsrDecision,
    ) -> CoreResult<()> {
        if !is_path_segment(name) {
            return Err(invalid("the request name is not valid"));
        }
        let api: Api<CertificateSigningRequest> = Api::all(self.cluster_client(id)?);
        set_approval(&api, name, uid, decision).await
    }
}
