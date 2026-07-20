#!/usr/bin/env bun
/**
 * Build the VitePress site with Node's web-storage backing file configured.
 * VitePress/Mermaid touches the Node 22 localStorage global during its build;
 * without a file Node emits an ExperimentalWarning even though the build is
 * healthy. A disposable file keeps the build output clean and deterministic.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const storageFile = join(tmpdir(), `bunqueue-vitepress-localstorage-${process.pid}.json`);
const nodeOptions = [process.env.NODE_OPTIONS, `--localstorage-file=${storageFile}`]
  .filter(Boolean)
  .join(' ');

try {
  const proc = Bun.spawn(['vitepress', 'build', 'docs'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
} finally {
  rmSync(storageFile, { force: true });
}
