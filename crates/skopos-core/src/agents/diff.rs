//! The diff a change card shows (spec §4.5): the changed lines of the YAML of the trimmed
//! objects, with status and server-set metadata left out, two lines of context around each
//! change, and at most 40 lines before one `… <n> more lines`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Lines kept on each side of a changed line.
const CONTEXT: usize = 2;
/// Lines a diff shows before its `More` line.
const SHOWN: usize = 40;
/// Past this many cells of the matching table, the changed middle is shown as removed and
/// added whole instead of matched line by line.
const TABLE_CELLS: usize = 4_000_000;
/// The metadata the API server sets, which no change does.
const SERVER_SET: [&str; 5] = [
    "resourceVersion",
    "uid",
    "generation",
    "creationTimestamp",
    "managedFields",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    Context,
    Added,
    Removed,
    /// `… <n> more lines`, always last.
    More,
}

/// One line of a change card's diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

/// What happens to one line on the way from the old text to the new.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Edit {
    Same,
    Removed,
    Added,
}

/// The lines that change from `before` to `after`, with their context. `before` is `null` for
/// an object that does not exist yet, which makes every line added.
pub fn yaml_diff(before: &Value, after: &Value) -> Vec<DiffLine> {
    let old = yaml_lines(before);
    let new = yaml_lines(after);
    shown(with_context(&edit_script(&old, &new, TABLE_CELLS)))
}

/// The object without `status` and the server-set metadata.
fn comparable(object: &Value) -> Value {
    let mut object = object.clone();
    if let Some(fields) = object.as_object_mut() {
        fields.remove("status");
        if let Some(metadata) = fields.get_mut("metadata").and_then(Value::as_object_mut) {
            for field in SERVER_SET {
                metadata.remove(field);
            }
        }
    }
    object
}

