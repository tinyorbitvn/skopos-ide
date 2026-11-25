//! A YAML tab attached to a chat (YAML authoring spec A6 to A10): its types, the values hidden
//! from the agent's copy of its text, and putting them back into the agent's proposal.

use std::collections::BTreeSet;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use kube::core::discovery::Scope;
use kube::core::GroupVersionKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::app_core::AppCore;
use crate::kubeconfig::ClusterId;
use crate::resources::{parse_documents, ResourceRef};

/// What a hidden value reads as in the agent's copy.
pub const HIDDEN: &str = "(hidden)";
/// The longest tab text a prompt or a proposal carries (spec A7, A10).
pub const TAB_TEXT_CAP: usize = 65_536;
pub const HIDE_FAILED: &str =
    "The tab's Secret values could not be hidden from the agent, so nothing was sent.";
const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EditorTabMode {
    Create,
    Edit,
}

/// The object an edit tab edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditTarget {
    pub resource: ResourceRef,
    /// `None` for a cluster-scoped object.
    pub namespace: Option<String>,
    pub name: String,
}

/// A create or edit tab as a prompt carries it (spec A6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorTab {
    pub tab_id: String,
    pub title: String,
    pub cluster: ClusterId,
    pub mode: EditorTabMode,
    /// The tab's text as it is now.
    pub yaml: String,
    /// The edited object, in an edit tab.
    pub target: Option<EditTarget>,
    /// Where a create tab puts documents with no namespace.
    pub default_namespace: String,
}

/// The chip on the person's message: the tab it carried (spec A3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TabChip {
    pub tab_id: String,
    pub title: String,
}

/// One value the agent's copy shows as `(hidden)`.
#[derive(Debug, Clone, PartialEq)]
pub struct HiddenValue {
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    /// The mapping that holds the key: `["data"]`, `["metadata", "annotations"]`, …
    pub field: Vec<String>,
    pub key: String,
    /// The entry's lines as written, its key line first.
    pub lines: Vec<String>,
    /// The key line's indentation.
    pub indent: usize,
    /// The value as parsed, to check the restore.
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HiddenText {
    pub text: String,
    pub values: Vec<HiddenValue>,
}

/// The key of a `key: value` line with its indentation taken off, unquoted, and what follows
/// the colon.
fn split_key(line: &str) -> Option<(String, &str)> {
    let (name, after) = if let Some(rest) = line.strip_prefix('"') {
        let close = rest.find('"')?;
        (rest[..close].to_owned(), &rest[close + 1..])
    } else if let Some(rest) = line.strip_prefix('\'') {
        let close = rest.find('\'')?;
        (rest[..close].to_owned(), &rest[close + 1..])
    } else {
        if line.starts_with(['-', '#', '{', '[', '&', '*', '!', '|', '>', '%', '@', '`']) {
            return None;
        }
        let (colon, _) = line.match_indices(':').find(|(at, _)| {
            let next = &line[at + 1..];
            next.is_empty() || next.starts_with([' ', '\t'])
        })?;
        (line[..colon].trim_end().to_owned(), &line[colon..])
    };
    let rest = after.trim_start_matches([' ', '\t']).strip_prefix(':')?;
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    Some((name, rest.trim_start()))
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// One past the last line of the entry whose key is on `start`: the lines indented deeper,
/// and `- ` items at the key's own indentation.
fn entry_end(lines: &[String], start: usize, indent: usize) -> usize {
    let mut end = start + 1;
    for (at, line) in lines.iter().enumerate().skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let column = indent_of(line);
        if column > indent || (column == indent && (trimmed == "-" || trimmed.starts_with("- "))) {
            end = at + 1;
        } else {
            break;
        }
    }
    end
}

/// The lines of `key`'s entry in the block mapping at `path` from the document's top, and the
/// key line's indentation.
fn find_entry(lines: &[String], path: &[String], key: &str) -> Option<(usize, usize, usize)> {
    let mut open: Vec<(usize, String)> = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let line = &lines[at];
        let trimmed = line.trim_start();
        let Some((name, rest)) = split_key(trimmed) else {
            at += 1;
            continue;
        };
        let indent = indent_of(line);
        while open.last().is_some_and(|(column, _)| *column >= indent) {
            open.pop();
        }
        let end = entry_end(lines, at, indent);
        let here = open.len() == path.len() && open.iter().zip(path).all(|((_, a), b)| a == b);
        if here && name == key {
            return Some((at, end, indent));
        }
        if rest.starts_with(['|', '>']) {
            // A block scalar's lines are text, not keys.
            at = end;
            continue;
        }
        open.push((indent, name));
        at += 1;
    }
    None
}

