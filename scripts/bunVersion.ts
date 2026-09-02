export const REQUIRED_BUN_VERSION = '1.4.0';

export function assertRequiredBunVersion(version = Bun.version): void {
  if (version !== REQUIRED_BUN_VERSION) {
    throw new Error(
      `bunqueue-dashboard requires Bun ${REQUIRED_BUN_VERSION}; received ${version}. ` +
        'Install the version pinned in .bun-version.'
    );
  }
}
