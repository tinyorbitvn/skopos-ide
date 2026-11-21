import { describe, expect, it } from "vitest";
import { connectionNotes } from "./connectionNotes";

describe("connectionNotes", () => {
  it("says nothing about a kubeconfig that runs no command and checks TLS", () => {
    expect(connectionNotes({ execCommand: null, insecureTls: false })).toEqual(
      [],
    );
  });

  it("names the command an exec plugin runs", () => {
    const notes = connectionNotes({ execCommand: "aws", insecureTls: false });
    expect(notes).toEqual([
      {
        id: "exec",
        label: "Exec plugin",
        tone: "neutral",
        detail:
          'Connecting runs "aws" from this kubeconfig to get credentials.',
      },
    ]);
  });

  it("warns when TLS verification is off", () => {
    const notes = connectionNotes({ execCommand: null, insecureTls: true });
    expect(notes).toEqual([
      {
        id: "tls",
        label: "TLS not verified",
        tone: "warn",
        detail:
          "This kubeconfig turns off TLS verification (insecure-skip-tls-verify), so the server's identity is not checked.",
      },
    ]);
  });

  it("puts the TLS warning first when both apply", () => {
    const notes = connectionNotes({
      execCommand: "/opt/bin/login",
      insecureTls: true,
    });
    expect(notes.map((note) => note.id)).toEqual(["tls", "exec"]);
    expect(notes[1].detail).toContain('"/opt/bin/login"');
  });
});
