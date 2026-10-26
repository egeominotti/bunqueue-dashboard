import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';

// Resolve the parser through its actual documentation-plugin consumer, including overrides.
const require = createRequire(import.meta.resolve('vitepress-plugin-llms'));
const matter = require('@11ty/gray-matter') as (source: string) => { data: unknown };

test('documentation frontmatter rejects executable YAML tags', () => {
  expect(() =>
    matter('---\ncallback: !!js/function function () { return 42; }\n---\ncontent')
  ).toThrow(/unknown tag/);
});
