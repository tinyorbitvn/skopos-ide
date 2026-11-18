import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useMemo, useState } from "react";
import { StatusDot } from "../design";
import { runningText } from "../features/portForward/forwardText";
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
        <span>{version ? `SkoposIDE ${version}` : "SkoposIDE"}</span>
      </span>
    </footer>
  );
}
