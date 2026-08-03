// Test preload: provide a localStorage shim so modules that import the zustand
// persist stores (e.g. connectionStore, pulled in by lib/sse and lib/api) load
// cleanly under `bun test`.
let storageUsable = false;
try {
  const probe = '__bq_test_storage_probe__';
  globalThis.localStorage.setItem(probe, '1');
  globalThis.localStorage.removeItem(probe);
  storageUsable = true;
} catch {
  // Bun may expose a localStorage object whose methods throw unless a backing
  // file was configured. `typeof localStorage` alone therefore is not enough.
}

if (!storageUsable) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
  });
}
