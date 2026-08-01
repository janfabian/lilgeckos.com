// Per-platform metric fetchers for `bun run stats`. Each takes the platform's
// credentials + a list of post ids and returns a Map<postId, PostMetrics>.
//
// Design: BEST-EFFORT. Analytics endpoints (esp. FB/IG insights) are version- and
// account-dependent, so a fetcher returns whatever it can and leaves the rest
// undefined. A whole-platform failure returns an empty map + is surfaced by the
// caller, never throws through to the report.
import { OAuth2Client } from "google-auth-library";
import { youtube as ytClient } from "@googleapis/youtube";
import { TwitterApi } from "twitter-api-v2";
import type {
  YouTubeCredentials,
  TwitterCredentials,
  FacebookCredentials,
  InstagramCredentials,
} from "../config/env.js";

export interface PostMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  /** retweets / shares */
  shares?: number;
}

export type MetricsByPostId = Map<string, PostMetrics>;

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// --- YouTube: videos.list statistics (viewCount/likeCount/commentCount) ---
export async function fetchYouTube(
  creds: YouTubeCredentials,
  ids: string[],
): Promise<MetricsByPostId> {
  const out: MetricsByPostId = new Map();
  if (ids.length === 0) return out;
  const oauth = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret });
  oauth.setCredentials({ refresh_token: creds.refreshToken });
  const yt = ytClient({ version: "v3", auth: oauth });
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await yt.videos.list({ part: ["statistics"], id: batch });
    for (const it of res.data.items ?? []) {
      if (!it.id) continue;
      out.set(it.id, {
        views: num(it.statistics?.viewCount),
        likes: num(it.statistics?.likeCount),
        comments: num(it.statistics?.commentCount),
      });
    }
  }
  return out;
}

// --- X/Twitter: v2 tweets public_metrics (impressions/likes/RT/replies) ---
export async function fetchTwitter(
  creds: TwitterCredentials,
  ids: string[],
): Promise<MetricsByPostId> {
  const out: MetricsByPostId = new Map();
  if (ids.length === 0) return out;
  const client = new TwitterApi({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await client.v2.tweets(batch, { "tweet.fields": ["public_metrics"] });
    for (const t of res.data ?? []) {
      const pm = (t.public_metrics ?? {}) as Record<string, number>;
      out.set(t.id, {
        views: num(pm.impression_count),
        likes: num(pm.like_count),
        shares: num(pm.retweet_count),
        comments: num(pm.reply_count),
      });
    }
  }
  return out;
}

// --- Graph API (Facebook + Instagram) helpers ---
interface GraphFetch {
  (url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

async function graphGet(
  base: string,
  path: string,
  token: string,
  fetchImpl: GraphFetch,
): Promise<Record<string, unknown> | null> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetchImpl(`${base}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return res.ok ? json : null;
}

/** First insights value for the first metric that resolves, else undefined. */
async function graphInsightValue(
  base: string,
  id: string,
  metrics: string[],
  token: string,
  fetchImpl: GraphFetch,
): Promise<number | undefined> {
  for (const metric of metrics) {
    const j = await graphGet(base, `${id}/insights?metric=${metric}`, token, fetchImpl).catch(() => null);
    const data = j?.data as Array<{ values?: Array<{ value?: unknown }> }> | undefined;
    const v = data?.[0]?.values?.[0]?.value;
    const n = num(v);
    if (n !== undefined) return n;
  }
  return undefined;
}

// --- Facebook: page video/reel likes+comments via summary, views via insights ---
export async function fetchFacebook(
  creds: FacebookCredentials,
  ids: string[],
  fetchImpl: GraphFetch = fetch as unknown as GraphFetch,
): Promise<MetricsByPostId> {
  const out: MetricsByPostId = new Map();
  if (ids.length === 0) return out;
  const base = `https://graph.facebook.com/${creds.graphVersion}`;
  const tok = creds.pageAccessToken;
  for (const id of ids) {
    const m: PostMetrics = {};
    const j = await graphGet(
      base,
      `${id}?fields=likes.summary(true).limit(0),comments.summary(true).limit(0)`,
      tok,
      fetchImpl,
    ).catch(() => null);
    if (j) {
      m.likes = num((j.likes as { summary?: { total_count?: unknown } })?.summary?.total_count);
      m.comments = num((j.comments as { summary?: { total_count?: unknown } })?.summary?.total_count);
    }
    // Reels vs feed videos expose different view metrics — try the common ones.
    m.views = await graphInsightValue(
      base,
      id,
      ["post_video_views", "blue_reels_play_count", "post_impressions"],
      tok,
      fetchImpl,
    );
    out.set(id, m);
  }
  return out;
}

// --- Instagram: media like_count/comments_count + reel views via insights ---
export async function fetchInstagram(
  creds: InstagramCredentials,
  ids: string[],
  fetchImpl: GraphFetch = fetch as unknown as GraphFetch,
): Promise<MetricsByPostId> {
  const out: MetricsByPostId = new Map();
  if (ids.length === 0) return out;
  const base = `https://graph.facebook.com/${creds.graphVersion}`;
  const tok = creds.accessToken;
  for (const id of ids) {
    const m: PostMetrics = {};
    const j = await graphGet(base, `${id}?fields=like_count,comments_count`, tok, fetchImpl).catch(
      () => null,
    );
    if (j) {
      m.likes = num(j.like_count);
      m.comments = num(j.comments_count);
    }
    // "views" is the current reel metric; "plays"/"reach" are older fallbacks.
    m.views = await graphInsightValue(base, id, ["views", "plays", "reach"], tok, fetchImpl);
    out.set(id, m);
  }
  return out;
}