fn yaml_lines(object: &Value) -> Vec<String> {
    if object.is_null() {
        return Vec::new();
    }
    serde_yaml_ng::to_string(&comparable(object))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// Every line of both texts, in order, marked as kept, removed or added. The lines both texts
/// start and end with are kept; the ones between are matched by their longest common
/// subsequence when its table has at most `cells` cells.
fn edit_script<'a>(old: &'a [String], new: &'a [String], cells: usize) -> Vec<(Edit, &'a str)> {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let mut script: Vec<(Edit, &'a str)> = old[..prefix]
        .iter()
        .map(|line| (Edit::Same, line.as_str()))
        .collect();
    script.extend(middle(
        &old[prefix..old.len() - suffix],
        &new[prefix..new.len() - suffix],
        cells,
    ));
    script.extend(
        old[old.len() - suffix..]
            .iter()
            .map(|line| (Edit::Same, line.as_str())),
    );
    script
}

fn middle<'a>(old: &'a [String], new: &'a [String], cells: usize) -> Vec<(Edit, &'a str)> {
    let removed = |line: &'a String| (Edit::Removed, line.as_str());
    let added = |line: &'a String| (Edit::Added, line.as_str());
    if old.len().saturating_mul(new.len()) > cells {
        return old
            .iter()
            .map(removed)
            .chain(new.iter().map(added))
            .collect();
    }
    let width = new.len() + 1;
    // common[i * width + j]: how many lines `old[i..]` and `new[j..]` share, in order.
    let mut common = vec![0u32; (old.len() + 1) * width];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            common[i * width + j] = if old[i] == new[j] {
                common[(i + 1) * width + j + 1] + 1
            } else {
                common[(i + 1) * width + j].max(common[i * width + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut script = Vec::with_capacity(old.len() + new.len());
    while i < old.len() && j < new.len() {
        if old[i] == new[j] {
            script.push((Edit::Same, old[i].as_str()));
            i += 1;
            j += 1;
        } else if common[(i + 1) * width + j] >= common[i * width + j + 1] {
            script.push(removed(&old[i]));
            i += 1;
        } else {
            script.push(added(&new[j]));
            j += 1;
        }
    }
    script.extend(old[i..].iter().map(removed));
    script.extend(new[j..].iter().map(added));
    script
}

/// The changed lines and the `CONTEXT` lines on each side of them.
fn with_context(script: &[(Edit, &str)]) -> Vec<DiffLine> {
    let mut keep = vec![false; script.len()];
    for (index, (edit, _)) in script.iter().enumerate() {
        if *edit != Edit::Same {
            let end = (index + CONTEXT).min(script.len() - 1);
            keep[index.saturating_sub(CONTEXT)..=end].fill(true);
        }
    }
    script
        .iter()
        .zip(keep)
        .filter(|(_, kept)| *kept)
        .map(|((edit, text), _)| DiffLine {
            kind: match edit {
                Edit::Same => DiffKind::Context,
                Edit::Removed => DiffKind::Removed,
                Edit::Added => DiffKind::Added,
            },
            text: (*text).to_owned(),
        })
        .collect()
}

/// At most `SHOWN` lines, then one line that counts the rest.
fn shown(mut lines: Vec<DiffLine>) -> Vec<DiffLine> {
    if lines.len() > SHOWN {
        let more = lines.len() - SHOWN;
        lines.truncate(SHOWN);
        let noun = if more == 1 { "line" } else { "lines" };
        lines.push(DiffLine {
            kind: DiffKind::More,
            text: format!("… {more} more {noun}"),
        });
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(kind: DiffKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.to_owned(),
        }
    }

    /// Keys named so that sorted and inserted orders agree, whichever map `serde_json` uses.
    fn keys(count: usize, value: i32) -> Value {
        (0..count)
            .map(|i| (format!("k{i:02}"), json!(value)))
            .collect::<serde_json::Map<_, _>>()
            .into()
    }

    #[test]
    fn a_changed_value_shows_two_lines_of_context_on_each_side() {
        let before = json!({ "a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 7 });
        let mut after = before.clone();
        after["d"] = json!(40);
        assert_eq!(
            yaml_diff(&before, &after),
            [
                line(DiffKind::Context, "b: 2"),
                line(DiffKind::Context, "c: 3"),
                line(DiffKind::Removed, "d: 4"),
                line(DiffKind::Added, "d: 40"),
                line(DiffKind::Context, "e: 5"),
                line(DiffKind::Context, "f: 6"),
            ]
        );
    }

    #[test]
    fn far_apart_changes_keep_only_their_own_context() {
        let before = keys(20, 0);
        let mut after = before.clone();
        after["k02"] = json!(1);
        after["k15"] = json!(1);
        assert_eq!(
            yaml_diff(&before, &after),
            [
                line(DiffKind::Context, "k00: 0"),
                line(DiffKind::Context, "k01: 0"),
                line(DiffKind::Removed, "k02: 0"),
                line(DiffKind::Added, "k02: 1"),
                line(DiffKind::Context, "k03: 0"),
                line(DiffKind::Context, "k04: 0"),
                line(DiffKind::Context, "k13: 0"),
                line(DiffKind::Context, "k14: 0"),
                line(DiffKind::Removed, "k15: 0"),
                line(DiffKind::Added, "k15: 1"),
                line(DiffKind::Context, "k16: 0"),
                line(DiffKind::Context, "k17: 0"),
            ]
        );
    }

    #[test]
    fn status_and_server_set_metadata_are_left_out() {
        let before = json!({
            "metadata": {
                "name": "web", "resourceVersion": "1", "uid": "u", "generation": 1,
                "creationTimestamp": "2026-01-01T00:00:00Z",
                "managedFields": [{ "manager": "kubectl" }],
            },
            "spec": { "replicas": 1 },
            "status": { "readyReplicas": 1 },
        });
        let mut after = before.clone();
        after["metadata"]["resourceVersion"] = json!("2");
        after["metadata"]["generation"] = json!(2);
        after["metadata"]["managedFields"] = json!([{ "manager": "skopos-agent" }]);
        after["status"]["readyReplicas"] = json!(3);
        assert!(yaml_diff(&before, &after).is_empty());
        after["spec"]["replicas"] = json!(3);
        let diff = yaml_diff(&before, &after);
        assert!(
            diff.contains(&line(DiffKind::Removed, "  replicas: 1")),
            "{diff:?}"
        );
        assert!(
            diff.contains(&line(DiffKind::Added, "  replicas: 3")),
            "{diff:?}"
        );
        assert!(
            diff.iter().all(|l| !l.text.contains("resourceVersion")
                && !l.text.contains("readyReplicas")
                && !l.text.contains("manager")),
            "{diff:?}"
        );
    }

    #[test]
    fn a_new_object_is_all_added() {
        let after = json!({ "kind": "ConfigMap", "data": { "a": "one" } });
        let diff = yaml_diff(&Value::Null, &after);
        assert!(diff.iter().all(|l| l.kind == DiffKind::Added), "{diff:?}");
        assert!(
            diff.contains(&line(DiffKind::Added, "  a: one")),
            "{diff:?}"
        );
    }

    #[test]
    fn the_same_object_has_no_diff() {
        let object = json!({ "a": { "b": [1, 2] } });
        assert!(yaml_diff(&object, &object).is_empty());
    }

    #[test]
    fn more_than_forty_lines_end_with_a_more_line() {
        let diff = yaml_diff(&keys(60, 0), &keys(60, 1));
        assert_eq!(diff.len(), 41);
        assert_eq!(diff[40], line(DiffKind::More, "… 80 more lines"));
        assert!(diff[..40].iter().all(|l| l.kind != DiffKind::More));
    }

    #[test]
    fn one_line_over_the_limit_is_counted_in_the_singular() {
        let diff = yaml_diff(&keys(21, 0), &keys(20, 1));
        assert_eq!(diff.len(), 41);
        assert_eq!(diff[40], line(DiffKind::More, "… 1 more line"));
    }

    #[test]
    fn a_table_too_large_removes_the_old_lines_and_adds_the_new() {
        let old = ["a", "b", "c"].map(String::from);
        let new = ["c", "a"].map(String::from);
        assert_eq!(
            edit_script(&old, &new, 0),
            [
                (Edit::Removed, "a"),
                (Edit::Removed, "b"),
                (Edit::Removed, "c"),
                (Edit::Added, "c"),
                (Edit::Added, "a"),
            ]
        );
        let matched = edit_script(&old, &new, TABLE_CELLS);
        assert_eq!(
            matched
                .iter()
                .filter(|(edit, _)| *edit == Edit::Same)
                .count(),
            1
        );
    }

    #[test]
    fn diff_lines_cross_to_the_webview_in_camel_case() {
        assert_eq!(
            serde_json::to_value(line(DiffKind::Removed, "a: 1")).unwrap(),
            json!({ "kind": "removed", "text": "a: 1" })
        );
    }
}
