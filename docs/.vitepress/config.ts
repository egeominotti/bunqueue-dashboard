import { transformerTwoslash } from '@shikijs/vitepress-twoslash';
import llmstxt from 'vitepress-plugin-llms';
import { withMermaid } from 'vitepress-plugin-mermaid';

// Served at the repo root in dev/preview, and under the Pages sub-path in CI
// (pages.yml sets DOCS_BASE=/bunqueue-dashboard/docs/). Must have a trailing slash.
const base = process.env.DOCS_BASE || '/';

// withMermaid() wraps defineConfig and registers the Mermaid render component, so
// ```mermaid fenced blocks in any page become diagrams (used in architecture.md).
export default withMermaid({
  base,
  lang: 'en-US',
  title: 'bunqueue dashboard',
  description:
    'How the bunqueue dashboard works — an illustrated guide to every page, the architecture, the control agent, and the HTTP API it drives.',
  cleanUrls: true,
  lastUpdated: true,
  // The reference docs mention source paths and a few planned pages that don't
  // exist yet; don't fail the build on those. README.md is the GitHub-facing
  // index — index.md is the site home, so keep README out of the built site.
  ignoreDeadLinks: true,
  srcExclude: ['README.md'],

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#ec4899' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'bunqueue dashboard — docs' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Illustrated guide to every page of the bunqueue dashboard.',
      },
    ],
  ],

  markdown: {
    // Shiki Twoslash: ```ts twoslash blocks get real type-checking + hover types.
    codeTransformers: [transformerTwoslash()],
    // Twoslash emits raw HTML for the hover popovers.
    languages: ['ts', 'js', 'bash', 'json', 'jsonc', 'html', 'css'],
  },

  vite: {
    plugins: [
      // Emits /llms.txt and /llms-full.txt so LLMs (Claude et al.) can consume the docs.
      llmstxt({
        description:
          'Web dashboard that fully drives a bunqueue server: queues, jobs, DLQ, cron, webhooks, workers, live activity, and the server process lifecycle.',
      }),
    ],
  },

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'User guide', link: '/user-guide' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'API', link: '/api-mapping' },
      { text: 'Known issues', link: '/known-issues' },
      // Base is NOT auto-applied to external-style links (target:_blank + .txt),
      // so prefix it explicitly or this 404s under the Pages sub-path.
      { text: 'llms.txt', link: `${base}llms.txt`, target: '_blank' },
    ],

    // Mirrors the dashboard's own sidebar groups (Home · Queues · Monitoring ·
    // Control · Management) so each dashboard section has its own detailed page.
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'User guide (index)', link: '/user-guide' },
          { text: 'Development', link: '/development' },
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
        collapsed: false,
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
      options: {
        detailedView: true,
      },
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/egeominotti/bunqueue-dashboard' },
    ],

    editLink: {
      pattern:
        'https://github.com/egeominotti/bunqueue-dashboard/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Drives a bunqueue server over its public HTTP API + a local control agent.',
      copyright: 'MIT · bunqueue dashboard',
    },
  },
});
