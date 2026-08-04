import type { HeadConfig, PageData } from 'vitepress';

// Canonical production origin for SEO (sitemap, canonical links, og:url).
export const SITE = 'https://egeominotti.github.io/bunqueue-dashboard/docs';
export const SITE_DESCRIPTION =
  'How the bunqueue dashboard works: an illustrated, user-first guide to every page, plus deployment (Docker, Kubernetes, PM2), the architecture, and the HTTP API it drives.';

export function siteHead(base: string): HeadConfig[] {
  return [
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
    [
      'meta',
      {
        name: 'robots',
        content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'bunqueue dashboard docs' }],
    ['meta', { property: 'og:locale', content: 'en_US' }],
    ['meta', { property: 'og:image', content: `${SITE}/og.png` }],
    ['meta', { property: 'og:image:type', content: 'image/png' }],
    ['meta', { property: 'og:image:width', content: '1600' }],
    ['meta', { property: 'og:image:height', content: '1000' }],
    [
      'meta',
      { property: 'og:image:alt', content: 'The bunqueue dashboard, a live queue control panel' },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE}/og.png` }],
    [
      'meta',
      { name: 'twitter:image:alt', content: 'The bunqueue dashboard, a live queue control panel' },
    ],
  ];
}

/** Add canonical metadata and a linked schema.org graph to each generated page. */
export function transformPageData(pageData: PageData): void {
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

  const isHome = clean === '';
  const person = { '@id': `${SITE}/#person` };
  const website = { '@id': `${SITE}/#website` };
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'WebSite',
      '@id': `${SITE}/#website`,
      url: `${SITE}/`,
      name: 'bunqueue dashboard docs',
      description:
        'How the bunqueue dashboard works: an illustrated, user-first guide to every page, plus deployment, the architecture, and the HTTP API it drives.',
      inLanguage: 'en-US',
      publisher: person,
    },
    {
      '@type': 'Person',
      '@id': `${SITE}/#person`,
      name: 'Egeo Minotti',
      url: 'https://github.com/egeominotti',
    },
    {
      '@type': 'WebPage',
      '@id': `${canonical}#webpage`,
      url: canonical,
      name: `${title} · bunqueue dashboard docs`,
      description,
      isPartOf: website,
      inLanguage: 'en-US',
      primaryImageOfPage: `${SITE}/og.png`,
      ...(isHome ? {} : { breadcrumb: { '@id': `${canonical}#breadcrumb` } }),
    },
  ];
  if (isHome) {
    graph.push({
      '@type': 'SoftwareApplication',
      '@id': `${SITE}/#software`,
      name: 'bunqueue dashboard',
      description,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web, Docker, Linux, macOS, Windows',
      url: 'https://egeominotti.github.io/bunqueue-dashboard/',
      image: `${SITE}/og.png`,
      author: person,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
    });
  } else {
    graph.push(
      {
        '@type': 'TechArticle',
        headline: title,
        description,
        url: canonical,
        inLanguage: 'en-US',
        image: `${SITE}/og.png`,
        author: person,
        publisher: person,
        isPartOf: website,
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: title, item: canonical },
        ],
      }
    );
  }
  pageData.frontmatter.head.push([
    'script',
    { type: 'application/ld+json' },
    JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }),
  ]);
}
