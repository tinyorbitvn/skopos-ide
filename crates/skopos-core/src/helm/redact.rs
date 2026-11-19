//! Keeps Secret values in a rendered manifest inside the core. A release's manifest and a
//! dry run's manifest hold every Secret the chart renders, values included.

use std::borrow::Cow;

use serde_yaml_ng::Value as Yaml;

/// Written under a Secret's header, so empty values are not taken for the chart's own.
const HIDDEN_NOTE: &str = "# Secret values are hidden.";
/// Stands in for a document that could not be read and may hold a Secret.
const UNREAD_NOTE: &str = "# This document could not be read and names a Secret, so it is hidden.";

/// The manifest with the values of every core `v1` Secret blanked, `List` items included.
/// The keys stay, as they do in listed objects. Every other document is returned as it is.
///
/// A document with a Secret is written again from what was read, so it loses its comments
/// and its layout, except the header that names its template. A document that cannot be
/// read is hidden whole when it names a Secret, since its values cannot be told apart.
pub(crate) fn hide_secret_values(manifest: &str) -> String {
    documents(manifest).into_iter().map(shown).collect()
}

/// The manifest cut before each `---` line, so the pieces join back into it unchanged.
fn documents(manifest: &str) -> Vec<&str> {
    let mut documents = Vec::new();
    let (mut start, mut at) = (0, 0);
    for line in manifest.split_inclusive('\n') {
        if at > start && is_marker(line) {
            documents.push(&manifest[start..at]);
            start = at;
        }
        at += line.len();
    }
    documents.push(&manifest[start..]);
    documents
}

/// Whether the line starts a YAML document.
fn is_marker(line: &str) -> bool {
    line.strip_prefix("---")
        .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '\t', '\r', '\n']))
}

fn shown(document: &str) -> Cow<'_, str> {
    let hidden = || Cow::Owned(format!("{}{UNREAD_NOTE}\n", header(document)));
    let Ok(mut value) = read(document) else {
        return if document.contains("Secret") {
            hidden()
        } else {
            Cow::Borrowed(document)
        };
    };
    if !blank_secrets(&mut value, None) {
        return Cow::Borrowed(document);
    }
    match serde_yaml_ng::to_string(&value) {
        Ok(text) => Cow::Owned(format!("{}{HIDDEN_NOTE}\n{text}", header(document))),
        Err(_) => hidden(),
    }
}

/// One document, with its merge keys applied so that no value hides behind one.
fn read(document: &str) -> Result<Yaml, serde_yaml_ng::Error> {
    let mut value: Yaml = serde_yaml_ng::from_str(document)?;
    value.apply_merge()?;
    Ok(value)
}

/// The `---` line and the comments a document starts with, which name its template.
fn header(document: &str) -> &str {
    let mut end = 0;
    for line in document.split_inclusive('\n') {
        let text = line.trim();
        let leads = (end == 0 && is_marker(line)) || text.is_empty() || text.starts_with('#');
        if !leads {
            break;
        }
        end += line.len();
    }
    &document[..end]
}

