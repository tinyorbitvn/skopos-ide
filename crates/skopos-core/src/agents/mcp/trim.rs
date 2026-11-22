//! What a read returns to the agent: objects trimmed as spec §4.4 and §4.5 say, the
//! namespace limit, and the 64 KiB cap on every result.

use serde_json::Value;

use crate::prefs::ClusterAgentSettings;
use crate::resources::strip_for_list;

/// Every result the agent gets is at most this many bytes (spec §7).
pub const RESULT_CAP: usize = 65_536;
/// Kept free under the cap for the line a list or a cut text ends with.
const NOTE_ROOM: usize = 256;
const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
const DOCUMENT_SEPARATOR: &str = "---\n";
/// Ends an object or a release cut at the cap. A YAML comment, so the rest still reads.
const CUT_NOTE: &str = "# The rest is cut: a result holds at most 64 KiB.";

/// Removes `managedFields` and the last-applied annotation, which can quote a Secret's
/// values, and blanks a core `v1` Secret's `data` and `stringData` values, keys kept,
/// unless `reveal_secrets`. The object must carry the `kind` and `apiVersion` of the
/// resource it was read as.
pub fn trim_object(object: &mut Value, reveal_secrets: bool) {
    if !reveal_secrets {
        strip_for_list(object);
        return;
    }
    if let Some(metadata) = object.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove("managedFields");
        if let Some(annotations) = metadata
            .get_mut("annotations")
            .and_then(Value::as_object_mut)
        {
            annotations.remove(LAST_APPLIED);
        }
    }
}

/// Whether the cluster's namespace limit lets agents see `namespace`. No limit sees all.
pub fn namespace_allowed(settings: &ClusterAgentSettings, namespace: &str) -> bool {
    settings
        .namespaces
        .as_ref()
        .is_none_or(|allowed| allowed.iter().any(|name| name == namespace))
}

/// Joins YAML documents, each after a `---` line, while they fit under the cap with room
/// for a closing line. Returns the text and how many fit.
pub fn cap_items(items: Vec<String>) -> (String, usize) {
    let budget = RESULT_CAP - NOTE_ROOM;
    let mut text = String::new();
    let mut fit = 0;
    for item in items {
        if text.len() + DOCUMENT_SEPARATOR.len() + item.len() > budget {
            break;
        }
        text.push_str(DOCUMENT_SEPARATOR);
        text.push_str(&item);
        fit += 1;
    }
    (text, fit)
}

/// A list's result: the items that fit, and when fewer than `total` are shown, the
/// line that says so, as a document of its own.
pub fn list_text(items: Vec<String>, total: usize) -> String {
    let (mut text, fit) = cap_items(items);
    if fit < total {
        text.push_str(DOCUMENT_SEPARATOR);
        text.push_str(&format!(
            "Showing {fit} of {total}. Narrow the selector or the namespace.\n"
        ));
    }
    text
}

/// The last lines that fit under the cap, each ending in a newline. A last line longer
/// than the cap keeps its end.
pub fn cap_lines(lines: Vec<String>) -> String {
    let mut used = 0;
    let mut start = lines.len();
    while start > 0 {
        let size = lines[start - 1].len() + 1;
        if used + size > RESULT_CAP {
            break;
        }
        used += size;
        start -= 1;
    }
    if start == lines.len() {
        return match lines.last() {
            Some(last) => {
                let mut cut = last.len() - (RESULT_CAP - 1);
                while !last.is_char_boundary(cut) {
                    cut += 1;
                }
                format!("{}\n", &last[cut..])
            }
            None => String::new(),
        };
    }
    let mut text = String::with_capacity(used);
    for line in &lines[start..] {
        text.push_str(line);
        text.push('\n');
    }
    text
}

