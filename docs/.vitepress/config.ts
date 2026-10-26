import { defineConfig } from 'vitepress';
import { createLlmsPlugin } from './llms.ts';
import { SITE, SITE_DESCRIPTION, siteHead, transformPageData } from './seo.ts';
import { createThemeConfig } from './themeConfig.ts';

// Served at the repo root in dev/preview, and under the Pages sub-path in CI
// (pages.yml sets DOCS_BASE=/bunqueue-dashboard/docs/). Must have a trailing slash.
const base = process.env.DOCS_BASE || '/';

// The local renderer keeps Mermaid on its supported public API without plugin peer conflicts.
export default defineConfig({
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
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        if (tokens[index].info.trim() === 'mermaid') {
          return `<Mermaid encoded="${encodeURIComponent(tokens[index].content)}" />`;
        }
        return fence(tokens, index, options, env, self);
      };
    },
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
