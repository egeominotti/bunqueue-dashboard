import { useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { useThemeStore } from '@/components/dashboard/stores/themeStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { api } from '@/lib/api';

const REFRESH_OPTIONS = [
  ['1000', '1 second'],
  ['2000', '2 seconds'],
  ['3000', '3 seconds'],
  ['5000', '5 seconds'],
  ['10000', '10 seconds'],
] as const;

export function Settings() {
  const { baseUrl, token, refreshMs, setBaseUrl, setToken, setRefreshMs } = useConnectionStore();
  const { theme, setTheme } = useThemeStore();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

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
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="/api or https://queue.example.com"
              />
            </Field>
            <p className="-mt-2 text-xs text-faint">
              Use <code className="font-mono">/api</code> in dev (proxied to localhost:6790), or the
              server origin in production.
            </p>
            <Field label="Bearer token (optional)">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="only if AUTH_TOKENS is set"
              />
            </Field>
            <div className="flex items-center gap-3">
              <Button variant="accent" onClick={test} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
              {result && (
                <span className={result.ok ? 'text-sm text-emerald-400' : 'text-sm text-red-400'}>
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
