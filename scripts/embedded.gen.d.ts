/**
 * Ambient declaration for the git-ignored, auto-generated `embedded.gen.ts`
 * (written by `scripts/gen-embed.ts`). It lets `scripts/serve.ts` typecheck
 * without the generated module — whose `with { type: 'file' }` asset imports
 * are Bun-runtime concerns, not something to typecheck. The real module maps
 * each embedded dist asset path to its on-disk location.
 */
export declare const ASSETS: Record<string, string>;