/// Blanks the values of every core `v1` Secret in the object and says whether it found one.
/// `listed` is the kind and API version a typed list gives the items that state none.
fn blank_secrets(value: &mut Yaml, listed: Option<(&str, &str)>) -> bool {
    let text = |key: &str| value.get(key).and_then(Yaml::as_str).map(str::to_owned);
    let kind = text("kind").or_else(|| listed.map(|(kind, _)| kind.to_owned()));
    let api_version = text("apiVersion").or_else(|| listed.map(|(_, version)| version.to_owned()));
    let (Some(kind), Some(api_version)) = (kind, api_version) else {
        return false;
    };
    if let Some(item_kind) = kind.strip_suffix("List") {
        if let Some(Yaml::Sequence(items)) = value.get_mut("items") {
            // `List` holds any kind, so its items state their own.
            let listed = (!item_kind.is_empty()).then_some((item_kind, api_version.as_str()));
            let mut found = false;
            for item in items {
                // Every item is read: stopping at the first Secret would leave the next one's values.
                found |= blank_secrets(item, listed);
            }
            return found;
        }
    }
    if kind != "Secret" || api_version != "v1" {
        return false;
    }
    for field in ["data", "stringData"] {
        match value.get_mut(field) {
            Some(Yaml::Mapping(values)) => {
                for (_, value) in values.iter_mut() {
                    *value = Yaml::String(String::new());
                }
            }
            // Not a shape the API accepts, and nothing says which part is a value.
            Some(other) => *other = Yaml::Null,
            None => {}
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "---\n# Source: chart/templates/config.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings   # kept as written\ndata:\n  message: \"hello\"\n";
    const SERVICE: &str = "---\n# Source: chart/templates/service.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n";

    #[test]
    fn a_manifest_without_secrets_is_returned_unchanged() {
        let manifest = format!("{CONFIG}{SERVICE}");
        assert_eq!(hide_secret_values(&manifest), manifest);
        assert_eq!(hide_secret_values(""), "");
        // A first document with no `---` line, as `helm template` can print one.
        let bare = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: bare\n";
        assert_eq!(hide_secret_values(bare), bare);
    }

    #[test]
    fn a_secret_keeps_its_keys_and_loses_its_values() {
        let secret = "---\n# Source: chart/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ntype: Opaque\ndata:\n  password: aHVudGVyMg==\n  user: YWRtaW4=\nstringData:\n  token: plain-token\n";
        let shown = hide_secret_values(&format!("{CONFIG}{secret}{SERVICE}"));

        for value in ["aHVudGVyMg==", "YWRtaW4=", "plain-token"] {
            assert!(!shown.contains(value), "{value} is still in:\n{shown}");
        }
        // The documents around it are untouched, and the Secret keeps its place and its header.
        assert!(shown.starts_with(CONFIG));
        assert!(shown.ends_with(SERVICE));
        assert!(shown.contains("---\n# Source: chart/templates/secret.yaml\n"));
        assert!(shown.contains(HIDDEN_NOTE));

        let middle = &shown[CONFIG.len()..shown.len() - SERVICE.len()];
        let read: serde_yaml_ng::Value = serde_yaml_ng::from_str(middle).unwrap();
        assert_eq!(read["kind"], "Secret");
        assert_eq!(read["metadata"]["name"], "db");
        assert_eq!(read["type"], "Opaque");
        assert_eq!(read["data"]["password"], "");
        assert_eq!(read["data"]["user"], "");
        assert_eq!(read["stringData"]["token"], "");
    }

    #[test]
    fn a_secret_inside_a_list_is_blanked() {
        let list = "---\napiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: ConfigMap\n    metadata:\n      name: in-list\n    data:\n      shown: \"yes\"\n  - apiVersion: v1\n    kind: Secret\n    metadata:\n      name: nested\n    data:\n      key: c2VjcmV0\n";
        let shown = hide_secret_values(list);

        assert!(!shown.contains("c2VjcmV0"), "{shown}");
        let read: serde_yaml_ng::Value = serde_yaml_ng::from_str(&shown).unwrap();
        assert_eq!(read["items"][0]["data"]["shown"], "yes");
        assert_eq!(read["items"][1]["data"]["key"], "");
    }

    #[test]
    fn every_secret_in_a_list_is_blanked() {
        let list = "---\napiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: Secret\n    metadata:\n      name: first\n    data:\n      key: Zmlyc3Q=\n  - apiVersion: v1\n    kind: Secret\n    metadata:\n      name: second\n    data:\n      key: c2Vjb25k\n";
        let shown = hide_secret_values(list);

        assert!(!shown.contains("Zmlyc3Q="), "{shown}");
        assert!(!shown.contains("c2Vjb25k"), "{shown}");
    }

    #[test]
    fn a_typed_list_gives_its_items_their_kind() {
        // The items of a `SecretList` need not repeat what the list states.
        let list = "---\napiVersion: v1\nkind: SecretList\nitems:\n  - metadata:\n      name: bare\n    data:\n      key: dHlwZWQ=\n";
        let shown = hide_secret_values(list);

        assert!(!shown.contains("dHlwZWQ="), "{shown}");
        let read: serde_yaml_ng::Value = serde_yaml_ng::from_str(&shown).unwrap();
        assert_eq!(read["items"][0]["data"]["key"], "");
    }

    #[test]
    fn values_reached_through_an_anchor_or_a_merge_key_are_blanked() {
        let secret = "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: shared\ndata:\n  first: &value c2hhcmVk\n  second: *value\nstringData:\n  <<: { merged: from-merge }\n";
        let shown = hide_secret_values(secret);

        assert!(!shown.contains("c2hhcmVk"), "{shown}");
        assert!(!shown.contains("from-merge"), "{shown}");
        let read: serde_yaml_ng::Value = serde_yaml_ng::from_str(&shown).unwrap();
        assert_eq!(read["data"]["second"], "");
        assert_eq!(read["stringData"]["merged"], "");
    }

    #[test]
    fn only_a_core_v1_secret_is_blanked() {
        // Another API group's kind of the same name is not a Secret, as in listed objects.
        let other = "---\napiVersion: example.com/v1\nkind: Secret\nmetadata:\n  name: custom\ndata:\n  key: kept\n";
        assert_eq!(hide_secret_values(other), other);
    }

    #[test]
    fn a_document_that_cannot_be_read_and_names_a_secret_is_hidden() {
        // The same key twice is an error to this reader, and not to every YAML reader.
        let broken = "---\n# Source: chart/templates/broken.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: twice\ndata:\n  key: Zmlyc3Q=\n  key: c2Vjb25k\n";
        let shown = hide_secret_values(&format!("{broken}{SERVICE}"));

        assert!(!shown.contains("Zmlyc3Q="), "{shown}");
        assert!(!shown.contains("c2Vjb25k"), "{shown}");
        assert!(shown.starts_with("---\n# Source: chart/templates/broken.yaml\n"));
        assert!(shown.contains(UNREAD_NOTE));
        // What follows is still read on its own.
        assert!(shown.ends_with(SERVICE));
    }

    #[test]
    fn a_document_that_cannot_be_read_and_names_no_secret_stays() {
        let broken = "---\napiVersion: v1\nkind: ConfigMap\ndata:\n  key: one\n  key: two\n";
        assert_eq!(hide_secret_values(broken), broken);
    }

    #[test]
    fn a_secret_whose_values_are_not_a_mapping_shows_none_of_them() {
        let odd = "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: odd\ndata: c2NhbGFy\nstringData:\n  - in-a-list\n";
        let shown = hide_secret_values(odd);

        assert!(!shown.contains("c2NhbGFy"), "{shown}");
        assert!(!shown.contains("in-a-list"), "{shown}");
    }
}
