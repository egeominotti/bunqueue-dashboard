import { transformerTwoslash } from '@shikijs/vitepress-twoslash';
import { withMermaid } from 'vitepress-plugin-mermaid';
import { createLlmsPlugin } from './llms';
import { SITE, SITE_DESCRIPTION, siteHead, transformPageData } from './seo';
import { createThemeConfig } from './themeConfig';

// Served at the repo root in dev/preview, and under the Pages sub-path in CI
// (pages.yml sets DOCS_BASE=/bunqueue-dashboard/docs/). Must have a trailing slash.
const base = process.env.DOCS_BASE || '/';

// withMermaid() registers the render component used by ```mermaid fences.
export default withMermaid({
  base,
  lang: 'en-US',
  title: 'bunqueue dashboard',
  description: SITE_DESCRIPTION,
  cleanUrls: true,
  lastUpdated: true,
  // README.md is the GitHub-facing index; index.md is the site home.
  srcExclude: ['README.md'],
  sitemap: { hostname: `${SITE}/` },
  head: siteHead(base),
  transformPageData,
  markdown: {
    // Shiki Twoslash gives ```ts twoslash blocks real type-checking and hover types.
    codeTransformers: [transformerTwoslash()],
    languages: ['ts', 'js', 'bash', 'json', 'jsonc', 'html', 'css', 'yaml', 'docker'],
  },
  vite: {
    build: {
      // VitePress + Mermaid intentionally ship two lazy framework chunks below this ceiling.
      chunkSizeWarningLimit: 800,
    },
    plugins: [createLlmsPlugin()],
  },
  themeConfig: createThemeConfig(base),
});
