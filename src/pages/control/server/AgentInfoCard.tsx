import { Card } from '@/components/ui/Card';

function Code({ children }: { children: string }) {
  return <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg">{children}</code>;
}

/**
 * Collapsible explainer for the Server page: what the control agent is, how the
 * bunqueue process is launched, which env it injects, the security model, and
 * when config changes take effect.
 */
export function AgentInfoCard({ agentBase }: { agentBase: string }) {
  return (
    <Card>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
          <span className="text-base font-semibold text-fg">How server control works</span>
          <span className="text-xs text-muted transition-transform group-open:rotate-90">▶</span>
        </summary>

        <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted">
          <p>
            A browser can't start or stop an OS process, so the dashboard talks to a small local{' '}
            <span className="font-medium text-fg">control agent</span> (<Code>{agentBase}</Code>)
            that supervises the bunqueue server process — start, stop and restart — and streams its
            logs back here.
          </p>

          <div>
            <div className="mb-1 font-medium text-fg">Launch &amp; environment</div>
            <p>
              The agent runs your <span className="text-fg">Command</span> and injects{' '}
              <Code>HTTP_PORT</Code>, <Code>TCP_PORT</Code> and <Code>BUNQUEUE_DATA_PATH</Code> —
              plus any <span className="text-fg">Environment variables</span> you add — into its
              environment. The default <Code>bunx bunqueue@2.8.57 start</Code> resolves the verified
              release; pointing the command at a local entry (e.g.{' '}
              <Code>bun run /path/to/bunqueue/src/main.ts</Code>) works without one.
            </p>
          </div>

          <div>
            <div className="mb-1 font-medium text-fg">When changes apply</div>
            <p>
              Config is editable any time, but <span className="text-fg">Command</span>, ports and
              data path only take effect on the <span className="text-fg">next start/restart</span>{' '}
              — the running process keeps the config it launched with until then.
            </p>
          </div>

          <div>
            <div className="mb-1 font-medium text-fg">Data path</div>
            <p>
              Relative paths resolve against the <span className="text-fg">agent's</span> working
              directory. SQLite creates the database <span className="text-fg">file</span> but not
              its parent <span className="text-fg">folder</span> — if start fails with{' '}
              <Code>SQLITE_CANTOPEN</Code>, create the directory first or use a path whose folder
              already exists.
            </p>
          </div>

          <div>
            <div className="mb-1 font-medium text-fg">Security</div>
            <p>
              The direct agent listener binds <Code>127.0.0.1</Code>, locks CORS to an allowlist
              (never <Code>*</Code>), and rejects a disallowed <Code>Origin</Code> or{' '}
              <Code>Host</Code> with <Code>403</Code>. The all-in-one server's <Code>/agent</Code>{' '}
              bridge treats LAN and reverse-proxy access as remote: <Code>AGENT_TOKEN</Code> is then
              mandatory for status, logs, database reads and changes alike. Without it, the bridge
              stays disabled.
            </p>
            <p>
              If you started the agent with <Code>AGENT_TOKEN</Code>, enter that token under{' '}
              <span className="text-fg">Settings → Agent token</span> (or when the lock screen
              prompts). It stays in memory for this browser session; never bake it into a public{' '}
              <Code>VITE_*</Code> value.
            </p>
          </div>
        </div>
      </details>
    </Card>
  );
}
