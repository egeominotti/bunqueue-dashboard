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
