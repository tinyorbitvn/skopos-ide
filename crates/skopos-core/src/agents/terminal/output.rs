//! A terminal command's output for the agent and its card (native agents spec §5.3): escape
//! codes stripped, the newest 64 KiB for the agent, the last lines for the card.

use std::collections::VecDeque;

/// The agent gets at most this much text, from the end of the output.
pub(crate) const AGENT_OUTPUT_LIMIT: usize = 64 * 1024;
/// Raw bytes kept per command: twice the agent's share, so that stripped codes leave enough.
const RAW_LIMIT: usize = 2 * AGENT_OUTPUT_LIMIT;
/// The card's lines come from this much of the end.
const LINES_WINDOW: usize = 16 * 1024;
pub(crate) const CUT_MARK: &str = "[earlier output cut]";
/// The cursor position query a Windows pseudoconsole sends when it opens, and waits for.
pub(crate) const CURSOR_QUERY: &[u8] = b"\x1b[6n";
/// Its answer: the top left cell.
pub(crate) const CURSOR_ANSWER: &[u8] = b"\x1b[1;1R";

/// The newest bytes a command printed.
#[derive(Debug)]
pub(crate) struct OutputTail {
    bytes: VecDeque<u8>,
    limit: usize,
    /// Bytes were dropped from the front.
    cut: bool,
}

impl Default for OutputTail {
    fn default() -> Self {
        Self::with_limit(RAW_LIMIT)
    }
}

impl OutputTail {
    pub(crate) fn with_limit(limit: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            limit,
            cut: false,
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk);
        let over = self.bytes.len().saturating_sub(self.limit);
        if over > 0 {
            self.bytes.drain(..over);
            self.cut = true;
        }
    }

    fn text_from(&self, start: usize) -> String {
        let raw: Vec<u8> = self.bytes.range(start..).copied().collect();
        plain_text(&String::from_utf8_lossy(&raw))
    }

    /// What the agent reads: plain text, at most `AGENT_OUTPUT_LIMIT` bytes from the end, with
    /// `[earlier output cut]` first when anything was left out.
    pub(crate) fn agent_text(&self) -> String {
        let text = self.text_from(0);
        let (kept, cut) = last_bytes(&text, AGENT_OUTPUT_LIMIT);
        if cut || self.cut {
            format!("{CUT_MARK}\n{kept}")
        } else {
            kept.to_owned()
        }
    }

    /// The last `count` lines of plain text, for the card.
    pub(crate) fn last_lines(&self, count: usize) -> String {
        let start = self.bytes.len().saturating_sub(LINES_WINDOW);
        last_lines(&self.text_from(start), count)
    }
}

/// Drops ANSI escape sequences (CSI, OSC and the other string sequences, charset choices) and
/// control characters other than newline, carriage return and tab.
pub(crate) fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // Parameters and intermediates, up to a final byte in `@` to `~`.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // Up to BEL or ST (ESC \).
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')' | '*' | '+' | '#' | '%') => {
                    chars.next();
                }
                _ => {}
            },
            '\n' | '\r' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Text roughly as a terminal leaves it: escapes stripped, `\r\n` a line end, and a lone `\r`
/// starting its line again.
pub(crate) fn plain_text(raw: &str) -> String {
    let stripped = strip_escapes(raw);
    stripped
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            line.rsplit('\r').next().unwrap_or(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The end of `text`, at most `limit` bytes on a character boundary, and whether any was left
/// out.
fn last_bytes(text: &str, limit: usize) -> (&str, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (&text[start..], true)
}

/// The last `count` lines, without the empty line a final newline leaves.
pub(crate) fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.trim_end_matches('\n').lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

/// `chunk` without its first cursor position query, when it has one.
pub(crate) fn without_cursor_query(chunk: &[u8]) -> Option<Vec<u8>> {
    let at = chunk
        .windows(CURSOR_QUERY.len())
        .position(|window| window == CURSOR_QUERY)?;
    let mut rest = chunk[..at].to_vec();
    rest.extend_from_slice(&chunk[at + CURSOR_QUERY.len()..]);
    Some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_cursor_and_title_codes_are_stripped() {
        let raw = "\x1b[1;31mred\x1b[0m \x1b]0;title\x07plain \x1b[2K\x1b(Bdone\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\";
        assert_eq!(strip_escapes(raw), "red plain donelink");
    }

    #[test]
    fn a_carriage_return_starts_its_line_again() {
        assert_eq!(plain_text("10%\r50%\r100%\r\nnext\r\n"), "100%\nnext\n");
    }

    #[test]
    fn the_agent_gets_the_last_64_kib_with_the_cut_mark() {
        let mut tail = OutputTail::default();
        tail.push(&vec![b'a'; AGENT_OUTPUT_LIMIT + 10]);
        tail.push(b"END");
        let text = tail.agent_text();
        assert!(
            text.starts_with("[earlier output cut]\n"),
            "{}",
            &text[..40]
        );
        assert!(text.ends_with("END"));
        assert_eq!(text.len(), CUT_MARK.len() + 1 + AGENT_OUTPUT_LIMIT);
    }

    #[test]
    fn short_output_has_no_cut_mark() {
        let mut tail = OutputTail::default();
        tail.push(b"\x1b[32mok\x1b[0m\r\n");
        assert_eq!(tail.agent_text(), "ok\n");
    }

    #[test]
    fn raw_bytes_dropped_from_the_front_also_mark_the_cut() {
        let mut tail = OutputTail::with_limit(8);
        tail.push(b"0123456789");
        assert_eq!(tail.agent_text(), "[earlier output cut]\n23456789");
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        let mut tail = OutputTail::default();
        tail.push("é".repeat(AGENT_OUTPUT_LIMIT).as_bytes());
        let text = tail.agent_text();
        assert!(text.ends_with('é'));
    }

    #[test]
    fn the_card_gets_the_last_lines_without_the_final_empty_one() {
        let mut tail = OutputTail::default();
        for n in 1..=30 {
            tail.push(format!("line {n}\r\n").as_bytes());
        }
        let lines = tail.last_lines(20);
        assert_eq!(lines.lines().count(), 20);
        assert!(lines.starts_with("line 11\n"));
        assert!(lines.ends_with("line 30"));
    }

    #[test]
    fn the_first_cursor_query_is_taken_out() {
        assert_eq!(
            without_cursor_query(b"a\x1b[6nb\x1b[6n"),
            Some(b"ab\x1b[6n".to_vec())
        );
        assert_eq!(without_cursor_query(b"plain"), None);
    }
}
