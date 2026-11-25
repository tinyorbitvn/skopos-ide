import type { editor as MonacoEditor } from "monaco-editor/editor/editor.api";
import { useEffect, useRef } from "react";
import styles from "./YamlEditor.module.css";

type Monaco = typeof import("./monaco")["monaco"];

/** Puts the two texts into the diff editor, and drops the models it showed before. */
function show(
  monaco: Monaco,
  diff: MonacoEditor.IStandaloneDiffEditor,
  original: string,
  modified: string,
): void {
  const old = diff.getModel();
  diff.setModel({
    original: monaco.editor.createModel(original, "yaml"),
    modified: monaco.editor.createModel(modified, "yaml"),
  });
  old?.original.dispose();
  old?.modified.dispose();
}

/** A read-only inline diff of the tab's text and a proposal (spec A4). */
export function YamlDiff(props: { original: string; modified: string }) {
  const host = useRef<HTMLDivElement>(null);
  const diff = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  // The texts to show; the editor may be created after they change.
  const texts = useRef({ original: props.original, modified: props.modified });
  texts.current = { original: props.original, modified: props.modified };

  useEffect(() => {
    let gone = false;
    let dispose = () => {};
    void import("./monaco").then(({ monaco, currentTheme }) => {
      if (gone || !host.current) return;
      const created = monaco.editor.createDiffEditor(host.current, {
        readOnly: true,
        originalEditable: false,
        renderSideBySide: false,
        automaticLayout: true,
        theme: currentTheme(),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
      });
      diff.current = created;
      show(monaco, created, texts.current.original, texts.current.modified);
      dispose = () => {
        const model = created.getModel();
        created.dispose();
        model?.original.dispose();
        model?.modified.dispose();
        diff.current = null;
      };
    });
    return () => {
      gone = true;
      dispose();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the texts are read from `texts`, which follows them.
  useEffect(() => {
    void import("./monaco").then(({ monaco }) => {
      const current = diff.current;
      const model = current?.getModel();
      if (!current) return;
      // The first effect may already have shown these texts.
      if (
        model?.original.getValue() === texts.current.original &&
        model.modified.getValue() === texts.current.modified
      )
        return;
      show(monaco, current, texts.current.original, texts.current.modified);
    });
  }, [props.original, props.modified]);

  return (
    <div className={styles.editor} data-testid="yaml-proposal-diff">
      <div ref={host} className={styles.host} />
    </div>
  );
}
