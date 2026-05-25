# lilgeckos.com blog

Static [Astro](https://astro.build) site, published to GitHub Pages via
`.github/workflows/deploy-pages.yml`. Lives in this `site/` subdirectory so it
coexists with the broadcast hub (which lives in the repo root `src/`).

## Local dev

```bash
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # outputs to site/dist/
```

## Writing posts

Posts are markdown files in `site/src/content/blog/`. Frontmatter:

```markdown
---
title: My post title
description: Optional one-liner for SEO.
pubDate: 2026-05-25
draft: false        # optional; true hides it from the build
---

Body in markdown.
```

The file name becomes the URL slug (`my-post.md` → `/blog/my-post`).

## Deploy

Pushing to `main` with changes under `site/**` triggers the Actions workflow,
which builds and deploys to GitHub Pages. Can also be run manually from the
Actions tab (`workflow_dispatch`).

## Custom domain (later)

When DNS for `lilgeckos.com` is ready:

1. In `astro.config.mjs`, set `site: 'https://lilgeckos.com'` and remove `base`.
2. Add `site/public/CNAME` containing one line: `lilgeckos.com`.
3. Point DNS at GitHub Pages and set the custom domain in repo settings.

## Publishing from the hub

The broadcast hub can publish a post here by writing a markdown file into
`site/src/content/blog/` and committing it — the push triggers the deploy. A
`blog` adapter would: render frontmatter + body to a `.md` file, drop any
images into `site/public/`, then commit & push (via git or the GitHub API).
No CMS or database needed — the repo *is* the content store.
