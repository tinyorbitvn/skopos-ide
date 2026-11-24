import type { ReactNode } from "react";
import { ShellDialog } from "../../app/ShellDialog";
import {
  Button,
  IconButton,
  Markdown,
  ProgressBar,
  Spinner,
} from "../../design";
import { X } from "../../design/icons";
import { api } from "../../ipc/api";
import type { Release } from "../../ipc/generated/Release";
import type { UpdateState } from "../../ipc/generated/UpdateState";
import { useDock } from "../../stores/dock";
import { runningCount, usePortForwards } from "../../stores/portForwards";
import { useShell } from "../../stores/shell";
import { useSessions } from "../terminal/sessions";
import styles from "./UpdateDialog.module.css";
import {
  cancelUpdate,
  checkForUpdates,
  installUpdate,
  skipUpdate,
  useUpdates,
} from "./updateStore";
import {
  DOWNLOAD_PAGE,
  downloadedText,
  downloadPercent,
  releasePage,
  STORE_MANAGED_TEXT,
  willStopText,
  youHaveText,
} from "./updateText";

const DEB_PASSWORD =
  "You'll be asked for your password to install the package.";

function openPage(url: string): void {
  void api.openExternal(url).catch(() => {});
}

/** The sessions, forwards and unsaved edits of this window that a restart ends. */
function useWillStop(): string | null {
  const terminals = useSessions(
    (s) =>
      Object.values(s.sessions).filter(
        (session) =>
          session.status === "connecting" || session.status === "connected",
      ).length,
  );
  const forwards = usePortForwards((s) => runningCount(s.forwards));
  const edits = useDock((s) => s.tabs.filter((tab) => tab.dirty).length);
  return willStopText(terminals, forwards, edits);
}

function View(props: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className={styles.header}>
        <div className={styles.titles}>
          <h2 className={styles.title}>{props.title}</h2>
          {props.subtitle ? (
            <p className={styles.subtitle}>{props.subtitle}</p>
          ) : null}
        </div>
        {props.onClose ? (
          <IconButton
            label="Close"
            icon={<X size={16} aria-hidden="true" />}
            tooltip={false}
            onClick={props.onClose}
          />
        ) : null}
      </div>
      {props.children ? (
        <div className={styles.body}>{props.children}</div>
      ) : null}
      {props.actions ? (
        <div className={styles.actions}>{props.actions}</div>
      ) : null}
    </>
  );
}

function Available(props: {
  state: UpdateState;
  release: Release;
  onClose(): void;
}) {
  const { state, release } = props;
  const willStop = useWillStop();
  const blocked = state.blocker !== null;
  return (
    <View
      title={`SkoposIDE ${release.version} is available`}
      subtitle={youHaveText(state.current, release)}
      onClose={props.onClose}
      actions={
        <>
          <Button
            variant="ghost"
            className={styles.skip}
            onClick={() => void skipUpdate(release.version)}
          >
            Skip This Version
          </Button>
          <Button variant="secondary" onClick={props.onClose}>
            Later
          </Button>
          {blocked ? (
            <Button variant="primary" onClick={() => openPage(DOWNLOAD_PAGE)}>
              Open Download Page
            </Button>
          ) : (
            <Button
              variant="primary"
              data-autofocus=""
              onClick={() => void installUpdate()}
            >
              Install and Restart
            </Button>
          )}
        </>
      }
    >
      {release.notes.trim() === "" ? null : (
        <div className={styles.notes}>
          <Markdown text={release.notes} testId="update-notes" />
        </div>
      )}
      <button
        type="button"
        className={styles.link}
        onClick={() => openPage(releasePage(release.version))}
      >
        Full release notes
      </button>
      {blocked ? (
        <p className={styles.note} data-testid="update-blocker">
          {state.blocker}
        </p>
      ) : (
        <>
          {willStop === null ? null : (
            <p className={styles.note} data-testid="update-will-stop">
              {willStop}
            </p>
          )}
          {state.installer === "deb" ? (
            <p className={styles.note} data-testid="update-deb">
              {DEB_PASSWORD}
            </p>
          ) : null}
        </>
      )}
    </View>
  );
}

function UpdateBody(props: { state: UpdateState | null; onClose(): void }) {
  const { state, onClose } = props;
  const phase = state?.phase ?? { type: "checking" as const };
  switch (phase.type) {
    case "idle":
    case "checking":
      return (
        <View title="Checking for updates…" onClose={onClose}>
          <Spinner label="Checking" />
        </View>
      );
    case "upToDate":
      return (
        <View
          title={`SkoposIDE ${state?.current ?? ""} is the latest version.`}
          onClose={onClose}
        />
      );
    case "storeManaged":
      return <View title={STORE_MANAGED_TEXT} onClose={onClose} />;
    case "available":
      return state === null ? null : (
        <Available state={state} release={phase.release} onClose={onClose} />
      );
    case "downloading": {
      const percent = downloadPercent(phase.received, phase.total);
      return (
        <View
          title={`SkoposIDE ${phase.version} is available`}
          onClose={onClose}
          actions={
            <Button variant="secondary" onClick={cancelUpdate}>
              Cancel
            </Button>
          }
        >
          <ProgressBar label={`Downloading ${phase.version}`} value={percent} />
          <p className={styles.size}>
            {downloadedText(phase.received, phase.total)}
          </p>
        </View>
      );
    }
    case "installing":
      return <View title="Installing…" />;
    case "failed": {
      const release = phase.release;
      return (
        <View
          title={release === null ? "The check failed" : "The update failed"}
          onClose={onClose}
          actions={
            <>
              <Button
                variant="primary"
                onClick={() =>
                  void (release === null ? checkForUpdates() : installUpdate())
                }
              >
                Try Again
              </Button>
              <Button
                variant="secondary"
                onClick={() => openPage(DOWNLOAD_PAGE)}
              >
                Open Download Page
              </Button>
            </>
          }
        >
          <p className={styles.message} role="alert">
            {phase.message}
          </p>
        </View>
      );
    }
  }
}

/** Check for Updates and Install and Restart (in-app update spec §5.3). */
export function UpdateDialog() {
  const open = useShell((s) => s.dialog === "updates");
  const close = useShell((s) => s.close);
  const state = useUpdates((s) => s.state);
  const installing = state?.phase.type === "installing";
  return (
    <ShellDialog
      open={open}
      onClose={() => {
        // The installer is running: the app restarts or reports a failure.
        if (!installing) close("updates");
      }}
      label="Updates"
      testId="update-dialog"
      kind="panel"
    >
      <UpdateBody state={state} onClose={() => close("updates")} />
    </ShellDialog>
  );
}
