import {
  type ReactNode,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Button,
  CopyButton,
  Dialog,
  ErrorNotice,
  Input,
  Segmented,
  Select,
  Spinner,
  Switch,
  toast,
} from "../../design";
import { Check, CirclePause, CircleX } from "../../design/icons";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { BoundBinding } from "../../ipc/generated/BoundBinding";
import type { CertUserEvent } from "../../ipc/generated/CertUserEvent";
import type { RoleKind } from "../../ipc/generated/RoleKind";
import type { KubeObject } from "../../kinds/objects";
import { CLUSTER_ROLES, ROLES } from "../../kinds/refs";
import { useClusterNamespaces } from "../../stores/clusters";
import { useResourceList } from "../../stores/resources";
import own from "./access.module.css";
import {
  bindingLine,
  type CreateForm,
  type FormErrors,
  formErrors,
  grantIncomplete,
  hasErrors,
  INITIAL_FORM,
  INITIAL_RUN,
  LIFETIMES,
  plannedBinding,
  runReducer,
  type StepState,
  savedText,
  stepLabel,
  stepState,
  stepsFor,
  suggestedName,
  timeLeft,
  toRequest,
} from "./createUser";

const ROLE_KINDS: { value: RoleKind; label: string }[] = [
  { value: "ClusterRole", label: "ClusterRole" },
  { value: "Role", label: "Role" },
];
const SCOPES: { value: CreateForm["scope"]; label: string }[] = [
  { value: "cluster", label: "Whole cluster" },
  { value: "namespace", label: "One namespace" },
];
const WARNING =
  "A client certificate can't be revoked. It works until it expires. To take access away, remove the user from its bindings.";
const CANCELLED = "Cancelled. The signing request was deleted.";

function names(objects: readonly KubeObject[]): string[] {
  return [...new Set(objects.map((o) => o.metadata.name))].sort();
}

function StepMark({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <Check size={14} aria-hidden="true" />;
    case "running":
      return <Spinner />;
    case "waiting":
      return <CirclePause size={14} aria-hidden="true" />;
    case "failed":
      return <CircleX size={14} aria-hidden="true" />;
    case "pending":
      return <span className={own.pending} />;
  }
}

