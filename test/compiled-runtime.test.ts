import { expect, test } from 'bun:test';
import { compiledWorkerUrl, isCompiledModule } from '../agent/compiledRuntime';

test('embedded workers resolve under the executable root on POSIX and Windows', () => {
  for (const root of ['file:///$bunfs/root/', 'file:///B:/~BUN/root/']) {
    const entry = `${root}scripts/serve.js`;
    expect(isCompiledModule(entry)).toBe(true);
    expect(compiledWorkerUrl(entry, 'agent/dbReadWorker.js')).toBe(`${root}agent/dbReadWorker.js`);
  }
  expect(isCompiledModule(import.meta.url)).toBe(false);
  expect(compiledWorkerUrl(import.meta.url, 'agent/dbReadWorker.js')).toBeNull();
  expect(isCompiledModule('https://example.test/$bunfs/root/serve.js')).toBe(false);
});

test('encoded virtual roots from native binaries resolve embedded workers', () => {
  for (const [entry, root] of [
    ['file:///B:/%7EBUN/root/bunqueue-dashboard-windows-x64.exe', 'file:///B:/~BUN/root/'],
    ['file:///B:/%7eBUN/root/scripts/serve.js?ignored=1#ignored', 'file:///B:/~BUN/root/'],
    ['file:///%24bunfs/root/scripts/serve.js', 'file:///$bunfs/root/'],
  ]) {
    expect(isCompiledModule(entry)).toBe(true);
    expect(compiledWorkerUrl(entry, 'agent/dbReadWorker.js')).toBe(`${root}agent/dbReadWorker.js`);
    expect(compiledWorkerUrl(entry, 'agent/backup/standaloneWorker.js')).toBe(
      `${root}agent/backup/standaloneWorker.js`
    );
  }
  expect(isCompiledModule('file:///B:/%invalid/root/serve.js')).toBe(false);
  expect(isCompiledModule('https://example.test/%7EBUN/root/serve.js')).toBe(false);
});
