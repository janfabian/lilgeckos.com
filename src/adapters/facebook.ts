import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Publisher } from "../core/publisher.js";
import type { Post, PublishResult, PlatformStatus, ErrorCode, MediaItem } from "../core/types.js";
import type { FacebookCredentials } from "../config/env.js";
import { validateMedia } from "../core/media.js";

/** Minimal shape of the fetch we use — lets tests inject a stub. */
export interface FetchLike {
  (
    url: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface FacebookDeps {
  fetchImpl?: FetchLike;
  mediaMaxBytes?: number;
  videoMaxBytes?: number;
  /** Publish a single video as a Reel (3-phase /video_reels) rather than a
   *  regular /videos post. Reels get far more reach. Default true. */
  reels?: boolean;
}

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 512 * 1024 * 1024;

interface GraphError {
  message?: string;
  code?: number;
  type?: string;
}

/**
 * Posts to a Facebook Page via the Graph API (direct REST, no SDK):
 *  - text / link        -> POST /{page}/feed
 *  - single image       -> POST /{page}/photos (multipart)
 *  - multiple images    -> unpublished /photos uploads + /feed with attached_media
 *  - video              -> POST /{page}/videos (multipart)
 */
export class FacebookPublisher implements Publisher {
  readonly platform = "facebook" as const;
  private readonly fetchImpl: FetchLike;
  private readonly graphBase: string;
  private readonly pageId: string;
  private readonly token: string;
  private readonly maxBytes: number;
  private readonly videoMaxBytes: number;
  private readonly reels: boolean;

  constructor(creds: FacebookCredentials, deps: FacebookDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    this.graphBase = `https://graph.facebook.com/${creds.graphVersion}`;
    this.pageId = creds.pageId;
    this.token = creds.pageAccessToken;
    this.maxBytes = deps.mediaMaxBytes ?? DEFAULT_MAX_BYTES;
    this.videoMaxBytes = deps.videoMaxBytes ?? DEFAULT_VIDEO_MAX_BYTES;
    this.reels = deps.reels ?? true;
  }

  async publish(post: Post): Promise<PublishResult> {
    const start = Date.now();
    const fail = (errorCode: ErrorCode, error: string): PublishResult => ({
      platform: this.platform,
      ok: false,
      error,
      errorCode,
      durationMs: Date.now() - start,
    });
    // Facebook returns the post id as `pageId_postId`, and the legacy URL
    // `facebook.com/<that>` increasingly shows "broken link" (esp. for Pages
    // in the New Pages Experience, which use a different actor id). Ask the
    // Graph API for the authoritative `permalink_url` and use that; fall back
    // to the constructed URL if the lookup fails.
    const ok = async (postId: string): Promise<PublishResult> => ({
      platform: this.platform,
      ok: true,
      postId,
      url: (await this.permalinkUrl(postId)) ?? `https://www.facebook.com/${postId}`,
      durationMs: Date.now() - start,
    });

    const media = post.media ?? [];
    const videos = media.filter((m) => m.kind === "video");
    const images = media.filter((m) => m.kind === "image");

    // --- validation (no network) ---
    if (videos.length > 1) return fail("validation", `Facebook allows 1 video per post, got ${videos.length}`);
    if (videos.length === 1 && images.length > 0)
      return fail("validation", "Facebook does not allow mixing a video with images in one post");
    for (const item of media) {
      const max = item.kind === "video" ? this.videoMaxBytes : this.maxBytes;
      const v = validateMedia(item, max);
      if (!v.ok) return fail("validation", v.reason);
    }

    try {
      // Video — as a Reel (default) or a regular video post.
      if (videos.length === 1) {
        if (this.reels) {
          const reelId = await this.publishReel(videos[0]!, post.text);
          return {
            platform: this.platform,
            ok: true,
            postId: reelId,
            url: `https://www.facebook.com/reel/${reelId}`,
            durationMs: Date.now() - start,
          };
        }
        const fd = this.form({ description: post.text });
        appendFile(fd, "source", videos[0]!);
        const res = await this.graph(`${this.pageId}/videos`, fd);
        return await ok(String(res.id));
      }
      // Single image
      if (images.length === 1) {
        const fd = this.form({ message: post.text });
        appendFile(fd, "source", images[0]!);
        const res = await this.graph(`${this.pageId}/photos`, fd);
        return await ok(String(res.post_id ?? res.id));
      }
      // Multiple images: upload each unpublished, then a feed post referencing them
      if (images.length > 1) {
        const fbids: string[] = [];
        for (const img of images) {
          const fd = this.form({ published: "false" });
          appendFile(fd, "source", img);
          const up = await this.graph(`${this.pageId}/photos`, fd);
          fbids.push(String(up.id));
        }
        const body = this.params({ message: post.text });
        fbids.forEach((id, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
        const res = await this.graph(`${this.pageId}/feed`, body);
        return await ok(String(res.id));
      }
      // Text / link only
      const body = this.params({ message: post.text });
      if (post.link) body.set("link", post.link);
      const res = await this.graph(`${this.pageId}/feed`, body);
      return ok(String(res.id));
    } catch (err) {
      // FB sometimes returns "Please reduce the amount of data you're asking for"
      // even when the post actually went through (misleading backend error).
      // Verify before reporting failure — if a matching post landed on the Page
      // in the last ~90s, recover it instead of letting the caller retry and dup.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/reduce the amount of data/i.test(errMsg)) {
        const recovered = await this.verifyRecentPost(post.text);
        if (recovered) {
          return {
            platform: this.platform,
            ok: true,
            postId: recovered.id,
            url: recovered.url,
            durationMs: Date.now() - start,
          };
        }
      }
      const { errorCode, message } = mapFbError(err);
      return fail(errorCode, message);
    }
  }

  async checkStatus(): Promise<PlatformStatus> {
    try {
      const res = await this.graph(
        `${this.pageId}?fields=name&access_token=${encodeURIComponent(this.token)}`,
        undefined,
        "GET",
      );
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: true,
        detail: typeof res.name === "string" ? res.name : `page ${this.pageId}`,
      };
    } catch (err) {
      const { errorCode, message } = mapFbError(err);
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: false,
        detail: `${errorCode}: ${message}`,
      };
    }
  }

  /**
   * Publish a single video as a Facebook Reel via the 3-phase /video_reels flow:
   *  1) start  -> reserve a video id + a one-time upload URL
   *  2) upload -> POST the raw bytes to the rupload host (custom headers, not multipart)
   *  3) finish -> publish (video_state=PUBLISHED). Returns the reel/video id.
   * Processing is async on Meta's side; finish returning ok is success enough here.
   */
  private async publishReel(video: MediaItem, description: string): Promise<string> {
    const startRes = await this.graph(`${this.pageId}/video_reels`, this.params({ upload_phase: "start" }));
    const videoId = String(startRes.video_id ?? "");
    const uploadUrl = String(startRes.upload_url ?? "");
    if (!videoId || !uploadUrl) throw new Error("Reels start phase did not return video_id/upload_url");

    const buf = readFileSync(video.path);
    const up = await this.fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${this.token}`,
        offset: "0",
        file_size: String(buf.byteLength),
      },
      body: buf,
    });
    if (!up.ok) {
      const j = (await up.json().catch(() => ({}))) as { error?: GraphError };
      const e = new Error(j?.error?.message ?? `Reels upload HTTP ${up.status}`) as Error & {
        code?: number;
        httpStatus?: number;
      };
      e.code = j?.error?.code;
      e.httpStatus = up.status;
      throw e;
    }

    await this.graph(
      `${this.pageId}/video_reels`,
      this.params({ upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description }),
    );
    return videoId;
  }

  /** Idempotency check: if a misleading "reduce the amount of data" error fires
   *  while the post actually went through, find that fresh post by matching the
   *  message prefix + a 90s recency window, so the caller doesn't retry and dup. */
  private async verifyRecentPost(text: string): Promise<{ id: string; url: string } | null> {
    const prefix = (text ?? "").trim().slice(0, 40);
    if (!prefix) return null;
    try {
      const res = await this.graph(
        `${this.pageId}/posts?fields=id,message,created_time,permalink_url&limit=5&access_token=${encodeURIComponent(this.token)}`,
        undefined,
        "GET",
      );
      const data = Array.isArray((res as Record<string, unknown>).data)
        ? ((res as Record<string, unknown>).data as Array<Record<string, unknown>>)
        : [];
      const since = Date.now() - 90_000;
      for (const p of data) {
        const ctStr = typeof p.created_time === "string" ? p.created_time : "";
        const ct = ctStr ? new Date(ctStr).getTime() : NaN;
        if (!Number.isFinite(ct) || ct < since) continue;
        const message = typeof p.message === "string" ? p.message.trim() : "";
        if (message && message.startsWith(prefix)) {
          return {
            id: String(p.id),
            url:
              typeof p.permalink_url === "string"
                ? p.permalink_url
                : `https://www.facebook.com/${String(p.id)}`,
          };
        }
      }
    } catch {
      /* best-effort */
    }
    return null;
  }

  /** Best-effort lookup of a post's canonical share URL via Graph (`permalink_url`).
   *  Returns undefined on any error; the publish() ok() fallback then uses a
   *  constructed URL. Reels have their own working `/reel/<id>` URL, so this
   *  is only used by the feed/photos/videos paths. */
  private async permalinkUrl(postId: string): Promise<string | undefined> {
    try {
      const res = await this.graph(
        `${postId}?fields=permalink_url&access_token=${encodeURIComponent(this.token)}`,
        undefined,
        "GET",
      );
      if (typeof res.permalink_url === "string") return res.permalink_url;
    } catch {
      /* fall back to the constructed URL */
    }
    return undefined;
  }

  // --- helpers ---

  private params(fields: Record<string, string>): URLSearchParams {
    const p = new URLSearchParams(fields);
    p.set("access_token", this.token);
    return p;
  }

  private form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("access_token", this.token);
    return fd;
  }

  private async graph(
    path: string,
    body: URLSearchParams | FormData | undefined,
    method: "GET" | "POST" = "POST",
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.graphBase}/${path}`, { method, body });
    const json = (await res.json().catch(() => ({}))) as { error?: GraphError } & Record<string, unknown>;
    if (!res.ok) {
      const ge = json?.error ?? {};
      const e = new Error(ge.message ?? `Graph API HTTP ${res.status}`) as Error & {
        code?: number;
        httpStatus?: number;
      };
      e.code = ge.code;
      e.httpStatus = res.status;
      throw e;
    }
    return json;
  }
}

function appendFile(fd: FormData, field: string, item: MediaItem): void {
  const buf = readFileSync(item.path);
  fd.set(field, new Blob([buf]), basename(item.path));
}

/** Map a Graph API error to our ErrorCode without throwing. */
export function mapFbError(err: unknown): { errorCode: ErrorCode; message: string } {
  const e = err as { code?: number; httpStatus?: number; message?: string };
  const message = typeof e?.message === "string" ? e.message : String(err ?? "unknown error");
  const code = e?.code;
  // OAuth / permission
  if (code === 190 || code === 200 || code === 10 || code === 102) return { errorCode: "auth", message };
  // rate limiting
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001)
    return { errorCode: "rate_limit", message };
  if (e?.httpStatus === 401 || e?.httpStatus === 403) return { errorCode: "auth", message };
  if (e?.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500) return { errorCode: "validation", message };
  if (e?.httpStatus === undefined && /(ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network)/i.test(message))
    return { errorCode: "network", message };
  return { errorCode: "unknown", message };
}
