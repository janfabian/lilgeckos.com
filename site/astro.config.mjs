// @ts-check
import { defineConfig } from 'astro/config';

// Deployment target.
//
// RIGHT NOW: project pages, served at https://janfabian.github.io/lilgeckos.com/
//   -> site = the github.io origin, base = the repo name.
//
// LATER, once the lilgeckos.com custom domain + DNS are set up:
//   -> change to:  site: 'https://lilgeckos.com', base: '/'
//      (or just delete the `base` line — root is the default), and add a
//      site/public/CNAME file containing the single line: lilgeckos.com
export default defineConfig({
  site: 'https://janfabian.github.io',
  base: '/lilgeckos.com',
});
