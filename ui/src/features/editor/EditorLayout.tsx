import { BookOpen } from "lucide-react";
import type { ReactNode } from "react";
import { Button, PaneHandle } from "../../design";
import { API_DOCS_PANE, usePaneSize } from "../../stores/paneSize";
import { ApiDocsPanel } from "./ApiDocsPanel";
import type { ApiDocsTarget } from "./apiDocsKind";
import { useApiDocsShown } from "./apiDocsToggle";
import styles from "./YamlEditor.module.css";

/** The toolbar button that shows or hides the API docs in every tab (spec L17). */
export function ApiDocsButton() {
  const [shown, setShown] = useApiDocsShown();
  return (
    <Button
      size="sm"
      className={styles.apiDocsToggle}
      aria-pressed={shown}
      onClick={() => setShown(!shown)}
      data-testid="api-docs-toggle"
    >
      <BookOpen size={14} aria-hidden="true" />
      API docs
    </Button>
  );
}

/**
 * The tab body: the editor and, while the toggle is on, a handle and the API docs beside it
 * (spec L18). Off, the editor takes the whole width and the panel is not mounted.
 */
export function EditorLayout(props: {
  clusterId: string;
  target: ApiDocsTarget | null;
  children: ReactNode;
}) {
  const [shown, , read] = useApiDocsShown();
  return (
    <div className={styles.body}>
      <div className={styles.main}>{props.children}</div>
      {shown && read ? (
        <ApiDocsSide clusterId={props.clusterId} target={props.target} />
      ) : null}
    </div>
  );
}

function ApiDocsSide(props: {
  clusterId: string;
  target: ApiDocsTarget | null;
}) {
  const [width, setWidth] = usePaneSize(API_DOCS_PANE);
  return (
    <div className={styles.side} style={{ width }}>
      <PaneHandle
        label="Resize API docs"
        edge="left"
        value={width}
        min={API_DOCS_PANE.min}
        max={API_DOCS_PANE.max}
        initial={API_DOCS_PANE.initial}
        onChange={setWidth}
        testId="api-docs-resize"
      />
      <ApiDocsPanel clusterId={props.clusterId} target={props.target} />
    </div>
  );
}
