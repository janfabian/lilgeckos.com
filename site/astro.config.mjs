// @ts-check
import { defineConfig } from 'astro/config';

// Deployment target: custom apex domain lilgeckos.com (Cloudflare DNS →
// GitHub Pages). Served at the root, so no `base`. The CNAME file lives at
// site/public/CNAME so the build emits it at the site root for GitHub Pages.
export default defineConfig({
  site: 'https://lilgeckos.com',
  // English is the default (served at /…); Czech lives under /cs/….
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'cs'],
    routing: { prefixDefaultLocale: false },
  },
});
