import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useMemo, useState } from "react";
import { StatusDot } from "../design";
import { Download } from "../design/icons";
import { runningText } from "../features/portForward/forwardText";
import { openUpdates, useUpdates } from "../features/updates/updateStore";
import { statusButtonText } from "../features/updates/updateText";
import { useCatalog } from "../stores/catalog";
import { runningCount, usePortForwards } from "../stores/portForwards";
import { useWindowLayout } from "../stores/windowLayout";
import { clusterStatus } from "./clusterStatus";
import styles from "./Shell.module.css";
import { tabInfo } from "./tabs/routes";
import { useFocusedPath } from "./tabs/ShellRouter";

function counted(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * The focused tab's cluster and its connection state, or the screen of a tab without
 * one; then the running port forwards; on the right this window's panes and tabs and
 * the version (spec P4).
 */
function FocusedCluster() {
  const path = useFocusedPath();
  const clusters = useCatalog((s) => s.clusters);
  const info = useMemo(
    () => (path === null ? null : tabInfo(path, clusters)),
    [path, clusters],
  );
  const entry = clusters.find((c) => c.id === info?.clusterId);
  if (info === null) {
    return <span data-testid="status-focused">No tabs open</span>;
  }
  if (info.clusterId === null) {
    return <span data-testid="status-focused">{info.screen}</span>;
  }
  const status = clusterStatus(entry?.state ?? { status: "disconnected" });
  return (
    <span className={styles.statusCluster} data-testid="status-focused">
      <StatusDot tone={status.tone} label={status.label} />
      {`${info.clusterName} · ${status.label}`}
    </span>
  );
}

/**
 * The version, or, while a release is offered or downloading, a button that opens the
 * update dialog (in-app update spec §5.3).
 */
function VersionOrUpdate(props: { version: string | null }) {
  const text = useUpdates((s) =>
    s.state === null ? null : statusButtonText(s.state),
  );
  if (text === null) {
    return (
      <span data-testid="status-version">
        {props.version ? `SkoposIDE ${props.version}` : "SkoposIDE"}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.statusUpdate}
      data-testid="status-update"
      onClick={openUpdates}
    >
      <Download size={14} aria-hidden="true" />
      {text}
    </button>
  );
}

export function StatusBar() {
  const forwards = runningText(
    usePortForwards((s) => runningCount(s.forwards)),
  );
  const panes = useWindowLayout((s) => s.layout.panes.length);
  const tabs = useWindowLayout((s) =>
    s.layout.panes.reduce((n, p) => n + p.tabs.length, 0),
  );
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(null));
  }, []);

  return (
    <footer className={styles.status} data-testid="status-bar">
      <FocusedCluster />
      {forwards ? (
        <span className={styles.statusLine} data-testid="status-port-forwards">
          {forwards}
        </span>
      ) : null}
      <span className={styles.statusRight}>
        <span className={styles.statusLine} data-testid="status-layout">
          {`${counted(panes, "pane")} · ${counted(tabs, "tab")}`}
        </span>
        <VersionOrUpdate version={version} />
      </span>
    </footer>
  );
}
