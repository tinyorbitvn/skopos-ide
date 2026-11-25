//! The chat's kubeconfig (native agents spec §4.3): one context per cluster of the chat, each
//! entry named after its cluster, written into the chat's private run folder.

use std::path::{Path, PathBuf};

use serde_yaml_ng::{Mapping, Value};

use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::write_private;

pub(crate) const CHAT_KUBECONFIG: &str = "kubeconfig";

fn invalid(message: String) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

fn named(root: &Mapping, section: &str, name: &str) -> Option<Value> {
    root.get(section)?
        .as_sequence()?
        .iter()
        .find(|item| item.get("name").and_then(Value::as_str) == Some(name))
        .cloned()
}

fn renamed(mut item: Value, name: &str) -> Value {
    if let Value::Mapping(map) = &mut item {
        map.insert(Value::from("name"), Value::from(name));
    }
    item
}

/// Writes one kubeconfig holding every part's context, cluster and user, renamed to the part's
/// cluster name, with the first part as `current-context`. Each part's file is a single-context
/// kubeconfig whose `current-context` names its context.
pub(crate) fn write_chat_kubeconfig(parts: &[(String, PathBuf)], dest: &Path) -> CoreResult<()> {
    let mut contexts = Vec::new();
    let mut clusters = Vec::new();
    let mut users = Vec::new();
    for (name, path) in parts {
        let text = std::fs::read_to_string(path)?;
        let Value::Mapping(root) = serde_yaml_ng::from_str::<Value>(&text)
            .map_err(|e| invalid(format!("{}: {e}", path.display())))?
        else {
            return Err(invalid(format!("{} is not a kubeconfig", path.display())));
        };
        let current = root
            .get("current-context")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(format!("{} has no current context", path.display())))?;
        let context = named(&root, "contexts", current)
            .ok_or_else(|| invalid(format!("{} has no context {current}", path.display())))?;
        let body = |key: &str| {
            context
                .get("context")
                .and_then(|c| c.get(key))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let cluster = named(&root, "clusters", &body("cluster"))
            .ok_or_else(|| invalid(format!("{} has no cluster for {current}", path.display())))?;
        let user = named(&root, "users", &body("user"))
            .ok_or_else(|| invalid(format!("{} has no user for {current}", path.display())))?;
        let mut context = renamed(context, name);
        if let Some(Value::Mapping(inner)) = context.get_mut("context") {
            inner.insert(Value::from("cluster"), Value::from(name.as_str()));
            inner.insert(Value::from("user"), Value::from(name.as_str()));
        }
        contexts.push(context);
        clusters.push(renamed(cluster, name));
        users.push(renamed(user, name));
    }
    let first = parts
        .first()
        .map(|(name, _)| name.clone())
        .unwrap_or_default();
    let mut root = Mapping::new();
    root.insert(Value::from("apiVersion"), Value::from("v1"));
    root.insert(Value::from("kind"), Value::from("Config"));
    root.insert(Value::from("clusters"), Value::Sequence(clusters));
    root.insert(Value::from("users"), Value::Sequence(users));
    root.insert(Value::from("contexts"), Value::Sequence(contexts));
    root.insert(Value::from("current-context"), Value::from(first));
    let text = serde_yaml_ng::to_string(&root)
        .map_err(|e| IpcError::new(ErrorCode::Internal, format!("cannot serialize: {e}")))?;
    write_private(dest, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(dir: &Path, file: &str, server: &str, namespace: Option<&str>) -> PathBuf {
        let ns = namespace
            .map(|n| format!(", namespace: {n}"))
            .unwrap_or_default();
        let text = format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- {{ name: admin, cluster: {{ server: \"{server}\" }} }}\nusers:\n- {{ name: admin, user: {{ token: t }} }}\ncontexts:\n- {{ name: admin, context: {{ cluster: admin, user: admin{ns} }} }}\ncurrent-context: admin\n"
        );
        let path = dir.join(file);
        std::fs::write(&path, text).unwrap();
        path
    }

    fn read(path: &Path) -> serde_yaml_ng::Value {
        serde_yaml_ng::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn names(doc: &serde_yaml_ng::Value, section: &str) -> Vec<String> {
        doc[section]
            .as_sequence()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn same_names_from_two_clusters_become_two_contexts() {
        let dir = tempfile::tempdir().unwrap();
        let a = one(dir.path(), "a.yaml", "https://a", Some("web"));
        let b = one(dir.path(), "b.yaml", "https://b", None);
        let dest = dir.path().join(CHAT_KUBECONFIG);
        write_chat_kubeconfig(&[("kind-a".into(), a), ("kind-b".into(), b)], &dest).unwrap();
        let doc = read(&dest);
        assert_eq!(names(&doc, "contexts"), ["kind-a", "kind-b"]);
        assert_eq!(names(&doc, "clusters"), ["kind-a", "kind-b"]);
        assert_eq!(names(&doc, "users"), ["kind-a", "kind-b"]);
        assert_eq!(doc["current-context"].as_str(), Some("kind-a"));
        let second = &doc["contexts"][1]["context"];
        assert_eq!(second["cluster"].as_str(), Some("kind-b"));
        assert_eq!(second["user"].as_str(), Some("kind-b"));
        assert_eq!(
            doc["contexts"][0]["context"]["namespace"].as_str(),
            Some("web")
        );
        assert_eq!(
            doc["clusters"][1]["cluster"]["server"].as_str(),
            Some("https://b")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_chat_kubeconfig_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let a = one(dir.path(), "a.yaml", "https://a", None);
        let dest = dir.path().join(CHAT_KUBECONFIG);
        write_chat_kubeconfig(&[("a".into(), a)], &dest).unwrap();
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn a_part_without_its_context_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.yaml");
        std::fs::write(&path, "apiVersion: v1\nkind: Config\ncontexts: []\n").unwrap();
        let dest = dir.path().join(CHAT_KUBECONFIG);
        assert!(write_chat_kubeconfig(&[("a".into(), path)], &dest).is_err());
        assert!(!dest.exists());
    }
}
