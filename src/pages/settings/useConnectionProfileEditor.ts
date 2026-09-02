import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BASE_URL_ERROR,
  normalizeBaseUrl,
  useConnectionStore,
} from '@/components/dashboard/stores/connectionStore';
import { fetchHealthWithTimeout, fetchJsonWithTimeout } from './health';

type Notice = { ok: boolean; msg: string } | null;

export function useConnectionProfileEditor() {
  const connection = useConnectionStore();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [agentUrl, setAgentUrl] = useState('');
  const [tok, setTok] = useState('');
  const [agentTok, setAgentTok] = useState('');
  const [testing, setTesting] = useState<'server' | 'agent' | null>(null);
  const [result, setResult] = useState<Notice>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [agentUrlError, setAgentUrlError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<Notice>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSaveNotice = useCallback(() => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    if (mounted.current) setSaveNotice(null);
  }, []);
  const invalidateTest = useCallback(() => {
    generation.current += 1;
    controller.current?.abort(new DOMException('Connection test superseded', 'AbortError'));
    controller.current = null;
    if (mounted.current) {
      setTesting(null);
      setResult(null);
    }
  }, []);
  const edit = useCallback(() => {
    invalidateTest();
    clearSaveNotice();
  }, [clearSaveNotice, invalidateTest]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      controller.current?.abort(new DOMException('Settings unmounted', 'AbortError'));
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    };
  }, []);

  useEffect(() => {
    const profile = connection.profiles.find(
      (candidate) => candidate.id === connection.activeProfileId
    );
    setName(profile?.name ?? 'Bunqueue');
    setUrl(connection.baseUrl);
    setAgentUrl(connection.agentBaseUrl);
    setTok(connection.token);
    setAgentTok(connection.agentToken);
    setUrlError(null);
    setAgentUrlError(null);
    invalidateTest();
  }, [
    connection.activeProfileId,
    connection.agentBaseUrl,
    connection.baseUrl,
    connection.profiles,
    connection.token,
    connection.agentToken,
    invalidateTest,
  ]);

  const identity = () => {
    const current = useConnectionStore.getState();
    return JSON.stringify([
      current.activeProfileId,
      current.baseUrl,
      current.agentBaseUrl,
      current.token,
      current.agentToken,
    ]);
  };

  const runTest = async (kind: 'server' | 'agent') => {
    invalidateTest();
    const base = normalizeBaseUrl(kind === 'server' ? url : agentUrl);
    if (!base) {
      if (kind === 'server') setUrlError(BASE_URL_ERROR);
      else setAgentUrlError(BASE_URL_ERROR);
      setResult({ ok: false, msg: BASE_URL_ERROR });
      return;
    }
    if (kind === 'server') setUrlError(null);
    else setAgentUrlError(null);
    const requestGeneration = generation.current;
    const requestController = new AbortController();
    const storedIdentity = identity();
    const canPublish = () =>
      mounted.current &&
      requestGeneration === generation.current &&
      !requestController.signal.aborted &&
      identity() === storedIdentity;
    controller.current = requestController;
    setTesting(kind);
    setResult(null);
    const started = performance.now();
    try {
      if (kind === 'server') {
        const { response, health } = await fetchHealthWithTimeout(`${base}/health`, {
          headers: tok.trim() ? { Authorization: `Bearer ${tok.trim()}` } : undefined,
          signal: requestController.signal,
        });
        if (!canPublish()) return;
        const degraded = response.status === 503 || health.status === 'degraded';
        setResult({
          ok: !degraded,
          msg: `${degraded ? 'Server reachable' : 'Connected'} in ${Math.round(performance.now() - started)}ms · bunqueue v${health.version}${degraded ? ' · degraded' : ''}`,
        });
      } else {
        const { response, value } = await fetchJsonWithTimeout(`${base}/control/status`, {
          headers: agentTok.trim() ? { Authorization: `Bearer ${agentTok.trim()}` } : undefined,
          signal: requestController.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Malformed control agent response');
        }
        const status = value as { status?: unknown; storageMode?: unknown };
        if (!['running', 'stopped', 'starting', 'stopping'].includes(String(status.status))) {
          throw new Error('Malformed control agent response');
        }
        if (!canPublish()) return;
        setResult({
          ok: true,
          msg: `Agent connected in ${Math.round(performance.now() - started)}ms · server ${status.status}${status.storageMode ? ` · ${status.storageMode}` : ''}`,
        });
      }
    } catch (error) {
      if (canPublish()) setResult({ ok: false, msg: (error as Error).message });
    } finally {
      if (mounted.current && requestGeneration === generation.current) {
        controller.current = null;
        setTesting(null);
      }
    }
  };

  const save = () => {
    invalidateTest();
    const server = normalizeBaseUrl(url);
    const agent = normalizeBaseUrl(agentUrl);
    setUrlError(server ? null : BASE_URL_ERROR);
    setAgentUrlError(agent ? null : BASE_URL_ERROR);
    if (!server || !agent) return;
    const outcome = connection.saveConnection({
      name,
      baseUrl: server,
      agentBaseUrl: agent,
      token: tok,
      agentToken: agentTok,
    });
    clearSaveNotice();
    setSaveNotice({
      ok: outcome.persisted,
      msg: outcome.persisted
        ? 'Saved ✓'
        : `Saved for this session only — browser storage unavailable${outcome.error ? `: ${outcome.error}` : '.'}`,
    });
    noticeTimer.current = setTimeout(() => mounted.current && setSaveNotice(null), 4000);
  };

  const add = () => {
    edit();
    connection.addProfile({
      name: `Bunqueue ${connection.profiles.length + 1}`,
      baseUrl: 'http://localhost:6790',
      agentBaseUrl: 'http://localhost:6800',
      token: '',
      agentToken: '',
    });
  };

  const remove = () => {
    const profile = connection.profiles.find(
      (candidate) => candidate.id === connection.activeProfileId
    );
    if (!profile || !window.confirm(`Remove connection profile "${profile.name}"?`)) return;
    connection.removeProfile(profile.id);
  };

  return {
    ...connection,
    name,
    setName,
    url,
    setUrl,
    agentUrl,
    setAgentUrl,
    tok,
    setTok,
    agentTok,
    setAgentTok,
    testing,
    result,
    urlError,
    agentUrlError,
    saveNotice,
    edit,
    save,
    add,
    remove,
    testServer: () => runTest('server'),
    testAgent: () => runTest('agent'),
  };
}
