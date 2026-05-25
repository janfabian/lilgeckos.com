// @ts-check
import { defineConfig } from 'astro/config';

// Deployment target: custom apex domain lilgeckos.com (Cloudflare DNS →
// GitHub Pages). Served at the root, so no `base`. The CNAME file lives at
// site/public/CNAME so the build emits it at the site root for GitHub Pages.
export default defineConfig({
  site: 'https://lilgeckos.com',
});
