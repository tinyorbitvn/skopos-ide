//! What a save dialog offers. The page asks for a file to be saved and suggests a name; the
//! user picks the place in a dialog of the system's, which the page cannot answer. So a page
//! never names the path a command writes to.

/// One kind of file the app saves: the filter's label and the extensions it lists. The
/// first extension is the one a name gets when it has none of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveKind {
    pub label: &'static str,
    pub extensions: &'static [&'static str],
}

pub const LOG: SaveKind = SaveKind {
    label: "Log",
    extensions: &["log", "txt"],
};
pub const KUBECONFIG: SaveKind = SaveKind {
    label: "Kubeconfig",
    extensions: &["kubeconfig", "yaml"],
};
pub const PNG: SaveKind = SaveKind {
    label: "PNG image",
    extensions: &["png"],
};
pub const PDF: SaveKind = SaveKind {
    label: "PDF document",
    extensions: &["pdf"],
};

/// Long enough for any name the app suggests, and short enough for every file system.
const MAX_NAME_CHARS: usize = 100;

/// The name of a suggestion that leaves none.
const FALLBACK: &str = "download";
/// What Windows refuses in a file name. A separator never gets this far.
const FORBIDDEN: [char; 7] = ['<', '>', ':', '"', '|', '?', '*'];

/// The name the dialog starts with: the page's suggestion as a bare file name of this kind.
/// Only the last part of a path is read, the name is neither hidden nor one a system
/// refuses, and it ends in one of the kind's extensions.
pub fn suggested_file_name(raw: &str, kind: &SaveKind) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if FORBIDDEN.contains(&c) { '-' } else { c })
        .collect();
    let name = cleaned.trim_matches(is_edge);
    let own = name.rsplit_once('.').filter(|(stem, found)| {
        !stem.is_empty()
            && kind
                .extensions
                .iter()
                .any(|ext| found.eq_ignore_ascii_case(ext))
    });
    let (stem, extension) =
        own.unwrap_or((name, kind.extensions.first().copied().unwrap_or_default()));
    let room = MAX_NAME_CHARS.saturating_sub(extension.chars().count() + 1);
    let stem: String = stem.chars().take(room).collect();
    let stem = stem.trim_end_matches(is_edge);
    let stem = if stem.is_empty() { FALLBACK } else { stem };
    format!("{stem}.{extension}")
}

/// A leading dot hides a file, and Windows refuses a name that ends in a dot or a space.
fn is_edge(c: char) -> bool {
    c == '.' || c.is_whitespace()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_name_of_the_kind_is_kept() {
        assert_eq!(suggested_file_name("web-7d9f.log", &LOG), "web-7d9f.log");
        assert_eq!(suggested_file_name("shop map.png", &PNG), "shop map.png");
        assert_eq!(
            suggested_file_name("ci.kubeconfig", &KUBECONFIG),
            "ci.kubeconfig"
        );
        // The extension is matched whatever its case, and any of the kind's will do.
        assert_eq!(suggested_file_name("notes.TXT", &LOG), "notes.TXT");
        assert_eq!(suggested_file_name("ci.yaml", &KUBECONFIG), "ci.yaml");
    }

    #[test]
    fn only_the_file_name_of_a_path_is_kept() {
        assert_eq!(suggested_file_name("/etc/cron.d/job.log", &LOG), "job.log");
        assert_eq!(suggested_file_name("../../up.log", &LOG), "up.log");
        assert_eq!(suggested_file_name(r"C:\Users\me\a.log", &LOG), "a.log");
    }

    #[test]
    fn a_name_cannot_be_hidden_or_end_in_a_dot() {
        assert_eq!(suggested_file_name("~/.bashrc", &LOG), "bashrc.log");
        assert_eq!(suggested_file_name("...profile", &LOG), "profile.log");
        assert_eq!(suggested_file_name(" web.log. ", &LOG), "web.log");
    }

    #[test]
    fn a_name_of_another_kind_gets_the_kind_s_extension() {
        assert_eq!(suggested_file_name("run.sh", &LOG), "run.sh.log");
        assert_eq!(suggested_file_name("web-1", &LOG), "web-1.log");
        assert_eq!(suggested_file_name("map.png", &PDF), "map.png.pdf");
        // An extension alone is no name.
        assert_eq!(suggested_file_name(".log", &LOG), "log.log");
    }

    #[test]
    fn characters_no_file_name_may_hold_are_dropped_or_replaced() {
        assert_eq!(
            suggested_file_name("a\u{0}b\n\u{1b}[0m.log", &LOG),
            "ab[0m.log"
        );
        assert_eq!(
            suggested_file_name("a<b>c:d\"e|f?g*.log", &LOG),
            "a-b-c-d-e-f-g-.log"
        );
    }

    #[test]
    fn a_suggestion_with_no_name_left_gets_one() {
        for empty in ["", "   ", "...", "/", "a/", "\u{0}"] {
            assert_eq!(
                suggested_file_name(empty, &LOG),
                "download.log",
                "{empty:?}"
            );
        }
    }

    #[test]
    fn a_long_name_is_cut_and_keeps_the_extension() {
        let long = format!("{}.log", "é".repeat(500));

        let name = suggested_file_name(&long, &LOG);

        assert_eq!(name.chars().count(), MAX_NAME_CHARS);
        assert!(name.ends_with(".log"), "{name}");
    }
}
