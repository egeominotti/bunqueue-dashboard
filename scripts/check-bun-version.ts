import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertRequiredBunVersion, REQUIRED_BUN_VERSION } from './bunVersion';

const root = resolve(import.meta.dir, '..');
const expectedEngine = '1.4.4';
const workflows = ['ci.yml', 'ci-gate.yml', 'docker.yml', 'lighthouse.yml', 'pages.yml', 'release.yml', 'validation.yml', 'resilience.yml'];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), 'utf8');
}

async function main(): Promise<void> {
  assertRequiredBunVersion();
  assert((await text('.bun-version')).trim() === REQUIRED_BUN_VERSION, '.bun-version drifted');

  const pkg = JSON.parse(await text('package.json')) as {
    packageManager?: string;
    engines?: { bun?: string };
    devDependencies?: Record<string, string>;
  };
  assert(pkg.packageManager === `bun@${REQUIRED_BUN_VERSION}`, 'packageManager must pin Bun 1.4.4');
  assert(pkg.engines?.bun === expectedEngine, 'engines.bun must pin Bun 1.4.4');
  assert(pkg.devDependencies?.['bun-types'] === '1.4.4', 'bun-types must pin Bun 1.4.4');

  const dockerfile = await text('Dockerfile');
  assert(
    new RegExp(`^FROM (?:--platform=\\$BUILDPLATFORM )?oven/bun:${REQUIRED_BUN_VERSION.replaceAll('.', '\\.')}-alpine AS build$`, 'm').test(dockerfile),
    'Docker build stage must pin Bun 1.4.4'
  );

  for (const workflow of workflows) {
    const source = await text(`.github/workflows/${workflow}`);
    if (source.includes('oven-sh/setup-bun@')) {
      const setups = source.match(/oven-sh\/setup-bun@/g)?.length ?? 0;
      const pins = source.match(/bun-version-file: \.bun-version/g)?.length ?? 0;
      assert(pins === setups, `${workflow} must pin every Bun setup with .bun-version`);
    } else {
      // ci-gate.yml is itself checked here to delegate to validation.yml.
      const delegates = ['validation.yml', 'ci-gate.yml'].some((target) => source.includes(`uses: ./.github/workflows/${target}`));
      assert(delegates, `${workflow} must delegate to the pinned validation workflow`);
    }
    assert(!source.includes('BUN_VERSION:'), `${workflow} must not duplicate the Bun version`);
  }

  // Bun installs, builds and packs; the npm CLI only publishes that tarball,
  // because Bun's publisher has no OIDC trusted publishing or provenance.
  const release = await text('.github/workflows/release.yml');
  assert(!/NPM_TOKEN|NPM_CONFIG_TOKEN|NODE_AUTH_TOKEN/.test(release), 'npm publishing must use trusted publishing, not a token');
  assert(!/bun publish/.test(release), 'npm publishing must go through the trusted-publishing npm CLI step');
  assert(/bun pm pack --destination \/tmp\/npm-package/.test(release), 'the npm tarball must be packed with Bun');
  assert(/npm publish --ignore-scripts --access public --provenance /.test(release), 'npm publishing must attach provenance');

  console.log(`Bun ${REQUIRED_BUN_VERSION} is pinned across runtime, CI, Docker, types, and packing.`);
}

await main();
