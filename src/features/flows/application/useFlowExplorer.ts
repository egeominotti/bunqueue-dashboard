import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { BqError, captureServerRequestTarget } from '@/lib/bq';
import { isDemo } from '@/lib/demo/isDemo';
import { DEMO_FLOW_ROOT } from '../domain/flowConstants';
import type { Graph } from '../domain/flowSnapshot';
import {
  FlowSnapshotError,
  type FlowTraversalOptions,
  flowJobIdError,
  resolveFlowRoot,
} from '../domain/flowSnapshot';
import { walkFlow } from '../domain/flowTraversal';
import {
  type FlowToolMode,
  flowSearchParams,
  patchFlowSearchParams,
  readFlowUrlState,
} from '../domain/flowUrlState';
import { pushRecentFlow, type RecentFlow, readRecentFlows } from '../domain/recentFlows';

interface LoadedFlow {
  seed: string;
  graph: Graph;
  defaultSelected: string;
}

export function useFlowExplorer() {
  const [params, setParams] = useSearchParams();
  const fallbackRoot = isDemo() ? DEMO_FLOW_ROOT : '';
  const serializedParams = params.toString();
  const urlState = useMemo(
    () => readFlowUrlState(new URLSearchParams(serializedParams), fallbackRoot),
    [fallbackRoot, serializedParams]
  );
  const rootParam = urlState.root;
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const token = useConnectionStore((state) => state.token);
  const targetBaseUrl = getBaseUrl();
  const [input, setInput] = useState(rootParam);
  const [snapshot, setSnapshot] = useState<LoadedFlow | null>(null);
  const [loading, setLoading] = useState(Boolean(rootParam));
  const [error, setError] = useState<Error | null>(null);
  const [recent, setRecent] = useState<RecentFlow[]>(() =>
    readRecentFlows(targetBaseUrl, token.length === 0)
  );
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const connectionIdentity = useRef(currentConnectionIdentity());
  const graph = snapshot?.seed === rootParam ? snapshot.graph : null;
  const selected = graph
    ? urlState.node && graph.jobs.has(urlState.node)
      ? urlState.node
      : (snapshot?.defaultSelected ?? null)
    : null;

  const updateUrl = useCallback(
    (patch: Parameters<typeof patchFlowSearchParams>[1], replace = false) => {
      setParams((current) => patchFlowSearchParams(current, patch, fallbackRoot), { replace });
    },
    [fallbackRoot, setParams]
  );

  const load = useCallback(
    async (seed: string) => {
      const live = useConnectionStore.getState();
      if (live.baseUrl !== baseUrl || live.token !== token) return;
      activeRequest.current?.abort();
      activeRequest.current = null;
      const mine = ++requestId.current;
      const id = seed.trim();
      setSnapshot(null);
      setError(null);
      if (!id) return setLoading(false);
      const idError = flowJobIdError(id);
      if (idError) {
        setError(new FlowSnapshotError(idError));
        return setLoading(false);
      }
      const target = captureServerRequestTarget();
      const expectedConnection = currentConnectionIdentity();
      const controller = new AbortController();
      activeRequest.current = controller;
      const isCurrent = () =>
        mounted.current &&
        mine === requestId.current &&
        !controller.signal.aborted &&
        expectedConnection === currentConnectionIdentity();
      setLoading(true);
      try {
        const options: FlowTraversalOptions = { target, signal: controller.signal };
        const root = await resolveFlowRoot(id, options);
        const limitations = root.missingParent
          ? [
              `Ancestor ${root.missingParent} is no longer available. The graph starts at the oldest surviving node.`,
            ]
          : [];
        const next = await walkFlow(root.id, root.job, {
          ...options,
          seedPath: root.path,
          limitations,
        });
        if (!isCurrent()) return;
        setSnapshot({ seed: id, graph: next, defaultSelected: root.id });
        if (next.jobs.size > 1) {
          setRecent((list) =>
            pushRecentFlow(
              target.baseUrl,
              list,
              { root: root.id, nodes: next.jobs.size, at: Date.now() },
              useConnectionStore.getState().token.length === 0
            )
          );
        }
      } catch (caught) {
        if (isCurrent())
          setError(caught instanceof Error ? caught : new Error('Failed to load flow'));
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null;
        if (isCurrent()) setLoading(false);
      }
    },
    [baseUrl, token]
  );

  useEffect(() => {
    mounted.current = true;
    connectionIdentity.current = currentConnectionIdentity();
    const unsubscribe = useConnectionStore.subscribe(() => {
      const next = currentConnectionIdentity();
      if (next === connectionIdentity.current) return;
      connectionIdentity.current = next;
      requestId.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
      if (!mounted.current) return;
      setSnapshot(null);
      setError(null);
      setLoading(false);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      requestId.current += 1;
      activeRequest.current?.abort();
    };
  }, []);

  useEffect(
    () => setRecent(token ? [] : readRecentFlows(targetBaseUrl, true)),
    [targetBaseUrl, token]
  );
  useEffect(() => {
    const next = { ...urlState };
    if (graph && (!next.node || !graph.jobs.has(next.node))) {
      next.node = snapshot?.defaultSelected ?? null;
    }
    const canonical = flowSearchParams(next).toString();
    if (canonical !== serializedParams) setParams(canonical, { replace: true });
  }, [graph, serializedParams, setParams, snapshot?.defaultSelected, urlState]);
  useEffect(() => {
    setInput(rootParam);
    void load(rootParam);
  }, [rootParam, load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = input.trim();
    if (!id) return;
    if (flowJobIdError(id)) return void load(id);
    if (id === rootParam) void load(id);
    else updateUrl({ root: id, mode: 'explore', node: null });
  };
  const openRecent = (root: string) => {
    setInput(root);
    if (flowJobIdError(root)) return void load(root);
    const reloadCurrent = root === rootParam;
    updateUrl({ root, mode: 'explore', node: null });
    if (reloadCurrent) void load(root);
  };
  const setMode = (mode: FlowToolMode) => updateUrl({ mode });
  const setSelected = (node: string) => {
    if (graph?.jobs.has(node)) updateUrl({ node });
  };
  return {
    input,
    setInput,
    rootParam,
    mode: urlState.mode,
    setMode,
    graph,
    selected,
    setSelected,
    loading,
    error,
    recent,
    load,
    submit,
    openRecent,
  };
}

function currentConnectionIdentity(): string {
  const { token } = useConnectionStore.getState();
  return JSON.stringify([getBaseUrl(), token]);
}

export function isFlowConnectionFailure(error: Error): boolean {
  return (
    (error instanceof BqError && error.status === 0) ||
    ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
  );
}
