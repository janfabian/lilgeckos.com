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
