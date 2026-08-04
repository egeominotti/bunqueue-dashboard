import type { DefaultTheme } from 'vitepress';

/** Navigation mirrors the dashboard groups so every control surface stays discoverable. */
export function createThemeConfig(base: string): DefaultTheme.Config {
  return {
    logo: '/logo.svg',
    nav: [
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'User guide', link: '/user-guide' },
      { text: 'Deploy', link: '/deploy/' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'API', link: '/api-mapping' },
      { text: 'llms.txt', link: `${base}llms.txt`, target: '_blank' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Quickstart', link: '/quickstart' },
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
          { text: 'Flows', link: '/guide/flows' },
          { text: 'Workflow Engine', link: '/guide/workflows' },
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
          { text: 'MCP Server', link: '/guide/mcp' },
          { text: 'Copilot', link: '/guide/copilot' },
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
    socialLinks: [{ icon: 'github', link: 'https://github.com/egeominotti/bunqueue-dashboard' }],
    editLink: {
      pattern: 'https://github.com/egeominotti/bunqueue-dashboard/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Drives a bunqueue server over its public HTTP API plus a local control agent.',
      copyright: 'MIT · bunqueue dashboard',
    },
  };
}
