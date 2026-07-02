import { transformerTwoslash } from '@shikijs/vitepress-twoslash';
import llmstxt from 'vitepress-plugin-llms';
import { withMermaid } from 'vitepress-plugin-mermaid';

// Served at the repo root in dev/preview, and under the Pages sub-path in CI
// (pages.yml sets DOCS_BASE=/bunqueue-dashboard/docs/). Must have a trailing slash.
const base = process.env.DOCS_BASE || '/';

// Canonical production origin for SEO (sitemap, canonical links, og:url). The
// docs deploy at this URL on GitHub Pages regardless of the local dev base.
const SITE = 'https://egeominotti.github.io/bunqueue-dashboard/docs';

// withMermaid() wraps defineConfig and registers the Mermaid render component, so
// ```mermaid fenced blocks in any page become diagrams (used in architecture.md).
export default withMermaid({
  base,
  lang: 'en-US',
  title: 'bunqueue dashboard',
  description:
    'How the bunqueue dashboard works: an illustrated, user-first guide to every page, plus deployment (Docker, Kubernetes, PM2), the architecture, and the HTTP API it drives.',
  cleanUrls: true,
  lastUpdated: true,
  // The reference docs mention source paths and a few planned pages that don't
  // exist yet; don't fail the build on those. README.md is the GitHub-facing
  // index, index.md is the site home, so keep README out of the built site.
  ignoreDeadLinks: true,
  srcExclude: ['README.md'],

  // Generates sitemap.xml for search engines.
  sitemap: { hostname: `${SITE}/` },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#ec4899' }],
    ['meta', { name: 'author', content: 'Egeo Minotti' }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'bunqueue, dashboard, queue, jobs, dead-letter queue, cron, webhooks, workers, react, vite, bun',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'bunqueue dashboard docs' }],
    ['meta', { property: 'og:image', content: `${SITE}/og.png` }],
    ['meta', { property: 'og:image:width', content: '1600' }],
    ['meta', { property: 'og:image:height', content: '1000' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE}/og.png` }],
  ],

  // Per-page SEO: a canonical link, a page-specific og:url/og:title, and a real
  // per-page description (from frontmatter, falling back to the site default).
  transformPageData(pageData) {
    const clean = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '');
    const canonical = `${SITE}/${clean}`.replace(/\/$/, clean === '' ? '/' : '');
    const title = pageData.frontmatter.title || pageData.title || 'bunqueue dashboard';
    const description =
      pageData.frontmatter.description ||
      pageData.description ||
      'An illustrated, user-first guide to the bunqueue dashboard.';
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:url', content: canonical }],
      ['meta', { property: 'og:title', content: `${title} · bunqueue dashboard docs` }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { name: 'description', content: description }],
      ['meta', { name: 'twitter:title', content: `${title} · bunqueue dashboard docs` }],
      ['meta', { name: 'twitter:description', content: description }]
    );
  },

  markdown: {
    // Shiki Twoslash: ```ts twoslash blocks get real type-checking + hover types.
    codeTransformers: [transformerTwoslash()],
    languages: ['ts', 'js', 'bash', 'json', 'jsonc', 'html', 'css', 'yaml', 'docker'],
  },

  vite: {
    plugins: [
      // Emits /llms.txt and /llms-full.txt so LLMs (Claude et al.) can consume the
      // docs. title/description/details give a model an accurate mental model up
      // front, before the per-page link index.
      llmstxt({
        title: 'bunqueue dashboard',
        description:
          'A web dashboard that fully drives a bunqueue server over its public HTTP API (:6790) plus a small local control agent that manages the server process. Built with React 19, React Router 7, Zustand 5, Vite and Bun.',
        details: [
          '## Mental model',
          '',
          "It **reads** from a bunqueue server by polling the HTTP API (`usePolledData`, interval from the connection store) and subscribing to a Server-Sent-Events stream (`useActivityStream`) for live job activity. It **writes** through the same API (pause, add job, retry, rate-limit, and so on), with every job action gated by the job's real current state via `src/lib/jobActions.ts::actionGates` so the UI never offers an action the server would reject.",
          '',
          'The one thing HTTP cannot do, manage the server **process**, is delegated to a small local **control agent** (`agent/`): loopback-bound (127.0.0.1), CORS-locked to an allowlist, with an optional `AGENT_TOKEN` bearer gate, exposing `/control/*` to start, stop and restart bunqueue, plus a read-only SQLite inspector over `/db/*`.',
          '',
          '## Two API clients, by design',
          '',
          '- `src/lib/api.ts`, the original client, used only by the first-generation **classic** pages (reachable at `*-classic` routes).',
          '- `src/lib/bq.ts`, the complete, shape-verified, strict-error-checked client behind every **Pro** control page (`src/pages/control/*`), which own the sidebar. New work uses `bq`. Its `call()` also throws on HTTP-200-with-`{ok:false}` (except `health()`).',
          '',
          '## Verified API-shape gotchas',
          '',
          '- `GET /webhooks`, `/workers`, `/storage`, `/ping` wrap the payload in `{ ok, data: {...} }`; `/queues/:q/dlq`, `/dlq/stats`, `/crons`, `/queues/:q/counts` are flat.',
          '- DLQ entries are nested `{ job, enteredAt, reason, error, attempts[] }`, with no top-level `id`/`name`.',
          '- Jobs have no `name` field and no embedded `result` (fetch via `GET /jobs/:id/result`); they use `startedAt`/`completedAt` (not `processedOn`/`finishedOn`).',
          '',
          'For the full per-section walkthrough see the User guide pages; for endpoint shapes see API mapping; for honest current limits see Known issues.',
        ].join('\n'),
      }),
    ],
  },

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'User guide', link: '/user-guide' },
      { text: 'Deploy', link: '/deploy/' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'API', link: '/api-mapping' },
      { text: 'llms.txt', link: `${base}llms.txt`, target: '_blank' },
    ],

    // Mirrors the dashboard's own sidebar groups (Home, Queues, Monitoring,
    // Control, Management) so each dashboard section has its own detailed page.
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'User guide (index)', link: '/user-guide' },
          { text: 'Development', link: '/development' },
        ],
      },
      {
        text: 'Deploy',
        items: [
          { text: 'Overview', link: '/deploy/' },
          { text: 'Docker', link: '/deploy/docker' },
          { text: 'Kubernetes', link: '/deploy/kubernetes' },
          { text: 'PM2', link: '/deploy/pm2' },
          { text: 'Hosting platforms', link: '/deploy/platforms' },
        ],
      },
      {
        text: 'Guide · Home',
        items: [{ text: 'Overview', link: '/guide/overview' }],
      },
      {
        text: 'Guide · Queues',
        items: [
          { text: 'Queues', link: '/guide/queues' },
          { text: 'Jobs Explorer', link: '/guide/jobs' },
          { text: 'Dead Letter Queue', link: '/guide/dlq' },
          { text: 'Cron Jobs', link: '/guide/cron' },
        ],
      },
      {
        text: 'Guide · Monitoring',
        items: [
          { text: 'Metrics', link: '/guide/metrics' },
          { text: 'Workers', link: '/guide/workers' },
          { text: 'Logs', link: '/guide/logs' },
        ],
      },
      {
        text: 'Guide · Control',
        items: [
          { text: 'Server Control', link: '/guide/server' },
          { text: 'Add Job', link: '/guide/add-job' },
          { text: 'Job Inspector', link: '/guide/job-inspector' },
          { text: 'Queue Control', link: '/guide/queue-control' },
          { text: 'DLQ Control', link: '/guide/dlq-control' },
          { text: 'Webhooks', link: '/guide/webhooks' },
          { text: 'Diagnostics', link: '/guide/diagnostics' },
          { text: 'Benchmark', link: '/guide/benchmark' },
        ],
      },
      {
        text: 'Guide · Management',
        items: [
          { text: 'Database', link: '/guide/database' },
          { text: 'Usage', link: '/guide/usage' },
          { text: 'S3 Backup', link: '/guide/s3' },
          { text: 'Settings', link: '/guide/settings' },
        ],
      },
      {
        text: 'Guide · Appendix',
        collapsed: true,
        items: [{ text: 'Classic pages', link: '/guide/classic' }],
      },
      {
        text: 'Architecture & internals',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Pages & routes', link: '/pages' },
          { text: 'Components & stores', link: '/components' },
          { text: 'Control agent', link: '/agent' },
          { text: 'API mapping', link: '/api-mapping' },
        ],
      },
      {
        text: 'Project',
        items: [{ text: 'Known issues', link: '/known-issues' }],
      },
    ],

    outline: { level: [2, 3], label: 'On this page' },

    search: {
      provider: 'local',
      options: { detailedView: true },
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/egeominotti/bunqueue-dashboard' },
    ],

    editLink: {
      pattern: 'https://github.com/egeominotti/bunqueue-dashboard/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Drives a bunqueue server over its public HTTP API plus a local control agent.',
      copyright: 'MIT · bunqueue dashboard',
    },
  },
});
