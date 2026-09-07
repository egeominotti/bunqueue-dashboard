import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertRequiredBunVersion, REQUIRED_BUN_VERSION } from './bunVersion';

const root = resolve(import.meta.dir, '..');
const expectedEngine = '1.4.2';
const workflows = ['ci.yml', 'docker.yml', 'lighthouse.yml', 'pages.yml', 'release.yml'];

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
  assert(pkg.packageManager === `bun@${REQUIRED_BUN_VERSION}`, 'packageManager must pin Bun 1.4.2');
  assert(pkg.engines?.bun === expectedEngine, 'engines.bun must pin Bun 1.4.2');
  assert(pkg.devDependencies?.['bun-types'] === '1.4.2', 'bun-types must pin Bun 1.4.2');

  const dockerfile = await text('Dockerfile');
  assert(
    dockerfile.includes(`FROM oven/bun:${REQUIRED_BUN_VERSION}-alpine AS build`),
    'Docker build stage must pin Bun 1.4.2'
  );

  for (const workflow of workflows) {
    const source = await text(`.github/workflows/${workflow}`);
    assert(source.includes('bun-version-file: .bun-version'), `${workflow} must use .bun-version`);
    assert(!source.includes('BUN_VERSION:'), `${workflow} must not duplicate the Bun version`);
  }

  const release = await text('.github/workflows/release.yml');
  assert(
    !/actions\/setup-node|(?:run:\s*|if\s+)npm (?:view|publish)/.test(release),
    'release publishing must run through Bun'
  );

  console.log(`Bun ${REQUIRED_BUN_VERSION} is pinned across runtime, CI, Docker, types, and publish.`);
}

await main();
