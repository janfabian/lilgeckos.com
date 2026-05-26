import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Blog posts live as markdown in src/content/blog/.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    draft: z.boolean().default(false),
    // i18n: language of this file, and the shared key linking its translations.
    lang: z.enum(['en', 'cs']).default('en'),
    // translationKey ties the en + cs versions of one post together (the canonical slug).
    translationKey: z.string(),
  }),
});

export const collections = { blog };
