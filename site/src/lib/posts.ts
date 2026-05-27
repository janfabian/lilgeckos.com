export interface PostMedia {
  kind: 'image' | 'video';
  url: string;
  alt: string;
}

/**
 * Pull the first media reference out of a post's raw markdown body — an
 * `![alt](url)` image or a `<video src="url">` tag — whichever appears first.
 * Used to show a thumbnail in list views. Returns null for text-only posts.
 */
export function firstMedia(body: string | undefined): PostMedia | null {
  const src = body ?? '';
  const imgMatch = src.match(/!\[([^\]]*)\]\(([^)\s]+)\)/);
  const vidMatch = src.match(/<video[^>]*\ssrc="([^"]+)"/i);
  const imgIdx = imgMatch ? src.indexOf(imgMatch[0]) : -1;
  const vidIdx = vidMatch ? src.indexOf(vidMatch[0]) : -1;

  if (imgIdx === -1 && vidIdx === -1) return null;
  const imageFirst = imgIdx !== -1 && (vidIdx === -1 || imgIdx < vidIdx);
  return imageFirst
    ? { kind: 'image', url: imgMatch![2]!, alt: imgMatch![1] ?? '' }
    : { kind: 'video', url: vidMatch![1]!, alt: '' };
}

/** First image URL in the body (for og:image). Skips videos. Null if none. */
export function firstImage(body: string | undefined): string | null {
  const m = (body ?? '').match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  return m ? m[1]! : null;
}

/**
 * A plain-text excerpt for meta/OG descriptions: strips media embeds, HTML
 * tags, link syntax and markdown punctuation, then clamps to ~`max` chars on a
 * word boundary. Used when a post has no explicit `description`.
 */
export function excerpt(body: string | undefined, max = 155): string {
  let s = body ?? '';
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // images
  s = s.replace(/<[^>]+>/g, ' '); // html (e.g. <video>)
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links -> text
  s = s.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' '); // drop #hashtag tokens
  s = s.replace(/[#>*_`~]+/g, ' '); // md punctuation
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, '').trim() + '…';
}