fn is_mark(line: &str) -> bool {
    mark_rest(line).is_some()
}

/// What follows a `---` or `...` mark on its line, or `None` when the line is no mark.
fn mark_rest(line: &str) -> Option<&str> {
    ["---", "..."].iter().find_map(|mark| {
        line.strip_prefix(mark)
            .filter(|rest| rest.is_empty() || rest.starts_with([' ', '\t']))
    })
}

/// A mark line that also holds content, such as `--- {kind: Secret, …}` or `--- |`. A comment
/// alone is no content.
fn mark_has_content(line: &str) -> bool {
    mark_rest(line).is_some_and(|rest| {
        let rest = rest.trim_start();
        !rest.is_empty() && !rest.starts_with('#')
    })
}

/// The text's lines split into documents; each mark line is kept as its own part.
fn documents(text: &str) -> Vec<Vec<String>> {
    let mut parts = vec![Vec::new()];
    for line in text.split('\n') {
        if is_mark(line) {
            parts.push(vec![line.to_owned()]);
            parts.push(Vec::new());
        } else if let Some(last) = parts.last_mut() {
            last.push(line.to_owned());
        }
    }
    parts
}

fn identity(value: &Value) -> (String, Option<String>, String) {
    let text = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    (
        text("/kind").unwrap_or_default(),
        text("/metadata/namespace"),
        text("/metadata/name").unwrap_or_default(),
    )
}

/// A document of kind `Secret`, whatever its `apiVersion` says: a half-typed Secret still holds
/// Secret values.
fn is_secret(value: &Value) -> bool {
    value.get("kind").and_then(Value::as_str) == Some("Secret")
}

/// Secrets inside a document, which the lines do not hide: a `SecretList`, or an object of kind
/// `Secret` below the top, such as the `items` of a `List`.
fn nested_secret(value: &Value) -> bool {
    fn below(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.values().any(|child| is_secret(child) || below(child)),
            Value::Array(items) => items.iter().any(|item| is_secret(item) || below(item)),
            _ => false,
        }
    }
    value.get("kind").and_then(Value::as_str) == Some("SecretList") || below(value)
}

/// Whether the lines use a YAML anchor (`&name`) or alias (`*name`) outside quotes and
/// comments. An alias copies a value to another place, where hiding or restoring by key does not
/// follow it. A plain value such as `a &b` also counts, which only refuses the text.
fn has_anchor_or_alias(lines: &[String]) -> bool {
    lines.iter().any(|line| {
        let mut quote: Option<char> = None;
        let mut escaped = false;
        let mut previous = ' ';
        for c in line.chars() {
            match quote {
                Some('"') if escaped => escaped = false,
                Some('"') if c == '\\' => escaped = true,
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None if c == '#' && previous.is_whitespace() => break,
                None if c == '"' || c == '\'' => quote = Some(c),
                None if (c == '&' || c == '*')
                    && (previous.is_whitespace() || "-[{,:".contains(previous)) =>
                {
                    return true;
                }
                None => {}
            }
            previous = c;
        }
        false
    })
}

/// Whether a text uses YAML anchors or aliases; see [`has_anchor_or_alias`].
pub fn uses_anchors(text: &str) -> bool {
    let lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    has_anchor_or_alias(&lines)
}

fn mapping_at<'a>(
    value: &'a Value,
    field: &[String],
) -> Option<&'a serde_json::Map<String, Value>> {
    field
        .iter()
        .try_fold(value, |at, key| at.get(key))
        .and_then(Value::as_object)
}

fn set_at(value: &mut Value, field: &[String], key: &str, to: Value) {
    let mut at = value;
    for step in field {
        match at.get_mut(step) {
            Some(next) => at = next,
            None => return,
        }
    }
    if let Some(map) = at.as_object_mut() {
        map.insert(key.to_owned(), to);
    }
}

