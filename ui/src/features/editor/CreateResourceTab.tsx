import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorNotice,
  PickerMenu,
} from "../../design";
import { ChevronDown, Sparkles } from "../../design/icons";
import { api } from "../../ipc/api";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ApplyResult } from "../../ipc/generated/ApplyResult";
import {
  type DockTab,
  readDraft,
  useDock,
  writeDraft,
} from "../../stores/dock";
import { useProposals } from "../../stores/proposals";
import { registerTabSource } from "../../stores/tabSources";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import { AiBar } from "./AiBar";
import { useCreateTarget } from "./apiDocsKind";
import { ApiDocsButton, EditorLayout } from "./EditorLayout";
import { ProposalBar } from "./ProposalBar";
import { servedKinds } from "./servedKinds";
import type { Template } from "./templates/catalog";
import { templateSections } from "./templates/pickerSections";
import { useYamlCheck } from "./useYamlCheck";
import { yamlProblem } from "./validate";
import { YamlDiff } from "./YamlDiff";
import { YamlEditor } from "./YamlEditor";
import styles from "./YamlEditor.module.css";

export interface CreateDraft {
  text: string;
  /** Text that counts as nothing to lose: a template as it came, or what was applied. */
  baseline: string;
  results: ApplyResult[];
  /** Opened by Draft with AI: the AI bar starts open. */
  ai?: boolean;
}

/** Where documents with no namespace go: the first in the cluster's filter. */
async function defaultNamespace(clusterId: string): Promise<string> {
  try {
    const saved = await api.uiStateGet(namespaceFilterKey(clusterId));
    if (Array.isArray(saved) && typeof saved[0] === "string" && saved[0]) {
      return saved[0];
    }
  } catch {
    // No saved filter to go by.
  }
  return "default";
}

function resultLabel(result: ApplyResult): string {
  if (!result.kind || !result.name) return `Document ${result.index + 1}`;
  const object = result.namespace
    ? `${result.namespace}/${result.name}`
    : result.name;
  return `${result.kind} ${object}`;
}

