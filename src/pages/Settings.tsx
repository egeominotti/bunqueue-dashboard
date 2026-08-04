import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BASE_URL_ERROR,
  normalizeBaseUrl,
  useConnectionStore,
} from '@/components/dashboard/stores/connectionStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/form';
import { IconEye } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';

// Compatibility for callers/tests that historically imported this validator
// from Settings. Its single implementation lives at the store trust boundary.
export { isValidBaseUrl } from '@/components/dashboard/stores/connectionStore';

import { AppearanceCard } from './settings/AppearanceCard';
import { fetchHealthWithTimeout } from './settings/health';

export { fetchHealthWithTimeout, SETTINGS_TEST_TIMEOUT_MS } from './settings/health';

export function Settings() {
  const { baseUrl, token, agentToken, saveConnection } = useConnectionStore();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // Buffer the connection fields locally: committing to the store on every
  // keystroke would retarget all polling at a half-typed URL.
  const [url, setUrl] = useState(baseUrl);
  const [tok, setTok] = useState(token);
  const [agentTok, setAgentTok] = useState(agentToken);
  const [showToken, setShowToken] = useState(false);
  const [showAgentToken, setShowAgentToken] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{
    persisted: boolean;
    message: string;
  } | null>(null);
  const mountedRef = useRef(true);
  const testGenerationRef = useRef(0);
  const testControllerRef = useRef<AbortController | null>(null);
  const saveNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSaveNotice = useCallback(() => {
    if (saveNoticeTimerRef.current !== null) {
      clearTimeout(saveNoticeTimerRef.current);
      saveNoticeTimerRef.current = null;
    }
    if (mountedRef.current) setSaveNotice(null);
  }, []);

  const invalidateTest = useCallback(() => {
    testGenerationRef.current += 1;
    testControllerRef.current?.abort(new DOMException('Connection test superseded', 'AbortError'));
    testControllerRef.current = null;
    if (mountedRef.current) {
      setTesting(false);
      setResult(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      testGenerationRef.current += 1;
      testControllerRef.current?.abort(new DOMException('Settings unmounted', 'AbortError'));
      testControllerRef.current = null;
      if (saveNoticeTimerRef.current !== null) {
        clearTimeout(saveNoticeTimerRef.current);
        saveNoticeTimerRef.current = null;
      }
    };
  }, []);

  // A connection change can also come from AuthGate or another mounted view.
  // Keep the draft aligned and invalidate any result produced for the old
  // URL/token pair before it is allowed to publish.
  useEffect(() => {
    setUrl(baseUrl);
    setTok(token);
    setAgentTok(agentToken);
    invalidateTest();
  }, [agentToken, baseUrl, invalidateTest, token]);

  const save = () => {
    invalidateTest();
    const normalized = normalizeBaseUrl(url);
    if (!normalized) {
      setUrlError(BASE_URL_ERROR);
      return;
    }
    setUrlError(null);
    setUrl(normalized);
    const outcome = saveConnection({
      baseUrl: normalized,
      token: tok,
      agentToken: agentTok,
    });
    clearSaveNotice();
    setSaveNotice({
      persisted: outcome.persisted,
      message: outcome.persisted
        ? 'Saved ✓'
        : `Saved for this session only — browser storage unavailable${
            outcome.error ? `: ${outcome.error}` : '.'
          }`,
    });
    saveNoticeTimerRef.current = setTimeout(() => {
      saveNoticeTimerRef.current = null;
      if (mountedRef.current) setSaveNotice(null);
    }, 4000);
  };

  // Tests the values currently in the form (not the saved store), so you can
  // verify a new URL/token before committing it with Save.
  const test = async () => {
    invalidateTest();
    const base = normalizeBaseUrl(url);
    if (!base) {
      setUrlError(BASE_URL_ERROR);
      setResult({
        ok: false,
        msg: BASE_URL_ERROR,
      });
      return;
    }
    setUrlError(null);
    const generation = testGenerationRef.current;
    const controller = new AbortController();
    const storedConnection = useConnectionStore.getState();
    const canPublish = () => {
      const current = useConnectionStore.getState();
      return (
        mountedRef.current &&
        generation === testGenerationRef.current &&
        !controller.signal.aborted &&
        current.baseUrl === storedConnection.baseUrl &&
        current.token === storedConnection.token &&
        current.agentToken === storedConnection.agentToken
      );
    };
    testControllerRef.current = controller;
    setTesting(true);
    setResult(null);
    const t0 = performance.now();
    try {
      const { response: res, health } = await fetchHealthWithTimeout(`${base}/health`, {
        headers: tok.trim() ? { Authorization: `Bearer ${tok.trim()}` } : undefined,
        signal: controller.signal,
      });
      if (!canPublish()) return;
      // /health's `ok` is a health flag, not a request-success flag (strict:false).
      const ms = Math.round(performance.now() - t0);
      const degraded = res.status === 503 || health.status === 'degraded';
      setResult({
        ok: !degraded,
        msg: `${degraded ? 'Server reachable' : 'Connected'} in ${ms}ms · bunqueue v${
          health.version
        }${degraded ? ' · degraded' : ''}`,
      });
    } catch (e) {
      if (!canPublish()) return;
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      if (mountedRef.current && generation === testGenerationRef.current) {
        testControllerRef.current = null;
        setTesting(false);
      }
    }
  };

  return (
    <div>
      <PageHeader title="Settings" description="Connection and appearance." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connection" />
          <div className="flex flex-col gap-4">
            <Field label="Server URL">
              <Input
                name="server-url"
                value={url}
                onChange={(e) => {
                  invalidateTest();
                  clearSaveNotice();
                  setUrl(e.target.value);
                  setUrlError(null);
                }}
                placeholder="/api or https://queue.example.com"
                autoComplete="off"
                inputMode="url"
                aria-invalid={urlError ? true : undefined}
                aria-describedby={urlError ? 'server-url-error' : 'server-url-help'}
              />
            </Field>
            {urlError && (
              <p id="server-url-error" className="-mt-2 text-xs text-danger">
                {urlError}
              </p>
            )}
            <p id="server-url-help" className="-mt-2 text-xs text-faint">
              Use <code className="font-mono">/api</code> in dev (proxied to localhost:6790), or the
              server origin in production.
            </p>
            <Field
              label="Bearer token (optional)"
              hint="Kept in memory only — re-enter after reload. Never bake secrets into VITE_* variables."
              htmlFor="bearer-token"
            >
              <div className="relative">
                <Input
                  id="bearer-token"
                  name="bearer-token"
                  type={showToken ? 'text' : 'password'}
                  value={tok}
                  onChange={(e) => {
                    invalidateTest();
                    clearSaveNotice();
                    setTok(e.target.value);
                  }}
                  placeholder="only if AUTH_TOKENS is set"
                  className="pr-10"
                  autoComplete="off"
                  spellCheck={false}
                />
                <IconButton
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  className="absolute right-0.5 top-1/2 -translate-y-1/2"
                  onClick={() => setShowToken((v) => !v)}
                >
                  <IconEye className="size-4" />
                </IconButton>
              </div>
            </Field>
            <Field
              label="Agent token (optional)"
              hint="Only if the control agent runs with AGENT_TOKEN. Kept in memory; re-enter after reload."
              htmlFor="agent-token"
            >
              <div className="relative">
                <Input
                  id="agent-token"
                  name="agent-token"
                  type={showAgentToken ? 'text' : 'password'}
                  value={agentTok}
                  onChange={(e) => {
                    invalidateTest();
                    clearSaveNotice();
                    setAgentTok(e.target.value);
                  }}
                  placeholder="only if AGENT_TOKEN is set"
                  className="pr-10"
                  autoComplete="off"
                  spellCheck={false}
                />
                <IconButton
                  aria-label={showAgentToken ? 'Hide agent token' : 'Show agent token'}
                  className="absolute right-0.5 top-1/2 -translate-y-1/2"
                  onClick={() => setShowAgentToken((v) => !v)}
                >
                  <IconEye className="size-4" />
                </IconButton>
              </div>
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="accent" onClick={save}>
                Save
              </Button>
              <Button onClick={test}>{testing ? 'Restart test' : 'Test connection'}</Button>
              {saveNotice && (
                <span
                  role="status"
                  className={saveNotice.persisted ? 'text-sm text-success' : 'text-sm text-warning'}
                >
                  {saveNotice.message}
                </span>
              )}
              {result && (
                <span
                  role="status"
                  className={result.ok ? 'text-sm text-success' : 'text-sm text-danger'}
                >
                  {result.msg}
                </span>
              )}
            </div>
            <p className="-mt-1 text-xs text-faint">
              Test checks the values above as typed. Saving repoints every page at the new server
              immediately.
            </p>
          </div>
        </Card>

        <AppearanceCard />
      </div>
    </div>
  );
}
