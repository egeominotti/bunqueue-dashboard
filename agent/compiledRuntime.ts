/** Bun uses a POSIX virtual root and a drive-qualified Windows virtual root. */
function compiledRoot(moduleUrl: string): URL | null {
  const url = new URL(moduleUrl);
  if (url.protocol !== 'file:') return null;
  for (const marker of ['/$bunfs/root/', '/~BUN/root/']) {
    const index = url.pathname.indexOf(marker);
    if (index !== -1) {
      url.pathname = url.pathname.slice(0, index + marker.length);
      url.search = '';
      url.hash = '';
      return url;
    }
  }
  return null;
}

export function isCompiledModule(moduleUrl: string): boolean {
  return compiledRoot(moduleUrl) !== null;
}

export function compiledWorkerUrl(moduleUrl: string, path: string): string | null {
  const root = compiledRoot(moduleUrl);
  return root ? new URL(path, root).href : null;
}