fn path(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

/// Where values are hidden in one parsed document.
fn wanted(value: &Value, hide_secrets: bool) -> Vec<(Vec<String>, String)> {
    let mut found = Vec::new();
    let annotations = path(&["metadata", "annotations"]);
    if mapping_at(value, &annotations).is_some_and(|map| map.contains_key(LAST_APPLIED)) {
        found.push((annotations, LAST_APPLIED.to_owned()));
    }
    let metadata = path(&["metadata"]);
    if mapping_at(value, &metadata).is_some_and(|map| map.contains_key("managedFields")) {
        found.push((metadata, "managedFields".to_owned()));
    }
    if hide_secrets && is_secret(value) {
        for field in ["data", "stringData"] {
            if let Some(map) = mapping_at(value, &path(&[field])) {
                found.extend(map.keys().map(|key| (path(&[field]), key.clone())));
            }
        }
    }
    found
}

fn parse_one(lines: &[String]) -> Option<Value> {
    serde_yaml_ng::from_str::<Value>(&lines.join("\n")).ok()
}

/// A `kind: Secret` or `kind: SecretList` line anywhere in the lines, indented or as a list
/// item, for text that does not parse.
fn looks_like_secret(lines: &[String]) -> bool {
    lines.iter().any(|line| {
        let content = line.trim_start().trim_start_matches(['-', ' ']);
        let kind = content.strip_prefix("kind:").map(|rest| {
            rest.split('#')
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches(['"', '\''])
        });
        matches!(kind, Some("Secret" | "SecretList"))
    })
}

/// Whether hiding must not fail for this document: Secret values are to be hidden and it is a
/// Secret, or it does not parse and has a `kind: Secret` line.
fn holds_secret_values(part: &[String], hide_secrets: bool) -> bool {
    hide_secrets
        && match parse_one(part) {
            Some(value) => is_secret(&value) || nested_secret(&value),
            None => looks_like_secret(part),
        }
}

/// A document whose Secret values the lines cannot hide even when it parses: Secrets nested
/// in it, or a Secret that uses anchors or aliases.
fn unhideable(part: &[String]) -> bool {
    parse_one(part).is_some_and(|value| {
        nested_secret(&value) || (is_secret(&value) && has_anchor_or_alias(part))
    })
}

/// The key of a `key: value` line as written, quotes included.
fn written_key(line: &str) -> Option<&str> {
    match line.chars().next()? {
        quote @ ('"' | '\'') => line[1..].find(quote).map(|close| &line[..close + 2]),
        _ => line.find(':').map(|colon| line[..colon].trim_end()),
    }
}

/// One document with its wanted values hidden, checked against its parse.
fn hide_document(
    lines: &[String],
    hide_secrets: bool,
) -> Result<(Vec<String>, Vec<HiddenValue>), ()> {
    let Some(original) = parse_one(lines) else {
        return Err(());
    };
    let wanted = wanted(&original, hide_secrets);
    let (kind, namespace, name) = identity(&original);
    let mut out = lines.to_vec();
    let mut values = Vec::new();
    let mut spans = Vec::new();
    for (field, key) in &wanted {
        let (start, end, indent) = find_entry(lines, field, key).ok_or(())?;
        let quoted_key = written_key(lines[start].trim_start()).ok_or(())?;
        let line = format!("{}{quoted_key}: {HIDDEN}", " ".repeat(indent));
        let value = mapping_at(&original, field)
            .and_then(|map| map.get(key))
            .cloned()
            .ok_or(())?;
        spans.push((start, end, line));
        values.push(HiddenValue {
            kind: kind.clone(),
            namespace: namespace.clone(),
            name: name.clone(),
            field: field.clone(),
            key: key.clone(),
            lines: lines[start..end].to_vec(),
            indent,
            value,
        });
    }
    spans.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    for (start, end, line) in spans {
        out.splice(start..end, [line]);
    }
    let mut expected = original.clone();
    for (field, key) in &wanted {
        set_at(&mut expected, field, key, Value::from(HIDDEN));
    }
    if hide_secrets && is_secret(&original) {
        for field in ["data", "stringData"] {
            if let Some(map) = expected.get_mut(field).and_then(Value::as_object_mut) {
                for value in map.values_mut() {
                    *value = Value::from(HIDDEN);
                }
            }
        }
    }
    if parse_one(&out) != Some(expected) {
        return Err(());
    }
    Ok((out, values))
}

/// The agent's copy of a tab's text (spec A8). The last-applied annotation and
/// `managedFields` read `(hidden)`, and with `hide_secrets` so does every value under a
/// Secret's `data` and `stringData`. Formatting and comments stay. With `hide_secrets`, the whole
/// text fails with `HIDE_FAILED` when a document holding Secret values cannot be hidden: content
/// on a `---` line, Secrets nested in a `List`, anchors or aliases in a Secret, or a Secret the
/// lines do not match.
pub fn hide_values(text: &str, hide_secrets: bool) -> Result<HiddenText, String> {
    let mut lines = Vec::new();
    let mut values = Vec::new();
    for part in documents(text) {
        if part.len() == 1 && is_mark(&part[0]) {
            if hide_secrets && mark_has_content(&part[0]) {
                return Err(HIDE_FAILED.to_owned());
            }
            lines.extend(part);
            continue;
        }
        if hide_secrets && unhideable(&part) {
            return Err(HIDE_FAILED.to_owned());
        }
        let critical = holds_secret_values(&part, hide_secrets);
        match hide_document(&part, hide_secrets) {
            Ok((hidden, found)) => {
                lines.extend(hidden);
                values.extend(found);
            }
            Err(()) if critical => return Err(HIDE_FAILED.to_owned()),
            Err(()) => lines.extend(part),
        }
    }
    Ok(HiddenText {
        text: lines.join("\n"),
        values,
    })
}

/// The agent's proposal with each `(hidden)` value put back from the tab's text (spec A10
/// step 4).
pub fn restore_values(text: &str, hidden: &[HiddenValue]) -> Result<String, String> {
    let mut lines = Vec::new();
    for part in documents(text) {
        if part.len() == 1 && is_mark(&part[0]) {
            lines.extend(part);
            continue;
        }
        let Some(proposed) = parse_one(&part) else {
            lines.extend(part);
            continue;
        };
        let (kind, namespace, name) = identity(&proposed);
        let mut spots = Vec::new();
        for (field, key) in wanted(&proposed, true) {
            let marked = mapping_at(&proposed, &field)
                .and_then(|map| map.get(&key))
                .and_then(Value::as_str)
                == Some(HIDDEN);
            if marked {
                spots.push((field, key));
            }
        }
        let mut out = part.clone();
        let mut restored = Vec::new();
        let mut spans = Vec::new();
        for (field, key) in spots {
            let original = hidden
                .iter()
                .find(|h| h.kind == kind && h.namespace == namespace && h.name == name && h.field == field && h.key == key)
                .ok_or_else(|| format!("The proposal has {HIDDEN} for {key} in {kind} {name}, which the tab's text did not have."))?;
            let (start, end, indent) = find_entry(&part, &field, &key).ok_or_else(|| {
                format!("The proposal's {HIDDEN} value for {key} could not be put back.")
            })?;
            let moved: Vec<String> = original
                .lines
                .iter()
                .map(|line| {
                    let kept = line.trim_start_matches(' ');
                    let spaces = indent_of(line);
                    let wanted = (spaces + indent).saturating_sub(original.indent);
                    if kept.is_empty() {
                        String::new()
                    } else {
                        format!("{}{kept}", " ".repeat(wanted))
                    }
                })
                .collect();
            spans.push((start, end, moved));
            restored.push((field, key, original.value.clone()));
        }
        spans.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
        for (start, end, moved) in spans {
            out.splice(start..end, moved);
        }
        let check = parse_one(&out);
        for (field, key, value) in &restored {
            let back = check
                .as_ref()
                .and_then(|v| mapping_at(v, field))
                .and_then(|map| map.get(key));
            if back != Some(value) {
                return Err(format!(
                    "The proposal's {HIDDEN} value for {key} could not be put back."
                ));
            }
        }
        lines.extend(out);
    }
    Ok(lines.join("\n"))
}

/// Every `namespace:` value written in the lines, at any depth, for a document that does not
/// parse: it counts all of them rather than none.
fn named_namespaces(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|line| {
            let content = line.trim_start().trim_start_matches(['-', ' ']);
            let rest = content.strip_prefix("namespace:")?;
            let value = rest.split('#').next().unwrap_or_default().trim();
            let value = value.trim_matches(['"', '\'']);
            (!value.is_empty()).then(|| value.to_owned())
        })
        .collect()
}

