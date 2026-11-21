import { useCallback, useEffect, useState } from "react";
import { Button, ConfirmDialog, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { ExecRequest } from "../../ipc/generated/ExecRequest";
import type { ExecRequestDetails } from "../../ipc/generated/ExecRequestDetails";
import { useClusterName } from "../../stores/catalog";
import { connectCluster } from "../../stores/clusters";
import { useExecConsent } from "../../stores/execConsent";
import styles from "./ExecConsentDialog.module.css";

function argumentCount(count: number): string {
  if (count === 0) return "None";
  return count === 1 ? "1 argument" : `${count} arguments`;
}

/**
 * Asks before a kubeconfig runs a program for credentials. It shows what the last
 * blocked connect refused, and the arguments and environment values only on request.
 * Mounted once per window; `connectAndAsk` opens it.
 */
export function ExecConsentDialog() {
  const clusterId = useExecConsent((s) => s.clusterId);
  const close = useExecConsent((s) => s.close);
  const name = useClusterName(clusterId ?? "");
  const [request, setRequest] = useState<ExecRequest | null>(null);
  const [details, setDetails] = useState<ExecRequestDetails | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (id: string): Promise<void> => {
      setDetails(null);
      try {
        const held = await api.clusterExecRequest(id);
        // An answer for a cluster the dialog has left is dropped.
        if (useExecConsent.getState().clusterId === id) setRequest(held);
      } catch {
        // Nothing is held any more, after a disconnect or another attempt.
        // The next connect asks again.
        if (useExecConsent.getState().clusterId === id) close();
      }
    },
    [close],
  );

  useEffect(() => {
    setRequest(null);
    setDetails(null);
    if (clusterId !== null) void load(clusterId);
  }, [clusterId, load]);

  if (clusterId === null || request === null) return null;
  const id = clusterId;
  const shown = request;

  // The kubeconfig was read again since this was shown: show what it says now.
  const afterFailure = async (error: unknown, title: string): Promise<void> => {
    if (error instanceof IpcFailure && error.code === "Conflict") {
      await load(id);
    } else {
      toast.error(title, failureMessage(error));
    }
  };

  const showArguments = async (): Promise<void> => {
    try {
      setDetails(await api.clusterExecRequestDetails(id, shown.requestId));
    } catch (error) {
      await afterFailure(error, "Could not read the arguments");
    }
  };

  const allow = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.clusterExecAllow(id, shown.requestId);
    } catch (error) {
      await afterFailure(error, "Could not allow");
      return;
    } finally {
      setBusy(false);
    }
    close();
    // Through the same door as every connect: a kubeconfig that changed in between asks again.
    void connectCluster(id);
  };

  const hasMore = shown.argCount > 0 || shown.envNames.length > 0;

  return (
    <ConfirmDialog
      open
      title="Let this kubeconfig run a program?"
      testId="exec-consent-dialog"
      confirmLabel="Allow and connect"
      confirmDisabled={busy}
      onConfirm={() => void allow()}
      onCancel={close}
      body={
        <>
          <p>
            To sign in to {name}, this kubeconfig runs a program on your
            computer with your account's permissions. Allow it only if you trust
            where the kubeconfig came from.
          </p>
          {shown.changed ? (
            <p className={styles.changed} data-testid="exec-consent-changed">
              The program or the cluster address has changed since you allowed
              it.
            </p>
          ) : null}
          <dl className={styles.facts}>
            <dt>Program</dt>
            <dd className={styles.mono} data-testid="exec-consent-program">
              {shown.command}
            </dd>
            <dt>Arguments</dt>
            <dd data-testid="exec-consent-args">
              {details === null ? (
                <>
                  {argumentCount(shown.argCount)}
                  {hasMore ? (
                    <Button
                      size="sm"
                      className={styles.show}
                      data-testid="exec-consent-show"
                      onClick={() => void showArguments()}
                    >
                      Show arguments
                    </Button>
                  ) : null}
                </>
              ) : details.args.length === 0 ? (
                "None"
              ) : (
                <pre className={styles.full}>{details.args.join("\n")}</pre>
              )}
            </dd>
            <dt>Environment</dt>
            <dd data-testid="exec-consent-env">
              {details === null ? (
                shown.envNames.join(", ") || "None"
              ) : details.env.length === 0 ? (
                "None"
              ) : (
                <pre className={styles.full}>
                  {details.env.map((v) => `${v.name}=${v.value}`).join("\n")}
                </pre>
              )}
            </dd>
            <dt>Cluster address</dt>
            <dd>{shown.server}</dd>
            <dt>Kubeconfig</dt>
            <dd>{`${shown.sourcePath} · context ${shown.contextName}`}</dd>
          </dl>
          <p className={styles.hint}>
            Remembered for this cluster until the program, its arguments or the
            cluster address change. You can stop allowing it in Cluster
            settings.
          </p>
        </>
      }
    />
  );
}
