import { open } from "@tauri-apps/plugin-dialog";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useAnchorFocus } from "../../app/anchorFocus";
import { connectionNotes } from "../../app/connectionNotes";
import {
  Badge,
  Button,
  ErrorNotice,
  Input,
  RadioGroup,
  type RadioOption,
  Segmented,
  Select,
  Spinner,
  toast,
} from "../../design";
import { ArrowLeft } from "../../design/icons";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import type { MetricsProviderSetting } from "../../ipc/generated/MetricsProviderSetting";
import { useCatalog } from "../../stores/catalog";
import { useClusterState } from "../../stores/clusters";
import {
  forgetProvider,
  forgetQueries,
  useMetrics,
} from "../../stores/metrics";
import { agentsSupported } from "../agents/supported";
import { useFetch } from "../helm/useFetch";
import { AgentCard } from "./AgentCard";
import styles from "./ClusterSettingsScreen.module.css";
import { dropDraft, keepDraft, restoredDraft } from "./drafts";
import { IconField } from "./IconField";
import { AGENT_CARD_ID, overviewPath } from "./paths";
import {
  type AuthKind,
  draftFrom,
  draftSecretAuth,
  emptyDraft,
  type FileField,
  fileFieldOf,
  keepsSecret,
  type ProviderKind,
  prometheusPrefill,
  type SchemeChoice,
  type SettingsDraft,
  sameDraft,
  secretAuthOf,
  settingsFrom,
  statusText,
  validate,
} from "./settingsForm";

/** The Select value that stands for no default namespace: the kubeconfig's. */
const FROM_KUBECONFIG = "__kubeconfig__";

/** The password or token field's placeholder while the keychain keeps one (spec I57). */
const SAVED_SECRET = "Saved in the keychain";

const PROVIDERS: RadioOption<ProviderKind>[] = [
  {
    value: "auto",
    label: "Detect",
    description:
      "Look for a Prometheus Service across namespaces, then fall back to metrics-server",
  },
  {
    value: "prometheus",
    label: "Prometheus or Mimir in the cluster",
    description: "A Service you name, queried through the API server proxy",
  },
  {
    value: "remote",
    label: "Prometheus-compatible URL",
    description:
      "Mimir, Grafana Cloud or another Prometheus API, reached directly",
  },
  {
    value: "metricsServer",
    label: "metrics-server only",
    description: "Current CPU and memory, no history",
  },
  { value: "none", label: "None", description: "No metrics for this cluster" },
];

const SCHEMES: { value: SchemeChoice; label: string }[] = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
];

const AUTHS: { value: AuthKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "basic", label: "Basic" },
  { value: "bearer", label: "Bearer" },
  { value: "mtls", label: "Client certificate" },
];

/** The cluster label `name="value"`: two fields side by side, wrapping under a narrow window. */
function ClusterLabelField(props: {
  name: string;
  value: string;
  nameError?: string;
  valueError?: string;
  onName(name: string): void;
  onValue(value: string): void;
  testId: string;
}) {
  return (
    <fieldset className={styles.labelPair}>
      <legend className={`${styles.fieldLabel} ${styles.legend}`}>
        Cluster label
      </legend>
      <div className={styles.labelRow}>
        <div className={styles.labelPart}>
          <Input
            aria-label="Cluster label name"
            placeholder="cluster"
            className={styles.mono}
            value={props.name}
            error={props.nameError}
            onChange={(e) => props.onName(e.target.value)}
            data-testid={`${props.testId}-name`}
          />
        </div>
        <span className={styles.equals} aria-hidden="true">
          =
        </span>
        <div className={styles.labelPart}>
          <Input
            aria-label="Cluster label value"
            placeholder="prod"
            className={styles.mono}
            value={props.value}
            error={props.valueError}
            onChange={(e) => props.onValue(e.target.value)}
            data-testid={`${props.testId}-value`}
          />
        </div>
      </div>
    </fieldset>
  );
}

