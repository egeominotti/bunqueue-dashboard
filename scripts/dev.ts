#!/usr/bin/env bun
/**
 * One-command dev launcher.
 *
 * `bun start` boots the control agent and the Vite dev server together and
 * tears both down cleanly on Ctrl-C, so you don't need two terminals. The
 * bunqueue server itself is managed by the agent — start it from the
 * dashboard's Control ▸ Server page once everything is up.
 *
 *   agent      → http://127.0.0.1:6800   (process lifecycle)
 *   dashboard  → http://localhost:5273   (/api proxied to :6790)
 */
import type { Subprocess } from 'bun';

// Spawn the real processes directly — NOT through `bun run <script>`: that
// interposes a wrapper process which does not forward SIGTERM to its child,
// so shutdown() killed the wrappers and orphaned the actual vite/agent
// (leaving a stale dev server holding :5273 for the next `bun start`).
const services = [
  { name: 'agent', cmd: ['bun', 'agent/index.ts'] },
  { name: 'dashboard', cmd: ['node_modules/.bin/vite'] },
] as const;

// Must exceed the agent's own SIGTERM→SIGKILL escalation window (8s in
// agent/manager.ts): on Ctrl-C the agent first stops the bunqueue server it
// spawned, and force-killing the agent mid-stop would orphan that child.
// No cost in the normal case — the race resolves as soon as children exit.
const FORCE_KILL_AFTER_MS = 10_000;

let closing = false;
let exitCode = 0;
const children: Subprocess[] = [];

async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`\n▸ ${reason} — stopping bunqueue dashboard…`);

  // Ask every child to exit (SIGTERM), then wait for them to actually go.
  for (const child of children) child.kill();
  const allExited = Promise.all(children.map((c) => c.exited));
  const deadline = new Promise((resolve) => setTimeout(resolve, FORCE_KILL_AFTER_MS));
  await Promise.race([allExited, deadline]);

  // Escalate to SIGKILL for anything still alive so nothing is orphaned.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  // Surface a failed boot (e.g. port in use) instead of masking it as success.
  process.exit(exitCode);
}

for (const { name, cmd } of services) {
  children.push(
    Bun.spawn(cmd, {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: process.env,
      onExit(_child, code) {
        // If one service dies, bring the whole stack down with its exit code.
        if (!closing) {
          exitCode = code ?? 0;
          void shutdown(`${name} exited (code ${exitCode})`);
        }
      },
    })
  );
}

console.log('▸ bunqueue dashboard up — agent :6800 · dashboard :5273 (Ctrl-C to stop)');

process.on('SIGINT', () => void shutdown('interrupted'));
process.on('SIGTERM', () => void shutdown('terminated'));