/** Someone else must approve: the command to give them and the time left. */
function Waiting({ csrName, deadline }: { csrName: string; deadline: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const command = `kubectl certificate approve ${csrName}`;
  return (
    <div className={own.waiting} data-testid="cu-waiting">
      <p>
        You may not approve this request. Ask someone who may approve
        kubernetes.io/kube-apiserver-client requests to run:
      </p>
      <div className={own.command}>
        <code className={own.mono} data-testid="cu-command">
          {command}
        </code>
        <CopyButton value={() => command} what="command" testId="cu-copy" />
      </div>
      <p className={own.help} data-testid="cu-left">
        Waiting up to 15 minutes · {timeLeft(deadline, now)} left
      </p>
    </div>
  );
}

/** Create a user with a client certificate (spec 2026-11-22 §5.3). Open while mounted. */
export function CreateUserDialog(props: {
  clusterId: string;
  onClose(): void;
}) {
  const { clusterId, onClose } = props;
  const [form, setForm] = useState<CreateForm>(INITIAL_FORM);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<"form" | "starting" | "running">("form");
  const [startError, setStartError] = useState<string | null>(null);
  const [sentBinding, setSentBinding] = useState<BoundBinding | null>(null);
  const [run, dispatch] = useReducer(runReducer, INITIAL_RUN);
  const namespaceList = useId();
  const roleList = useId();

  const namespaces = useClusterNamespaces(clusterId);
  const clusterRoles = useResourceList(
    clusterId,
    form.grant && form.roleKind === "ClusterRole" ? CLUSTER_ROLES : null,
  );
  // Every namespace in one subscription, filtered here, so typing a namespace does not
  // subscribe again on each key.
  const roles = useResourceList(
    clusterId,
    form.grant && form.roleKind === "Role" ? ROLES : null,
  );
  const roleNames =
    form.roleKind === "ClusterRole"
      ? names(clusterRoles.items)
      : names(
          roles.items.filter(
            (o) => o.metadata.namespace === form.namespace.trim(),
          ),
        );

  // The run, read by callbacks and the unmount cleanup, which see old renders.
  const runId = useRef<string | null>(null);
  const starting = useRef(false);
  const stopped = useRef(false);
  const ended = useRef(false);
  const mounted = useRef(true);
  const user = useRef("");
  const saved = useRef(false);
  const expiresAt = useRef<string | null>(null);
  const bindingFailed = useRef(false);

  /** Asks the core to stop a live run. True when there was one to tell the person about. */
  function cancelIfRunning(): boolean {
    if (ended.current || stopped.current) return false;
    if (runId.current === null && !starting.current) return false;
    stopped.current = true;
    const id = runId.current;
    // While the save dialog is open there is no id yet; `submit` cancels once it comes.
    if (id === null) return false;
    api.certUserCreateCancel(id).catch(() => {});
    return true;
  }

  function tellStopped() {
    const expiry = expiresAt.current;
    // After `saved` the core keeps the file.
    if (saved.current && expiry !== null)
      toast.success(savedText(user.current, expiry));
    else toast.info(CANCELLED);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup reads refs only.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (cancelIfRunning()) tellStopped();
    };
  }, []);

  function onEvent(event: CertUserEvent) {
    // Cancelled by the person: the toast is out and the dialog is closing.
    if (stopped.current) return;
    if (event.type === "issued") expiresAt.current = event.expiresAt;
    if (event.type === "saved") saved.current = true;
    if (event.type === "bindingFailed") bindingFailed.current = true;
    dispatch(event);
    if (
      event.type === "done" ||
      event.type === "failed" ||
      event.type === "cancelled"
    ) {
      ended.current = true;
      if (event.type === "done" && !bindingFailed.current && mounted.current) {
        toast.success(savedText(user.current, event.expiresAt));
        onClose();
      }
    }
  }

  async function submit() {
    setTried(true);
    if (hasErrors(formErrors(form)) || grantIncomplete(form)) return;
    setStartError(null);
    setSentBinding(plannedBinding(form));
    user.current = form.user.trim();
    starting.current = true;
    setPhase("starting");
    try {
      const id = await api.certUserCreateStart(
        clusterId,
        toRequest(form),
        suggestedName(form.user),
        onEvent,
      );
      starting.current = false;
      if (id === null) {
        if (mounted.current) setPhase("form");
        return;
      }
      runId.current = id;
      // Closed or left while the save dialog was open.
      if (stopped.current) {
        api.certUserCreateCancel(id).catch(() => {});
        return;
      }
      setPhase("running");
    } catch (error) {
      starting.current = false;
      if (!mounted.current) return;
      setStartError(failureMessage(error));
      setPhase("form");
    }
  }

  function close() {
    if (cancelIfRunning()) tellStopped();
    onClose();
  }

  const set = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  let title: string;
  let body: ReactNode;
  let footer: ReactNode;
  if (phase === "running") {
    const over = run.end !== null;
    title = `Creating ${user.current}`;
    body = (
      <div className={own.form}>
        <ol className={own.steps} data-testid="cu-steps">
          {stepsFor(sentBinding).map((step) => {
            const state = stepState(run, step);
            return (
              <li
                key={step}
                className={own.step}
                data-testid={`cu-step-${step}`}
                data-state={state}
              >
                <span className={own.mark} aria-hidden="true">
                  <StepMark state={state} />
                </span>
                <span>{stepLabel(step, run, sentBinding)}</span>
                {step === "submit" && run.csrName !== null ? (
                  <span className={own.mono} data-testid="cu-csr">
                    {run.csrName}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
        {run.deadline !== null && run.csrName !== null && !over ? (
          <Waiting csrName={run.csrName} deadline={run.deadline} />
        ) : null}
        {run.end?.type === "failed" ? (
          <div data-testid="cu-ended">
            <ErrorNotice
              title="Could not create the user"
              message={run.end.error.message}
            />
          </div>
        ) : null}
        {run.bindingError !== null && run.binding !== null ? (
          <div className={own.notice} role="status" data-testid="cu-ended">
            <strong>
              The kubeconfig is saved, but the {run.binding.kind} was not
              created
            </strong>
            <p>{run.bindingError.message}</p>
          </div>
        ) : null}
      </div>
    );
    footer = over ? (
      <Button variant="primary" onClick={close} data-testid="cu-close">
        Close
      </Button>
    ) : (
      <Button onClick={close} data-testid="cu-cancel">
        Cancel
      </Button>
    );
  } else {
    const errors: FormErrors = tried ? formErrors(form) : {};
    const planned = plannedBinding(form);
    const inNamespace = form.roleKind === "Role" || form.scope === "namespace";
    title = "Create a user with a client certificate";
    body = (
      <div className={own.form}>
        <Input
          label="User name"
          value={form.user}
          onChange={(e) => set("user", e.target.value)}
          help="The certificate's common name (CN). Kubernetes reads it as the user name."
          error={errors.user}
          autoComplete="off"
          data-testid="cu-user"
        />
        <Input
          label="Groups"
          placeholder="payments-devs, oncall"
          value={form.groups}
          onChange={(e) => set("groups", e.target.value)}
          help="Comma-separated. Each becomes an organization (O) in the certificate."
          error={errors.groups}
          autoComplete="off"
          data-testid="cu-groups"
        />
        <div>
          <Select
            label="Certificate lifetime"
            value={form.lifetime}
            options={LIFETIMES}
            onChange={(v) => set("lifetime", v)}
            testId="cu-lifetime"
          />
          <p className={own.help}>
            The cluster's signer may issue a shorter certificate.
          </p>
        </div>
        <Switch
          label="Grant access"
          checked={form.grant}
          onChange={(v) => set("grant", v)}
          testId="cu-grant"
        />
        {form.grant ? (
          <>
            <Segmented
              label="Role kind"
              value={form.roleKind}
              options={ROLE_KINDS}
              onChange={(v) => set("roleKind", v)}
              testId="cu-role-kind"
            />
            {form.roleKind === "ClusterRole" ? (
              <Segmented
                label="Scope"
                value={form.scope}
                options={SCOPES}
                onChange={(v) => set("scope", v)}
                testId="cu-scope"
              />
            ) : null}
            {inNamespace ? (
              <>
                <Input
                  label="Namespace"
                  value={form.namespace}
                  onChange={(e) => set("namespace", e.target.value)}
                  error={errors.namespace}
                  list={namespaceList}
                  autoComplete="off"
                  data-testid="cu-namespace"
                />
                <datalist id={namespaceList} data-testid="cu-namespace-options">
                  {namespaces.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </>
            ) : null}
            <Input
              label="Role"
              value={form.role}
              onChange={(e) => set("role", e.target.value)}
              list={roleList}
              autoComplete="off"
              data-testid="cu-role"
            />
            <datalist id={roleList} data-testid="cu-role-options">
              {roleNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            {planned !== null ? (
              <p className={own.help} data-testid="cu-binding-line">
                {bindingLine(planned)}
              </p>
            ) : null}
          </>
        ) : null}
        <div className={own.notice} data-testid="cu-warning">
          <p>{WARNING}</p>
        </div>
        {startError !== null ? (
          <ErrorNotice title="Could not create the user" message={startError} />
        ) : null}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={close} data-testid="cu-cancel">
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            void submit();
          }}
          disabled={grantIncomplete(form)}
          loading={phase === "starting"}
          data-testid="cu-submit"
        >
          Create and save…
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={title}
      testId="cu-dialog"
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