/// The text whole when it fits; otherwise its lines that fit, then `CUT_NOTE`.
pub fn cap_text(text: String) -> String {
    if text.len() <= RESULT_CAP {
        return text;
    }
    let mut cut = RESULT_CAP - NOTE_ROOM;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let end = text[..cut].rfind('\n').map_or(cut, |at| at + 1);
    format!("{}{CUT_NOTE}\n", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn secret() -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": "db",
                "managedFields": [{ "manager": "kubectl" }],
                "annotations": {
                    LAST_APPLIED: "{\"data\":{\"password\":\"c2VjcmV0\"}}",
                    "team": "shop",
                },
            },
            "data": { "password": "c2VjcmV0" },
            "stringData": { "token": "plain" },
        })
    }

    #[test]
    fn hidden_secret_values_are_blanked_with_their_keys_kept() {
        let mut object = secret();
        trim_object(&mut object, false);
        assert_eq!(object["data"], json!({ "password": "" }));
        assert_eq!(object["stringData"], json!({ "token": "" }));
        assert_eq!(
            object["metadata"],
            json!({ "name": "db", "annotations": { "team": "shop" } })
        );
    }

    #[test]
    fn readable_secret_values_stay_and_the_rest_is_trimmed() {
        let mut object = secret();
        trim_object(&mut object, true);
        assert_eq!(object["data"], json!({ "password": "c2VjcmV0" }));
        assert_eq!(object["stringData"], json!({ "token": "plain" }));
        assert_eq!(
            object["metadata"],
            json!({ "name": "db", "annotations": { "team": "shop" } })
        );
    }

    #[test]
    fn other_kinds_keep_their_values() {
        let mut object = json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": { "name": "app" },
            "data": { "greeting": "hello" },
        });
        trim_object(&mut object, false);
        assert_eq!(object["data"], json!({ "greeting": "hello" }));
    }

    #[test]
    fn a_namespace_limit_allows_only_its_namespaces() {
        let open = ClusterAgentSettings::default();
        assert!(namespace_allowed(&open, "default"));
        let limited = ClusterAgentSettings {
            namespaces: Some(vec!["shop".to_owned()]),
            ..ClusterAgentSettings::default()
        };
        assert!(namespace_allowed(&limited, "shop"));
        assert!(!namespace_allowed(&limited, "default"));
        assert!(!namespace_allowed(&limited, ""));
    }

    #[test]
    fn items_are_joined_as_documents_while_they_fit() {
        assert_eq!(
            cap_items(vec!["a: 1\n".to_owned(), "b: 2\n".to_owned()]),
            ("---\na: 1\n---\nb: 2\n".to_owned(), 2)
        );
        let big = format!("a: {}\n", "x".repeat(30_000));
        let (text, fit) = cap_items(vec![big.clone(), big.clone(), big]);
        assert_eq!(fit, 2);
        assert!(text.len() <= RESULT_CAP - NOTE_ROOM, "{}", text.len());
        assert!(text.starts_with("---\na: x"));
    }

    #[test]
    fn a_list_says_how_many_items_it_shows() {
        assert_eq!(
            list_text(vec!["a: 1\n".to_owned()], 3),
            "---\na: 1\n---\nShowing 1 of 3. Narrow the selector or the namespace.\n"
        );
        assert_eq!(list_text(vec!["a: 1\n".to_owned()], 1), "---\na: 1\n");
        assert_eq!(list_text(Vec::new(), 0), "");
    }

    #[test]
    fn logs_keep_the_last_lines_that_fit() {
        let lines: Vec<String> = (0..100)
            .map(|n| format!("{n:03} {}", "x".repeat(996)))
            .collect();
        let text = cap_lines(lines);
        assert!(text.len() <= RESULT_CAP, "{}", text.len());
        assert_eq!(text.lines().count(), 65);
        assert!(text.starts_with("035 x"), "{}", &text[..8]);
        assert!(text.ends_with("x\n"));
        assert!(text.lines().last().unwrap().starts_with("099 "));
        assert_eq!(cap_lines(Vec::new()), "");
        assert_eq!(cap_lines(vec!["a".to_owned(), "b".to_owned()]), "a\nb\n");
    }

    #[test]
    fn a_line_longer_than_the_cap_keeps_its_end() {
        let line = format!("{}end", "a".repeat(70_000));
        let text = cap_lines(vec!["first".to_owned(), line]);
        assert_eq!(text.len(), RESULT_CAP);
        assert!(text.ends_with("aend\n"));
    }

    #[test]
    fn a_long_text_is_cut_at_a_line_and_says_so() {
        assert_eq!(cap_text("a: 1\n".to_owned()), "a: 1\n");
        let text: String = (0..2_000)
            .map(|n| format!("key{n}: {}\n", "v".repeat(60)))
            .collect();
        let cut = cap_text(text.clone());
        assert!(cut.len() <= RESULT_CAP, "{}", cut.len());
        let kept = cut
            .strip_suffix(&format!("{CUT_NOTE}\n"))
            .expect("the note ends the text");
        assert!(kept.ends_with('\n'));
        assert!(text.starts_with(kept));
    }
}
