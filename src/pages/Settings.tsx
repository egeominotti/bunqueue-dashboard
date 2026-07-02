import { useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { IconEye } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { api } from '@/lib/api';

const REFRESH_OPTIONS = [
  ['1000', '1 second'],
  ['2000', '2 seconds'],
  ['3000', '3 seconds'],
  ['5000', '5 seconds'],
  ['10000', '10 seconds'],
] as const;

/** A base URL is either a relative path (dev proxy) or an absolute http(s) origin. */
function isValidBaseUrl(v: string): boolean {
  if (v.startsWith('/')) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function Settings() {
  const { baseUrl, token, refreshMs, setBaseUrl, setToken, setRefreshMs } = useConnectionStore();
  const { theme, setTheme } = useThemeStore();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // Buffer the connection fields locally: committing to the store on every
  // keystroke would retarget all polling at a half-typed URL.
  const [url, setUrl] = useState(baseUrl);
  const [tok, setTok] = useState(token);
  const [showToken, setShowToken] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = () => {
    const trimmed = url.trim();
    if (!isValidBaseUrl(trimmed)) {
      setUrlError("Must be an http(s) URL or a path starting with '/'.");
      return;
    }
    setUrlError(null);
    setBaseUrl(trimmed);
    setToken(tok);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    const t0 = performance.now();
    try {
      const health = (await api.health()) as { ok?: boolean; version?: string };
      const ms = Math.round(performance.now() - t0);
      setResult({
        ok: health.ok !== false,
        msg: `Connected in ${ms}ms${health.version ? ` · bunqueue v${health.version}` : ''}`,
      });
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <PageHeader title="Settings" description="Connection and appearance." />

      <div className="grid max-w-2xl grid-cols-1 gap-6">
        <Card>
          <CardHeader title="Connection" />
          <div className="flex flex-col gap-4">
            <Field label="Server URL">
              <Input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError(null);
                }}
                placeholder="/api or https://queue.example.com"
              />
            </Field>
            {urlError && <p className="-mt-2 text-xs text-danger">{urlError}</p>}
            <p className="-mt-2 text-xs text-faint">
              Use <code className="font-mono">/api</code> in dev (proxied to localhost:6790), or the
              server origin in production.
            </p>
            <Field
              label="Bearer token (optional)"
              hint="Kept in memory only — re-enter after reload, or set VITE_BUNQUEUE_TOKEN."
            >
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  value={tok}
                  onChange={(e) => setTok(e.target.value)}
                  placeholder="only if AUTH_TOKENS is set"
                  className="pr-10"
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
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="accent" onClick={save}>
                Save
              </Button>
              <Button onClick={test} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
              {saved && <span className="text-sm text-success">Saved ✓</span>}
              {result && (
                <span className={result.ok ? 'text-sm text-success' : 'text-sm text-danger'}>
                  {result.msg}
                </span>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Appearance & refresh" />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Theme">
              <Select value={theme} onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </Select>
            </Field>
            <Field label="Refresh interval">
              <Select
                value={String(refreshMs)}
                onChange={(e) => setRefreshMs(Number(e.target.value))}
              >
                {REFRESH_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      </div>
    </div>
  );
}
