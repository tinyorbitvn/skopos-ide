//! The shell a terminal command runs in (native agents spec §5.3).

/// The program and arguments that run `command` in a shell of its own: on Unix the terminal
/// shell with `-c`; on Windows `cmd.exe /C` when the terminal shell is cmd, else
/// `powershell.exe -NoProfile -Command`. The command goes as one argument, unchanged.
pub(crate) fn shell_command(shell: &str, command: &str, windows: bool) -> (String, Vec<String>) {
    let command = command.to_owned();
    if !windows {
        return (shell.to_owned(), vec!["-c".to_owned(), command]);
    }
    if is_cmd(shell) {
        (shell.to_owned(), vec!["/C".to_owned(), command])
    } else {
        (
            "powershell.exe".to_owned(),
            vec!["-NoProfile".to_owned(), "-Command".to_owned(), command],
        )
    }
}

/// Whether `shell` names cmd, by any path and in any case.
fn is_cmd(shell: &str) -> bool {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let name = name.to_ascii_lowercase();
    name == "cmd" || name == "cmd.exe"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_runs_the_terminal_shell_with_dash_c() {
        assert_eq!(
            shell_command("/bin/zsh", "kubectl get pods", false),
            (
                "/bin/zsh".to_owned(),
                vec!["-c".to_owned(), "kubectl get pods".to_owned()]
            )
        );
    }

    #[test]
    fn windows_runs_cmd_when_the_terminal_shell_is_cmd() {
        for shell in ["cmd.exe", "C:\\Windows\\System32\\CMD.EXE", "cmd"] {
            assert_eq!(
                shell_command(shell, "dir", true),
                (shell.to_owned(), vec!["/C".to_owned(), "dir".to_owned()]),
                "{shell}"
            );
        }
    }

    #[test]
    fn windows_runs_powershell_for_any_other_shell() {
        for shell in ["pwsh.exe", "powershell.exe", "C:\\tools\\nu.exe"] {
            assert_eq!(
                shell_command(shell, "Get-Date", true),
                (
                    "powershell.exe".to_owned(),
                    vec![
                        "-NoProfile".to_owned(),
                        "-Command".to_owned(),
                        "Get-Date".to_owned()
                    ]
                ),
                "{shell}"
            );
        }
    }

    #[test]
    fn shell_command_passes_the_command_as_one_argument() {
        let command = "echo \"a b\" 'c'\necho two";
        let (_, args) = shell_command("/bin/sh", command, false);
        assert_eq!(args.last().map(String::as_str), Some(command));
        let (_, args) = shell_command("cmd.exe", command, true);
        assert_eq!(args.last().map(String::as_str), Some(command));
    }
}
