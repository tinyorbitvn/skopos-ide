import { useEffect, useRef, useState } from "react";
import { useMatch, useParams } from "react-router";
import { useTabContext } from "../../app/tabs/TabView";
import { Button, EmptyState, Spinner } from "../../design";
import { useCatalog } from "../../stores/catalog";
import { useClusterState, useConnect } from "../../stores/clusters";
import { useWindowLayout } from "../../stores/windowLayout";
import { ClusterSettingsScreen } from "../settings/ClusterSettingsScreen";
import { ClusterLayout } from "./ClusterLayout";
import styles from "./ClusterScreen.module.css";
import { ConnectionPanel } from "./ConnectionPanel";

function ClusterView({ id }: { id: string }) {
  const state = useClusterState(id);
  const { connect, disconnect, busy } = useConnect(id);
  // The Settings page opens whether or not the cluster is connected: it does not
  // connect, and it shows in place of the connection panel.
  const onSettings = useMatch("/cluster/:id/settings") !== null;
  // One automatic connect per mount, and none after the user disconnects.
  const autoDone = useRef(false);
  const [userDisconnected, setUserDisconnected] = useState(false);

  // Disconnect lives in the header and the palette, outside this screen, so a change
  // from connected to disconnected is how the screen learns that the user
  // disconnected. Declared first, so it runs before the automatic connect below.
  const previous = useRef(state.status);
  useEffect(() => {
    const was = previous.current;
    previous.current = state.status;
    if (was === "connected" && state.status === "disconnected") {
      autoDone.current = true;
      setUserDisconnected(true);
    }
  }, [state.status]);

  useEffect(() => {
    if (autoDone.current || onSettings || state.status !== "disconnected") {
      return;
    }
    autoDone.current = true;
    void connect();
  }, [state.status, connect, onSettings]);

  // Cancel while connecting, in the connection panel.
  function userDisconnect(): void {
    autoDone.current = true;
    setUserDisconnected(true);
    void disconnect();
  }

  if (onSettings && state.status !== "connected") {
    return <ClusterSettingsScreen clusterId={id} />;
  }
  return (
    <div className={styles.screen}>
      {state.status === "connected" ? (
        <ClusterLayout clusterId={id} />
      ) : (
        <ConnectionPanel
          id={id}
          state={state}
          busy={busy}
          reconnect={userDisconnected}
          onConnect={() => void connect()}
          onDisconnect={userDisconnect}
        />
      )}
    </div>
  );
}

/** A tab whose cluster left the catalog (spec P10): its Close closes the tab, pinned or not. */
function NotInCatalog() {
  const tab = useTabContext();
  function close(): void {
    if (tab === null) return;
    const { dispatch } = useWindowLayout.getState();
    dispatch({ type: "unpin", tabId: tab.tabId });
    dispatch({ type: "close", tabId: tab.tabId });
  }
  return (
    <EmptyState
      title="This cluster is no longer in the catalog."
      action={
        tab === null ? null : (
          <Button data-testid="cluster-missing-close" onClick={close}>
            Close
          </Button>
        )
      }
    />
  );
}

export function ClusterScreen() {
  const { id = "" } = useParams();
  const cluster = useCatalog((s) => s.clusters.find((c) => c.id === id));
  const loading = useCatalog((s) => s.loading);

  if (!cluster) {
    if (loading) {
      return (
        <div className={styles.screen}>
          <Spinner label="Loading" />
        </div>
      );
    }
    return <NotInCatalog />;
  }
  return <ClusterView key={id} id={id} />;
}
