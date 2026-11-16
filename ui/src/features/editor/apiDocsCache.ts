import { useCallback, useEffect, useState } from "react";
import { api } from "../../ipc/api";
import type { KindSchema } from "../../ipc/generated/KindSchema";
import type { ApiDocsTarget } from "./apiDocsKind";

export type KindSchemaState =
  | { status: "loading" }
  | { status: "ready"; schema: KindSchema }
  | { status: "failed"; error: unknown };

/** Requests in flight, so tabs that ask together share one. */
const asked = new Map<string, Promise<KindSchema>>();
/** Answers, kept for the run (spec L16). Errors are never kept. */
const answered = new Map<string, KindSchema>();

function cacheKey(clusterId: string, target: ApiDocsTarget): string {
  return JSON.stringify([clusterId, target.apiVersion, target.kind]);
}

/** The kind's API docs: kept, in flight, or asked for now. */
export function loadKindSchema(
  clusterId: string,
  target: ApiDocsTarget,
): Promise<KindSchema> {
  const key = cacheKey(clusterId, target);
  const kept = answered.get(key);
  if (kept) return Promise.resolve(kept);
  let request = asked.get(key);
  if (!request) {
    request = api.apiSchema(clusterId, target.apiVersion, target.kind).then(
      (schema) => {
        answered.set(key, schema);
        asked.delete(key);
        return schema;
      },
      (error: unknown) => {
        asked.delete(key);
        throw error;
      },
    );
    asked.set(key, request);
  }
  return request;
}

/**
 * The API docs of `target` on the cluster, and Retry, which asks again (spec L16, L25).
 * Null when there is no kind to ask for.
 */
export function useKindSchema(
  clusterId: string,
  target: ApiDocsTarget | null,
): [KindSchemaState | null, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    state: KindSchemaState;
  } | null>(null);
  const apiVersion = target?.apiVersion;
  const kind = target?.kind;
  const key =
    apiVersion === undefined || kind === undefined
      ? null
      : cacheKey(clusterId, { apiVersion, kind });

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt is what makes Retry ask again.
  useEffect(() => {
    if (apiVersion === undefined || kind === undefined) return;
    const asking = cacheKey(clusterId, { apiVersion, kind });
    if (answered.has(asking)) return;
    let current = true;
    setState({ key: asking, state: { status: "loading" } });
    loadKindSchema(clusterId, { apiVersion, kind }).then(
      (schema) => {
        if (current)
          setState({ key: asking, state: { status: "ready", schema } });
      },
      (error: unknown) => {
        if (current)
          setState({ key: asking, state: { status: "failed", error } });
      },
    );
    return () => {
      current = false;
    };
  }, [clusterId, apiVersion, kind, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (key === null) return [null, retry];
  const kept = answered.get(key);
  if (kept) return [{ status: "ready", schema: kept }, retry];
  if (state?.key === key) return [state.state, retry];
  return [{ status: "loading" }, retry];
}

export function resetApiDocsCacheForTest(): void {
  asked.clear();
  answered.clear();
}
