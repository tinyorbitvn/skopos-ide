//! The key and the PKCS#10 request for a new user. Pure: nothing here talks to a cluster.
//! rcgen makes the key and signs, but this file encodes the request: rcgen's
//! `DistinguishedName` holds one value per attribute type, and each group is its own `O=`.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rcgen::{KeyPair, PublicKeyData, SigningKey, PKCS_ECDSA_P256_SHA256};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{CoreResult, ErrorCode, IpcError};

const SEQUENCE: u8 = 0x30;
const SET: u8 = 0x31;
const INTEGER: u8 = 0x02;
const BIT_STRING: u8 = 0x03;
const OBJECT_IDENTIFIER: u8 = 0x06;
const UTF8_STRING: u8 = 0x0c;
/// `[0] IMPLICIT SET OF Attribute`: left empty, as the request asks for no extensions.
const ATTRIBUTES: u8 = 0xa0;
/// 2.5.4.3, commonName.
const COMMON_NAME: [u8; 3] = [0x55, 0x04, 0x03];
/// 2.5.4.10, organizationName.
const ORGANIZATION: [u8; 3] = [0x55, 0x04, 0x0a];
/// 1.2.840.10045.4.3.2, ecdsa-with-SHA256.
const ECDSA_WITH_SHA256: [u8; 8] = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

/// The private key of one create run. Its bytes are wiped when it is dropped.
pub(crate) struct SecretKey(KeyPair);

impl SecretKey {
    /// The key as PKCS#8 PEM, for the kubeconfig's `client-key-data`.
    pub(crate) fn pem(&self) -> Zeroizing<String> {
        Zeroizing::new(self.0.serialize_pem())
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

fn failed() -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        "the key or the signing request cannot be made",
    )
}

/// One DER element: its tag, a definite length, and the content.
fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let length = content.len();
    if length < 0x80 {
        out.push(length as u8);
    } else {
        let bytes = length.to_be_bytes();
        let first = bytes
            .iter()
            .position(|b| *b != 0)
            .unwrap_or(bytes.len() - 1);
        out.push(0x80 | (bytes.len() - first) as u8);
        out.extend_from_slice(&bytes[first..]);
    }
    out.extend_from_slice(content);
    out
}

/// One attribute as its own relative distinguished name, as `openssl req -subj /O=a/O=b` does.
fn name_attribute(oid: &[u8], value: &str) -> Vec<u8> {
    tagged_attribute(oid, UTF8_STRING, value.as_bytes())
}

fn tagged_attribute(oid: &[u8], tag: u8, value: &[u8]) -> Vec<u8> {
    let pair = [der(OBJECT_IDENTIFIER, oid), der(tag, value)].concat();
    der(SET, &der(SEQUENCE, &pair))
}

fn pem_block(label: &str, der: &[u8]) -> String {
    let text = STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in text.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// An ECDSA P-256 key, and a request in PEM for `CN=<user>` with one `O=` per group, in the
/// order given.
pub(crate) fn generate(user: &str, groups: &[String]) -> CoreResult<(SecretKey, String)> {
    let key = SecretKey(KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|_| failed())?);
    let mut subject = name_attribute(&COMMON_NAME, user);
    for group in groups {
        subject.extend(name_attribute(&ORGANIZATION, group));
    }
    let request = signed_request(&key, &subject)?;
    Ok((key, request))
}

/// A request in PEM for `subject`, the Name's relative distinguished names in DER, signed by
/// `key`.
fn signed_request(key: &SecretKey, subject: &[u8]) -> CoreResult<String> {
    let info = der(
        SEQUENCE,
        &[
            der(INTEGER, &[0]),
            der(SEQUENCE, subject),
            key.0.subject_public_key_info(),
            der(ATTRIBUTES, &[]),
        ]
        .concat(),
    );
    let signature = key.0.sign(&info).map_err(|_| failed())?;
    // A BIT STRING starts with its count of unused bits.
    let mut bits = vec![0];
    bits.extend(signature);
    let request = der(
        SEQUENCE,
        &[
            info,
            der(SEQUENCE, &der(OBJECT_IDENTIFIER, &ECDSA_WITH_SHA256)),
            der(BIT_STRING, &bits),
        ]
        .concat(),
    );
    Ok(pem_block("CERTIFICATE REQUEST", &request))
}

/// A request PEM whose subject is these attributes, each its own relative distinguished name:
/// `("CN" or "O", the string's DER tag, its bytes)`. For tests of how requests are read.
#[cfg(test)]
pub(crate) fn request_with_subject(attributes: &[(&str, u8, &[u8])]) -> String {
    let key = SecretKey(KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap());
    let subject: Vec<u8> = attributes
        .iter()
        .flat_map(|(name, tag, value)| {
            let oid: &[u8] = if *name == "CN" {
                &COMMON_NAME
            } else {
                &ORGANIZATION
            };
            tagged_attribute(oid, *tag, value)
        })
        .collect();
    signed_request(&key, &subject).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_parser::prelude::*;

    fn request_der(pem: &str) -> Vec<u8> {
        let (_, block) = parse_x509_pem(pem.as_bytes()).unwrap();
        assert_eq!(block.label, "CERTIFICATE REQUEST");
        block.contents
    }

    #[test]
    fn the_request_names_the_user_and_each_group_in_order() {
        let groups = ["payments-devs", "oncall", "a,b+c"].map(String::from);
        let (_key, pem) = generate("Carol Smith", &groups).unwrap();
        let der = request_der(&pem);
        let (rest, request) = X509CertificationRequest::from_der(&der).unwrap();
        assert!(rest.is_empty());
        let subject = &request.certification_request_info.subject;
        let cn: Vec<&str> = subject
            .iter_common_name()
            .map(|a| a.as_str().unwrap())
            .collect();
        let o: Vec<&str> = subject
            .iter_organization()
            .map(|a| a.as_str().unwrap())
            .collect();
        assert_eq!(cn, ["Carol Smith"]);
        assert_eq!(o, ["payments-devs", "oncall", "a,b+c"]);
    }

    #[test]
    fn the_request_holds_a_p256_key_and_is_signed_by_it() {
        let (_key, pem) = generate("carol", &[]).unwrap();
        let der = request_der(&pem);
        let (_, request) = X509CertificationRequest::from_der(&der).unwrap();
        request.verify_signature().unwrap();
        let key = &request.certification_request_info.subject_pki;
        // id-ecPublicKey, on a 256-bit curve; signed with ecdsa-with-SHA256.
        assert_eq!(key.algorithm.algorithm.to_id_string(), "1.2.840.10045.2.1");
        assert_eq!(key.parsed().unwrap().key_size(), 256);
        assert_eq!(
            request.signature_algorithm.algorithm.to_id_string(),
            "1.2.840.10045.4.3.2"
        );
    }

    #[test]
    fn a_long_subject_uses_long_form_lengths() {
        let groups: Vec<String> = (0..20)
            .map(|i| format!("group-{i:02}-{}", "x".repeat(50)))
            .collect();
        let (_key, pem) = generate(&"u".repeat(64), &groups).unwrap();
        let der = request_der(&pem);
        assert!(der.len() > 1000, "{}", der.len());
        let (_, request) = X509CertificationRequest::from_der(&der).unwrap();
        request.verify_signature().unwrap();
        assert_eq!(
            request
                .certification_request_info
                .subject
                .iter_organization()
                .count(),
            20
        );
    }

    #[test]
    fn the_key_is_pkcs8_pem() {
        let (key, _) = generate("carol", &[]).unwrap();
        assert!(key.pem().starts_with("-----BEGIN PRIVATE KEY-----\n"));
    }
}