/** A file's path, typed or picked with the file dialog (spec I56). */
function PathField(props: {
  label: string;
  help?: string;
  value: string;
  error?: string;
  onChange(path: string): void;
  testId: string;
}) {
  const id = useId();
  async function choose(): Promise<void> {
    try {
      const path = await open({ directory: false, multiple: false });
      if (path) props.onChange(path);
    } catch (error) {
      toast.error("Could not open the file picker", failureMessage(error));
    }
  }
  return (
    <div className={styles.fileField}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {props.label}
      </label>
      <div className={styles.fileRow}>
        <div className={styles.filePath}>
          <Input
            id={id}
            help={props.help}
            className={styles.mono}
            value={props.value}
            error={props.error}
            onChange={(e) => props.onChange(e.target.value)}
            data-testid={props.testId}
          />
        </div>
        <Button
          onClick={() => void choose()}
          data-testid={`${props.testId}-choose`}
        >
          Choose…
        </Button>
      </div>
    </div>
  );
}

function SettingsForm(props: {
  clusterId: string;
  name: string;
  contextName: string;
  /** The connected cluster's namespaces; empty when it is not connected. */
  namespaces: string[];
  initial: ClusterSettings;
}) {
  const { clusterId } = props;
  const [params] = useSearchParams();
  useAnchorFocus(params.get("card") === "agent" ? AGENT_CARD_ID : null, true);
  // Only the cached provider: this page never asks for it.
  const detected = useMetrics((s) => s.providers[clusterId]?.value);
  const [saved, setSaved] = useState(props.initial);
  // A draft kept from before a remount wins over the settings just read.
  const [draft, setDraft] = useState(
    () => restoredDraft(clusterId, draftFrom(props.initial)) ??
      draftFrom(props.initial),
  );
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // The URL's password or token as typed: never in the draft, so never kept past a remount.
  const [secret, setSecret] = useState("");
  // What the save found wrong with a file, under its field until the field changes.
  const [fileErrors, setFileErrors] = useState<
    Partial<Record<FileField, string>>
  >({});
  // Only a saved Basic or Bearer setting can keep its secret (spec I57, I58).
  const secretSaved = useFetch(secretAuthOf(saved.metricsProvider), () =>
    api.metricsSecretSaved(clusterId),
  );

  const secretAuth = draftSecretAuth(draft);
  const typedSecret = secretAuth === null ? "" : secret;
  const keptSecret = keepsSecret(
    saved.metricsProvider,
    draft,
    secretSaved.value === true,
  );
  // Until the keychain answers, an empty secret field is not marked, but Save waits.
  const errors = validate(draft, {
    typed: typedSecret,
    kept: keptSecret || secretSaved.loading,
  });
  const changed = !sameDraft(draft, draftFrom(saved)) || typedSecret !== "";
  const canSave =
    changed &&
    Object.keys(errors).length === 0 &&
    !saving &&
    !secretSaved.loading;

  useEffect(() => {
    if (changed) keepDraft(clusterId, draft, draftFrom(saved));
    else dropDraft(clusterId);
  }, [clusterId, draft, changed, saved]);

  function update(fields: Partial<SettingsDraft>): void {
    setDraft((d) => ({ ...d, ...fields }));
    setJustSaved(false);
    setFileErrors((shown) =>
      Object.fromEntries(
        Object.entries(shown).filter(([field]) => !(field in fields)),
      ),
    );
  }

  function typeSecret(value: string): void {
    setSecret(value);
    setJustSaved(false);
  }

  function pickAuth(remoteAuth: AuthKind): void {
    // A password typed for Basic is never sent as Bearer's token (spec I58).
    setSecret("");
    update({ remoteAuth });
  }

  function pickProvider(provider: ProviderKind): void {
    const prefill =
      provider === "prometheus" &&
      saved.metricsProvider.kind !== "prometheus" &&
      draft.promNamespace === "" &&
      draft.promService === "" &&
      draft.promPort === "";
    update(
      prefill ? { provider, ...prometheusPrefill(detected) } : { provider },
    );
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    const next = settingsFrom(draft);
    setSaving(true);
    try {
      // The secret first: a keychain that refuses it leaves the settings unsaved (I59).
      if (
        typedSecret !== "" &&
        !(await saveSecret(typedSecret, next.metricsProvider))
      )
        return;
      await api.clusterSettingsSet(clusterId, next);
      toast.success(
        `Saved the settings for ${next.displayName ?? props.contextName}`,
        next.proxyUrl === saved.proxyUrl
          ? undefined
          : "Reconnect to use the new proxy.",
      );
      forgetProvider(clusterId);
      forgetQueries(clusterId);
      setSaved(next);
      setDraft(draftFrom(next));
      setSecret("");
      setJustSaved(true);
      // The keychain now holds what was typed.
      if (typedSecret !== "") secretSaved.retry();
    } catch (error) {
      const field = fileFieldOf(error);
      if (field !== null) {
        setFileErrors({ [field]: failureMessage(error) });
      } else {
        toast.error(
          `Could not save the settings for ${props.name}`,
          failureMessage(error),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  /** Writes the typed password or token to the keychain; a refusal is toasted. */
  async function saveSecret(
    value: string,
    provider: MetricsProviderSetting,
  ): Promise<boolean> {
    try {
      await api.metricsSecretSet(clusterId, value, provider);
      return true;
    } catch (error) {
      // The core refuses the secret along with a setting it refuses (a bad file path).
      const field = fileFieldOf(error);
      if (field !== null) {
        setFileErrors({ [field]: failureMessage(error) });
        return false;
      }
      const what = secretAuth === "basic" ? "password" : "token";
      toast.error(
        `Could not save the ${what} for ${props.name}`,
        failureMessage(error),
      );
      return false;
    }
  }

  const namespaces = [...props.namespaces];
  if (
    saved.defaultNamespace !== null &&
    !namespaces.includes(saved.defaultNamespace)
  ) {
    namespaces.push(saved.defaultNamespace);
  }
  const namespaceOptions = [
    { value: FROM_KUBECONFIG, label: "From the kubeconfig" },
    ...namespaces.map((n) => ({ value: n, label: n })),
  ];

  return (
    <form className={styles.form} onSubmit={(e) => void save(e)}>
      <section className={styles.section}>
        <h2 className={styles.heading}>General</h2>
        <div className={styles.grid}>
          <Input
            label="Display name"
            help="Shown in the hotbar, the catalog and the title"
            placeholder={props.contextName}
            value={draft.displayName}
            onChange={(e) => update({ displayName: e.target.value })}
            data-testid="settings-display-name"
          />
        </div>
        <IconField icon={draft.icon} onChange={(icon) => update({ icon })} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Namespaces</h2>
        <div className={styles.grid}>
          <Select
            label="Default namespace"
            value={draft.defaultNamespace ?? FROM_KUBECONFIG}
            options={namespaceOptions}
            onChange={(v) =>
              update({ defaultNamespace: v === FROM_KUBECONFIG ? null : v })
            }
            testId="settings-default-namespace"
          />
          <Input
            label="Accessible namespaces"
            help="Comma separated. When set, SkoposIDE watches only these"
            className={styles.mono}
            value={draft.accessibleNamespaces}
            error={errors.accessibleNamespaces}
            onChange={(e) => update({ accessibleNamespaces: e.target.value })}
            data-testid="settings-accessible-namespaces"
          />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Terminal and node shell</h2>
        <div className={styles.grid}>
          <Input
            label="Terminal working directory"
            help="Where the local terminal of this cluster starts"
            className={styles.mono}
            value={draft.terminalCwd}
            onChange={(e) => update({ terminalCwd: e.target.value })}
            data-testid="settings-terminal-cwd"
          />
          <Input
            label="Node shell image"
            help="The privileged Pod that enters a node"
            className={styles.mono}
            value={draft.nodeShellImage}
            error={errors.nodeShellImage}
            onChange={(e) => update({ nodeShellImage: e.target.value })}
            data-testid="settings-node-shell-image"
          />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Network</h2>
        <Input
          label="Proxy URL"
          help="For this cluster's API server. Empty uses the kubeconfig's proxy-url, if it has one"
          className={styles.mono}
          value={draft.proxyUrl}
          error={errors.proxyUrl}
          onChange={(e) => update({ proxyUrl: e.target.value })}
          data-testid="settings-proxy-url"
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Metrics</h2>
        <RadioGroup
          legend="Metrics provider"
          value={draft.provider}
          options={PROVIDERS}
          onChange={pickProvider}
          testId="settings-metrics"
        />
        {draft.provider === "prometheus" ? (
          <div className={styles.promGrid}>
            <Input
              label="Namespace"
              className={styles.mono}
              value={draft.promNamespace}
              error={errors.promNamespace}
              onChange={(e) => update({ promNamespace: e.target.value })}
              data-testid="settings-prom-namespace"
            />
            <Input
              label="Service"
              className={styles.mono}
              value={draft.promService}
              error={errors.promService}
              onChange={(e) => update({ promService: e.target.value })}
              data-testid="settings-prom-service"
            />
            <Input
              label="Port"
              inputMode="numeric"
              className={styles.mono}
              value={draft.promPort}
              error={errors.promPort}
              onChange={(e) => update({ promPort: e.target.value })}
              data-testid="settings-prom-port"
            />
            <div className={styles.schemeField}>
              <span className={styles.fieldLabel} aria-hidden="true">
                Scheme
              </span>
              <Segmented
                label="Scheme"
                value={draft.promScheme}
                options={SCHEMES}
                onChange={(promScheme) => update({ promScheme })}
                testId="settings-prom-scheme"
              />
            </div>
            <Input
              label="Path prefix"
              placeholder="/prometheus for Mimir"
              className={styles.mono}
              value={draft.promPrefix}
              error={errors.promPrefix}
              onChange={(e) => update({ promPrefix: e.target.value })}
              data-testid="settings-prom-prefix"
            />
            <Input
              label="Tenant"
              placeholder="X-Scope-OrgID, empty for none"
              className={styles.mono}
              value={draft.promTenant}
              error={errors.promTenant}
              onChange={(e) => update({ promTenant: e.target.value })}
              data-testid="settings-prom-tenant"
            />
            <ClusterLabelField
              name={draft.promLabelName}
              value={draft.promLabelValue}
              nameError={errors.promLabelName}
              valueError={errors.promLabelValue}
              onName={(promLabelName) => update({ promLabelName })}
              onValue={(promLabelValue) => update({ promLabelValue })}
              testId="settings-prom-label"
            />
          </div>
        ) : null}
        {draft.provider === "remote" ? (
          <div className={styles.promGrid}>
            <div className={styles.wide}>
              <Input
                label="URL"
                placeholder="https://mimir.example.com/prometheus"
                className={styles.mono}
                value={draft.remoteUrl}
                error={errors.remoteUrl}
                onChange={(e) => update({ remoteUrl: e.target.value })}
                data-testid="settings-remote-url"
              />
            </div>
            <Input
              label="Tenant"
              placeholder="X-Scope-OrgID, empty for none"
              className={styles.mono}
              value={draft.remoteTenant}
              error={errors.remoteTenant}
              onChange={(e) => update({ remoteTenant: e.target.value })}
              data-testid="settings-remote-tenant"
            />
            <ClusterLabelField
              name={draft.remoteLabelName}
              value={draft.remoteLabelValue}
              nameError={errors.remoteLabelName}
              valueError={errors.remoteLabelValue}
              onName={(remoteLabelName) => update({ remoteLabelName })}
              onValue={(remoteLabelValue) => update({ remoteLabelValue })}
              testId="settings-remote-label"
            />
            <div className={`${styles.schemeField} ${styles.wide}`}>
              <span className={styles.fieldLabel} aria-hidden="true">
                Authentication
              </span>
              <Segmented
                label="Authentication"
                value={draft.remoteAuth}
                options={AUTHS}
                onChange={pickAuth}
                testId="settings-remote-auth"
              />
            </div>
            {draft.remoteAuth === "basic" ? (
              <>
                <Input
                  label="Username"
                  value={draft.remoteUsername}
                  error={errors.remoteUsername}
                  onChange={(e) => update({ remoteUsername: e.target.value })}
                  data-testid="settings-remote-username"
                />
                <Input
                  label="Password"
                  type="password"
                  autoComplete="off"
                  placeholder={keptSecret ? SAVED_SECRET : undefined}
                  value={secret}
                  error={errors.remoteSecret}
                  onChange={(e) => typeSecret(e.target.value)}
                  data-testid="settings-remote-password"
                />
              </>
            ) : null}
            {draft.remoteAuth === "bearer" ? (
              <Input
                label="Token"
                type="password"
                autoComplete="off"
                placeholder={keptSecret ? SAVED_SECRET : undefined}
                value={secret}
                error={errors.remoteSecret}
                onChange={(e) => typeSecret(e.target.value)}
                data-testid="settings-remote-token"
              />
            ) : null}
            {draft.remoteAuth === "mtls" ? (
              <>
                <PathField
                  label="Certificate file"
                  value={draft.remoteCert}
                  error={fileErrors.remoteCert}
                  onChange={(remoteCert) => update({ remoteCert })}
                  testId="settings-remote-cert"
                />
                <PathField
                  label="Key file"
                  help="An unencrypted PEM key: PKCS#8, RSA or EC"
                  value={draft.remoteKey}
                  error={fileErrors.remoteKey}
                  onChange={(remoteKey) => update({ remoteKey })}
                  testId="settings-remote-key"
                />
              </>
            ) : null}
            <PathField
              label="CA file"
              help="Optional: PEM certificates to trust besides the system's"
              value={draft.remoteCa}
              error={fileErrors.remoteCa}
              onChange={(remoteCa) => update({ remoteCa })}
              testId="settings-remote-ca"
            />
          </div>
        ) : null}
      </section>

      {agentsSupported() ? (
        <AgentCard
          clusterName={props.name}
          draft={draft}
          errors={errors}
          update={update}
          namespaces={
            props.namespaces.length > 0
              ? props.namespaces
              : saved.accessibleNamespaces
          }
        />
      ) : null}

      <footer className={styles.footer}>
        <p
          className={styles.status}
          role="status"
          data-testid="settings-status"
        >
          {statusText(errors, changed, justSaved)}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setSecret("");
            update(emptyDraft());
          }}
          data-testid="settings-restore"
        >
          Restore defaults
        </Button>
        <Button
          size="sm"
          disabled={!changed}
          onClick={() => {
            setDraft(draftFrom(saved));
            setSecret("");
            setFileErrors({});
            setJustSaved(false);
          }}
          data-testid="settings-reset"
        >
          Reset
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSave}
          loading={saving}
          data-testid="settings-save"
        >
          Save
        </Button>
      </footer>
    </form>
  );
}

/** The Settings page of one cluster, connected or not. */
export function ClusterSettingsScreen(props: { clusterId: string }) {
  const { clusterId } = props;
  const cluster = useCatalog((s) => s.clusters.find((c) => c.id === clusterId));
  const state = useClusterState(clusterId);
  const navigate = useNavigate();
  const settings = useFetch(clusterId, () => api.clusterSettingsGet(clusterId));
  const name = cluster?.name ?? clusterId;
  const connected = state.status === "connected";

  async function stopAllowing(): Promise<void> {
    try {
      await api.clusterExecForget(clusterId);
    } catch (error) {
      toast.error("Could not stop allowing", failureMessage(error));
    }
  }

  let body: ReactNode;
  if (settings.error) {
    body = (
      <ErrorNotice
        title="Could not read the settings"
        message={settings.error.message}
        onRetry={settings.retry}
      />
    );
  } else if (settings.value === undefined) {
    body = <Spinner label="Loading" />;
  } else {
    body = (
      <SettingsForm
        clusterId={clusterId}
        name={name}
        contextName={cluster?.contextName ?? clusterId}
        namespaces={state.status === "connected" ? state.info.namespaces : []}
        initial={settings.value}
      />
    );
  }

  return (
    <div className={styles.page} data-testid="cluster-settings">
      <div className={styles.column}>
        <header className={styles.head}>
          <div className={styles.titles}>
            <h1 className={styles.title} data-testid="settings-title">
              Settings for {name}
            </h1>
            {cluster ? (
              <p className={styles.sub}>
                Context {cluster.contextName} in {cluster.source.path}. These
                settings stay in SkoposIDE; the kubeconfig file is not changed.
              </p>
            ) : null}
            {cluster
              ? connectionNotes(cluster).map((note) => (
                  <p
                    key={note.id}
                    className={styles.note}
                    data-testid={`settings-note-${note.id}`}
                  >
                    <Badge tone={note.tone}>{note.label}</Badge>
                    <span>{note.detail}</span>
                  </p>
                ))
              : null}
            {cluster?.execAllowed && cluster.execCommand !== null ? (
              <p
                className={`${styles.note} ${styles.allowed}`}
                data-testid="settings-exec-allowed"
              >
                <span>Allowed to run when you connect.</span>
                <Button
                  size="sm"
                  data-testid="settings-exec-forget"
                  onClick={() => void stopAllowing()}
                >
                  Stop allowing
                </Button>
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            onClick={() => navigate(overviewPath(clusterId))}
            data-testid="settings-back"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {connected ? `Back to ${name}` : `Open ${name}`}
          </Button>
        </header>
        {body}
      </div>
    </div>
  );
}

/** The `settings` child route of a cluster. */
export function ClusterSettingsRoute() {
  const { id = "" } = useParams();
  return <ClusterSettingsScreen key={id} clusterId={id} />;
}