/** Applies multi-document YAML and reports each document on its own. */
export function CreateResourceTab(props: {
  tab: Extract<DockTab, { kind: "create" }>;
  resources: ApiResourceInfo[];
}) {
  const { id, clusterId } = props.tab;
  const [restored] = useState(() => readDraft<CreateDraft>(id));
  const [text, setText] = useState(restored?.text ?? "");
  const [baseline, setBaseline] = useState(restored?.baseline ?? "");
  const [results, setResults] = useState(restored?.results ?? []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [replacing, setReplacing] = useState<Template | null>(null);
  const served = useMemo(() => servedKinds(props.resources), [props.resources]);
  const [caret, setCaret] = useState(0);
  const target = useCreateTarget(text, caret);
  const hints = useMemo(
    () => ({ clusterId, fixedTarget: null, served }),
    [clusterId, served],
  );
  const [aiOpen, setAiOpen] = useState(restored?.ai ?? false);
  const [replace, setReplace] = useState<{ id: number; text: string } | null>(
    null,
  );
  const pending = useProposals((s) => s.byTab[id] ?? null);
  const latestText = useRef(text);
  latestText.current = text;
  useEffect(
    () =>
      registerTabSource(id, async () => ({
        tabId: id,
        title: props.tab.title,
        cluster: clusterId,
        mode: "create",
        yaml: latestText.current,
        target: null,
        defaultNamespace: await defaultNamespace(clusterId),
      })),
    [id, clusterId, props.tab.title],
  );

  const dirty = text.trim() !== "" && text !== baseline;
  // `unchecked` while a long text waits for its check: it is not sent before.
  const { check, pending: unchecked } = useYamlCheck(text);

  useEffect(() => {
    useDock.getState().setDirty(id, dirty);
  }, [id, dirty]);

  useEffect(() => {
    writeDraft(id, {
      text,
      baseline,
      results,
      ai: aiOpen,
    } satisfies CreateDraft);
  }, [id, text, baseline, results, aiOpen]);

  function fill(template: Template): void {
    setText(template.yaml);
    setBaseline(template.yaml);
    setResults([]);
    setFailure(null);
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setFailure(null);
    setResults([]);
    try {
      const namespace = await defaultNamespace(clusterId);
      const applied = await api.resourceApply(clusterId, text, namespace);
      setResults(applied);
      if (applied.every((r) => r.ok)) setBaseline(text);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.tab}>
      <div className={styles.toolbar}>
        <PickerMenu
          label="Templates"
          searchLabel="Search templates"
          width={300}
          testId="create-template-picker"
          empty={(query) => `No template matches "${query}".`}
          sections={templateSections(served, (template) =>
            dirty ? setReplacing(template) : fill(template),
          )}
          trigger={({ open, toggle }) => (
            <Button
              size="sm"
              aria-expanded={open}
              disabled={pending !== null}
              onClick={toggle}
              data-testid="create-template"
            >
              Template
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          )}
        />
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={
            pending !== null || !check.ok || check.documents === 0 || unchecked
          }
          onClick={() => void apply()}
          data-testid="create-apply"
        >
          Apply
        </Button>
        <span className={styles.hint}>
          A document with no namespace goes to the first namespace selected in
          the namespace filter, or to default.
        </span>
        <Button
          size="sm"
          className={styles.aiToggle}
          aria-pressed={aiOpen}
          onClick={() => setAiOpen((open) => !open)}
          data-testid="yaml-ai"
        >
          <Sparkles size={14} aria-hidden="true" />
          Ask AI
        </Button>
        <ApiDocsButton />
      </div>
      {aiOpen ? (
        <AiBar
          tabId={id}
          placeholder="Describe the objects to create"
          disabled={pending !== null}
          onClose={() => setAiOpen(false)}
        />
      ) : null}
      {pending ? (
        <ProposalBar
          card={pending.card}
          onAccept={() => {
            const next = useProposals.getState().accept(id);
            if (next !== null)
              setReplace((last) => ({ id: (last?.id ?? 0) + 1, text: next }));
          }}
          onReject={() => useProposals.getState().reject(id)}
        />
      ) : null}
      {check.ok ? null : (
        <div className={styles.problem} role="alert" data-testid="yaml-error">
          {yamlProblem(check)}
        </div>
      )}
      {failure ? (
        <div className={styles.apiError} data-testid="yaml-api-error">
          <ErrorNotice
            title="Nothing was applied"
            message={failureMessage(failure)}
            details={
              failure instanceof IpcFailure ? failure.details : undefined
            }
          />
        </div>
      ) : null}
      <EditorLayout clusterId={clusterId} target={target}>
        <div className={styles.stack}>
          <div className={styles.layer} hidden={pending !== null}>
            <YamlEditor
              value={text}
              onChange={setText}
              onCaret={setCaret}
              readOnly={busy}
              hints={hints}
              replaceRequest={replace}
              testId="yaml-editor"
            />
          </div>
          {pending ? (
            <YamlDiff original={text} modified={pending.card.yaml} />
          ) : null}
        </div>
      </EditorLayout>
      {results.length > 0 ? (
        <ul className={styles.results} data-testid="apply-results">
          {results.map((result) => (
            <li
              key={result.index}
              className={styles.result}
              data-testid={`apply-result-${result.index}`}
              data-ok={result.ok}
            >
              <Badge tone={result.ok ? "ok" : "danger"}>
                {result.ok ? "Applied" : "Failed"}
              </Badge>
              <span className={styles.resultName}>{resultLabel(result)}</span>
              <span className={styles.resultMessage}>{result.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {replacing ? (
        <ConfirmDialog
          open
          title="Replace the text?"
          body={`The ${replacing.label} template replaces what you have typed.`}
          confirmLabel="Replace"
          danger
          onConfirm={() => {
            fill(replacing);
            setReplacing(null);
          }}
          onCancel={() => setReplacing(null)}
        />
      ) : null}
    </div>
  );
}