/// A message for the agent with each hidden value taken out (spec A8), such as a dry run's
/// error about a proposal whose `(hidden)` values were put back. A value is replaced as written,
/// as JSON escapes it (servers quote values that way), and for `data` also decoded from base64.
/// Texts shorter than four characters stay: replacing them would garble the message more than it
/// hides.
pub fn redact(message: &str, hidden: &[HiddenValue]) -> String {
    let mut texts: Vec<String> = Vec::new();
    let mut add = |text: String| {
        if let Ok(quoted) = serde_json::to_string(&text) {
            texts.push(quoted.trim_matches('"').to_owned());
        }
        texts.push(text);
    };
    for value in hidden {
        let Some(text) = value.value.as_str() else {
            continue;
        };
        if value.field.first().map(String::as_str) == Some("data") {
            if let Some(decoded) = STANDARD
                .decode(text.trim())
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
            {
                add(decoded);
            }
        }
        add(text.to_owned());
    }
    texts.retain(|text| text.chars().count() >= 4);
    texts.sort_by_key(|text| std::cmp::Reverse(text.len()));
    let mut out = message.to_owned();
    for text in &texts {
        out = out.replace(text.as_str(), HIDDEN);
    }
    out
}

/// The namespaces one parsed document reaches: its `metadata.namespace`, or the default
/// namespace when its kind is namespaced, and the same for each object of a `List`'s `items`.
fn document_namespaces(
    document: &Value,
    default_namespace: &str,
    namespaced: &dyn Fn(&str, &str) -> bool,
    found: &mut BTreeSet<String>,
) {
    if let Some(items) = document.get("items").and_then(Value::as_array) {
        for item in items.iter().filter(|item| item.is_object()) {
            document_namespaces(item, default_namespace, namespaced, found);
        }
    }
    if let Some(namespace) = document
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
    {
        found.insert(namespace.to_owned());
        return;
    }
    let api_version = document
        .get("apiVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let kind = document
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if namespaced(api_version, kind) {
        found.insert(default_namespace.to_owned());
    }
}

/// The namespaces a text reaches. `namespaced(apiVersion, kind)` says whether a kind is
/// namespaced. Text that does not parse is read document by document; a document that still
/// does not parse counts the default namespace and every `namespace:` value it names.
fn text_namespaces(
    yaml: &str,
    default_namespace: &str,
    namespaced: &dyn Fn(&str, &str) -> bool,
) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let parsed = match parse_documents(yaml) {
        Ok(parsed) => parsed,
        Err(_) => {
            let mut parsed = Vec::new();
            for part in documents(yaml) {
                if part.len() == 1 && is_mark(&part[0]) {
                    if mark_has_content(&part[0]) {
                        found.insert(default_namespace.to_owned());
                        found.extend(named_namespaces(&part));
                    }
                    continue;
                }
                match parse_one(&part) {
                    Some(Value::Null) => {}
                    Some(value @ Value::Object(_)) => parsed.push(value),
                    _ => {
                        found.insert(default_namespace.to_owned());
                        found.extend(named_namespaces(&part));
                    }
                }
            }
            parsed
        }
    };
    for document in &parsed {
        document_namespaces(document, default_namespace, namespaced, &mut found);
    }
    found
}

