let runtime: Promise<typeof import('mermaid')['default']> | undefined;

/** Import only in the browser: Mermaid's DOM dependencies must never run during SSR. */
export function loadMermaid() {
  return runtime ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
    return mermaid;
  });
}
