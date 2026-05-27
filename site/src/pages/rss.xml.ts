import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { excerpt } from '../lib/posts';
import { STRINGS } from '../lib/i18n';

export async function GET(context: APIContext) {
  const posts = (await getCollection('blog', ({ data }) => !data.draft && data.lang === 'en')).sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  );
  return rss({
    title: 'lilgeckos.com',
    description: STRINGS.en.homeLede!,
    site: context.site ?? 'https://lilgeckos.com',
    items: posts.map((p) => ({
      title: p.data.title,
      pubDate: p.data.pubDate,
      description: p.data.description ?? excerpt(p.body),
      link: `/blog/${p.data.translationKey}/`,
    })),
    customData: `<language>en</language>`,
  });
}