/// The namespaces a tab's text reaches (spec A7): the edited object's, each document's
/// `metadata.namespace` (and that of each `List` item), and the default namespace for a
/// namespaced document without one. A kind the cluster does not serve counts as namespaced.
/// Text that does not parse counts every namespace it names, and the default namespace.
pub fn tab_namespaces(core: &AppCore, tab: &EditorTab) -> Vec<String> {
    let discovery = core.cluster_discovery(&tab.cluster).ok();
    let namespaced = |api_version: &str, kind: &str| {
        let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
        let gvk = GroupVersionKind::gvk(group, version, kind);
        discovery
            .as_ref()
            .and_then(|discovery| discovery.resolve_gvk(&gvk))
            .is_none_or(|(_, capabilities)| capabilities.scope == Scope::Namespaced)
    };
    let mut found = text_namespaces(&tab.yaml, &tab.default_namespace, &namespaced);
    if let Some(namespace) = tab
        .target
        .as_ref()
        .and_then(|target| target.namespace.clone())
    {
        found.insert(namespace);
    }
    found.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"data\":{\"password\":\"c2VjcmV0\"}}\n    team: data\ntype: Opaque\ndata:\n  password: c2VjcmV0 # base64\n  \"user.name\": YWRtaW4=\nstringData:\n  script: |\n    #!/bin/sh\n    echo hi\n    # last line\n";

    #[test]
    fn secret_values_and_the_last_applied_annotation_become_hidden_with_their_keys_kept() {
        let hidden = hide_values(SECRET, true).unwrap();
        assert_eq!(
            hidden.text,
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: (hidden)\n    team: data\ntype: Opaque\ndata:\n  password: (hidden)\n  \"user.name\": (hidden)\nstringData:\n  script: (hidden)\n"
        );
        assert_eq!(hidden.values.len(), 4);
        assert!(!hidden.text.contains("c2VjcmV0"));
        assert!(!hidden.text.contains("last line"));
    }

    #[test]
    fn readable_secret_values_stay_and_the_annotation_still_goes() {
        let hidden = hide_values(SECRET, false).unwrap();
        assert!(hidden.text.contains("password: c2VjcmV0 # base64"));
        assert!(hidden.text.contains("last-applied-configuration: (hidden)"));
        assert_eq!(hidden.values.len(), 1);
    }

    #[test]
    fn other_kinds_keep_their_data_and_lose_managed_fields() {
        let text = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  managedFields:\n  - manager: kubectl\n    operation: Update\ndata:\n  a: b\n";
        let hidden = hide_values(text, true).unwrap();
        assert_eq!(hidden.text, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  managedFields: (hidden)\ndata:\n  a: b\n");
    }

    #[test]
    fn a_secret_the_lines_cannot_hide_fails_closed() {
        let flow =
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata: {password: c2VjcmV0}\n";
        assert_eq!(hide_values(flow, true).unwrap_err(), HIDE_FAILED);
        let broken =
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  password: [unclosed\n";
        assert_eq!(hide_values(broken, true).unwrap_err(), HIDE_FAILED);
        assert!(hide_values(flow, false).is_ok());
    }

    #[test]
    fn a_document_on_its_mark_line_fails_closed_while_values_are_hidden() {
        let text = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n--- {apiVersion: v1, kind: Secret, metadata: {name: s}, data: {password: c2VjcmV0}}\n";
        assert_eq!(hide_values(text, true).unwrap_err(), HIDE_FAILED);
        assert!(hide_values(text, false).is_ok());
        let comment = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n--- # next\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: d\n";
        assert_eq!(hide_values(comment, true).unwrap().text, comment);
    }

    #[test]
    fn secrets_inside_a_list_fail_closed_while_values_are_hidden() {
        let list = "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: s\n  data:\n    password: c2VjcmV0\n";
        assert_eq!(hide_values(list, true).unwrap_err(), HIDE_FAILED);
        let secret_list = "apiVersion: v1\nkind: SecretList\nitems:\n- metadata:\n    name: s\n  data:\n    password: c2VjcmV0\n";
        assert_eq!(hide_values(secret_list, true).unwrap_err(), HIDE_FAILED);
        let broken = "apiVersion: v1\nkind: List\nitems:\n- kind: Secret\n  data:\n    password: [unclosed\n";
        assert_eq!(hide_values(broken, true).unwrap_err(), HIDE_FAILED);
        assert!(hide_values(list, false).is_ok());
    }

    #[test]
    fn a_secret_without_its_api_version_is_still_hidden() {
        let text = "kind: Secret\nmetadata:\n  name: s\ndata:\n  password: c2VjcmV0\n";
        let hidden = hide_values(text, true).unwrap();
        assert!(!hidden.text.contains("c2VjcmV0"), "{}", hidden.text);
    }

    #[test]
    fn a_secret_with_anchors_or_aliases_fails_closed_while_values_are_hidden() {
        let text = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  labels:\n    copy: &p c2VjcmV0\ndata:\n  password: *p\n";
        assert_eq!(hide_values(text, true).unwrap_err(), HIDE_FAILED);
        assert!(uses_anchors("a: &x 1\nb: *x\n"));
        assert!(uses_anchors("- <<: *base\n"));
        assert!(!uses_anchors(
            "a: \"*.example.com\"\nb: x&y # see *z\nc: '&q'\n"
        ));
    }

    #[test]
    fn redact_takes_hidden_values_out_of_a_message() {
        let hidden = hide_values(SECRET, true).unwrap();
        let message = "Invalid value: \"c2VjcmV0\", decoded secret, and \"#!/bin/sh\\necho hi\\n# last line\\n\" in key ab";
        let out = redact(message, &hidden.values);
        assert!(!out.contains("c2VjcmV0"), "{out}");
        assert!(!out.contains("secret"), "{out}");
        assert!(!out.contains("echo hi"), "{out}");
        assert!(out.contains("in key ab"), "{out}");
    }

    #[test]
    fn namespaces_of_text_that_does_not_parse_count_every_namespace_it_names() {
        let namespaced = |_: &str, kind: &str| kind != "Namespace";
        let text = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: shop\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: payments\ndata:\n  password: [unclosed\n";
        let found: Vec<String> = text_namespaces(text, "default", &namespaced)
            .into_iter()
            .collect();
        assert_eq!(found, ["default", "payments", "shop"]);
    }

    #[test]
    fn namespaces_of_list_items_are_counted() {
        let namespaced = |_: &str, kind: &str| kind != "Namespace";
        let text = "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: ConfigMap\n  metadata:\n    name: a\n    namespace: payments\n- apiVersion: v1\n  kind: Namespace\n  metadata:\n    name: n\n";
        let found: Vec<String> = text_namespaces(text, "default", &namespaced)
            .into_iter()
            .collect();
        assert_eq!(found, ["default", "payments"]);
    }

    #[test]
    fn text_that_does_not_parse_and_is_no_secret_is_sent_as_it_is() {
        let text = "apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: [\n";
        assert_eq!(hide_values(text, true).unwrap().text, text);
    }

    #[test]
    fn several_documents_are_each_handled() {
        let text = format!(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  a: b\n---\n{SECRET}"
        );
        let hidden = hide_values(&text, true).unwrap();
        assert!(hidden.text.starts_with(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  a: b\n---\n"
        ));
        assert_eq!(hidden.values.len(), 4);
    }

    #[test]
    fn restoring_the_agents_copy_gives_back_the_original_text() {
        let hidden = hide_values(SECRET, true).unwrap();
        assert_eq!(
            restore_values(&hidden.text, &hidden.values).unwrap(),
            SECRET
        );
    }

    #[test]
    fn restored_values_follow_the_proposals_indentation_and_changes() {
        let hidden = hide_values(SECRET, true).unwrap();
        let proposal = "apiVersion: v1\nkind: Secret\nmetadata:\n    name: db\n    namespace: shop\n    labels:\n        tier: db\ntype: Opaque\ndata:\n    password: (hidden)\nstringData:\n    script: (hidden)\n";
        let restored = restore_values(proposal, &hidden.values).unwrap();
        let value: serde_json::Value = serde_yaml_ng::from_str(&restored).unwrap();
        assert_eq!(value["data"], json!({ "password": "c2VjcmV0" }));
        assert_eq!(
            value["stringData"]["script"],
            "#!/bin/sh\necho hi\n# last line\n"
        );
        assert_eq!(value["metadata"]["labels"]["tier"], "db");
    }

    #[test]
    fn a_hidden_marker_the_tab_did_not_have_is_an_error() {
        let hidden = hide_values(SECRET, true).unwrap();
        let other_key = SECRET.replace(
            "data:\n  password: c2VjcmV0 # base64",
            "data:\n  token: (hidden)",
        );
        let error = restore_values(&other_key, &hidden.values).unwrap_err();
        assert_eq!(
            error,
            "The proposal has (hidden) for token in Secret db, which the tab's text did not have."
        );
        let other_secret = hidden.text.replace("name: db", "name: cache");
        assert!(restore_values(&other_secret, &hidden.values).is_err());
    }

    #[test]
    fn editor_tabs_cross_to_the_webview_in_camel_case() {
        let tab: EditorTab = serde_json::from_value(json!({
            "tabId": "create-1", "title": "Create", "cluster": "c1", "mode": "create",
            "yaml": "a: b\n", "target": null, "defaultNamespace": "default",
        }))
        .unwrap();
        assert_eq!(tab.mode, EditorTabMode::Create);
        assert_eq!(
            serde_json::to_value(TabChip {
                tab_id: "t".into(),
                title: "T".into()
            })
            .unwrap(),
            json!({ "tabId": "t", "title": "T" })
        );
    }
}
