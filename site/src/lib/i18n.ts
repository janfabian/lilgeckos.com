export type Lang = 'en' | 'cs';

export const LANGS: Lang[] = ['en', 'cs'];

/** UI strings per language. */
export const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    journalNav: 'journal',
    journalTitle: 'Journal',
    latest: 'Latest',
    allPosts: '← All posts',
    share: 'Share',
    copyLink: 'Copy link',
    copied: 'Copied',
    newer: '← newer',
    older: 'older →',
    emptyNewer: '— latest —',
    emptyOlder: '— first post —',
    noPosts: 'No posts yet.',
    homeTitle: 'Little geckos, big internet.',
    homeLede:
      'A running journal of life with leopard geckos — new arrivals, sheds, feeding notes, and the occasional very important water break.',
  },
  cs: {
    journalNav: 'deník',
    journalTitle: 'Deník',
    latest: 'Nejnovější',
    allPosts: '← Všechny příspěvky',
    share: 'Sdílet',
    copyLink: 'Kopírovat odkaz',
    copied: 'Zkopírováno',
    newer: '← novější',
    older: 'starší →',
    emptyNewer: '— nejnovější —',
    emptyOlder: '— první příspěvek —',
    noPosts: 'Zatím žádné příspěvky.',
    homeTitle: 'Malí gekoni, velký internet.',
    homeLede:
      'Průběžný deník života s leopardími gekony — nové přírůstky, svlékání, poznámky ke krmení a občas velmi důležitá pauza na vodu.',
  },
};

/** "N posts" with light Czech pluralization. */
export function postCount(n: number, lang: Lang): string {
  if (lang === 'cs') {
    if (n === 1) return '1 příspěvek';
    if (n >= 2 && n <= 4) return `${n} příspěvky`;
    return `${n} příspěvků`;
  }
  return `${n} ${n === 1 ? 'post' : 'posts'}`;
}

/** URL prefix for a language ('' for the default en, '/cs' for Czech). */
export function langPrefix(lang: Lang): string {
  return lang === 'cs' ? '/cs' : '';
}

/**
 * Build a localized path. `path` is the canonical (en-relative) path like
 * '/', '/blog', '/blog/<key>'. Returns it prefixed for the given language.
 */
export function localized(lang: Lang, path: string): string {
  const p = langPrefix(lang);
  if (path === '/') return p === '' ? '/' : `${p}/`;
  return `${p}${path}`;
}

export function otherLang(lang: Lang): Lang {
  return lang === 'cs' ? 'en' : 'cs';
}
