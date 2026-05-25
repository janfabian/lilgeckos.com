import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { TwitterApi } from "twitter-api-v2";
import type { Publisher } from "../core/publisher.js";
import type {
  Post,
  PublishResult,
  PlatformStatus,
  ErrorCode,
  MediaItem,
} from "../core/types.js";
import type { TwitterCredentials } from "../config/env.js";
import { validateMedia } from "../core/media.js";

const MAX_IMAGES = 4;

/** The slice of twitter-api-v2 we use. Lets tests inject a mock client. */
export interface TwitterClientLike {
  v2: {
    tweet(payload: { text: string; media?: { media_ids: string[] } }): Promise<{
      data: { id: string };
    }>;
    uploadMedia(
      media: Buffer,
      options: { media_type: string; media_category?: string },
    ): Promise<string>;
    me(): Promise<{ data: { id: string; username: string } }>;
  };
}

export interface TwitterDeps {
  client?: TwitterClientLike;
  /** Max media bytes (from config). */
  mediaMaxBytes?: number;
}

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

export class TwitterPublisher implements Publisher {
  readonly platform = "twitter" as const;
  private readonly client: TwitterClientLike;
  private readonly maxBytes: number;

  constructor(creds: TwitterCredentials, deps: TwitterDeps = {}) {
    this.client =
      deps.client ??
      (new TwitterApi({
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        accessToken: creds.accessToken,
        accessSecret: creds.accessSecret,
      }) as unknown as TwitterClientLike);
    this.maxBytes = deps.mediaMaxBytes ?? DEFAULT_MAX_BYTES;
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

    const media = post.media ?? [];

    // --- validation (no SDK call) ---
    if (media.some((m) => m.kind === "video")) {
      return fail("unsupported", "video posting to X is not supported until increment 1.5");
    }
    if (media.length > MAX_IMAGES) {
      return fail("validation", `X allows at most ${MAX_IMAGES} images, got ${media.length}`);
    }
    for (const item of media) {
      const v = validateMedia(item, this.maxBytes);
      if (!v.ok) return fail("validation", v.reason);
    }

    const text = composeText(post);

    // Upload phase — tag failures as media_upload (unless clearly auth/rate_limit).
    const media_ids: string[] = [];
    for (const item of media) {
      try {
        const buf = readFileSync(item.path);
        const id = await this.client.v2.uploadMedia(buf, {
          media_type: item.mimeType ?? mimeForPath(item.path),
          media_category: "tweet_image",
        });
        media_ids.push(id);
      } catch (err) {
        const { errorCode, message } = mapError(err);
        const code =
          errorCode === "auth" || errorCode === "rate_limit" ? errorCode : "media_upload";
        return fail(code, message);
      }
    }

    // Tweet phase.
    try {
      const payload = media_ids.length > 0 ? { text, media: { media_ids } } : { text };
      const res = await this.client.v2.tweet(payload);
      const id = res.data.id;
      return {
        platform: this.platform,
        ok: true,
        postId: id,
        url: `https://x.com/i/web/status/${id}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const { errorCode, message } = mapError(err);
      return fail(errorCode, message);
    }
  }

  async checkStatus(): Promise<PlatformStatus> {
    // credentials are present by construction (registry only builds this when all 4 are set)
    try {
      const me = await this.client.v2.me();
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: true,
        detail: `@${me.data.username}`,
      };
    } catch (err) {
      // Reads are often blocked on free/legacy tiers — that is NOT unhealthy,
      // it just means we cannot confirm liveness without spending a write.
      const { errorCode, message } = mapError(err);
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: undefined,
        detail: `liveness unknown (${errorCode}): ${message}`,
      };
    }
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Best-effort MIME from file extension; defaults to image/jpeg. */
function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/jpeg";
}

/** Append a link into the tweet body if present and not already there. */
function composeText(post: Post): string {
  if (post.link && !post.text.includes(post.link)) {
    return post.text ? `${post.text} ${post.link}` : post.link;
  }
  return post.text;
}

/** Map a twitter-api-v2 error (or anything) to our ErrorCode without throwing. */
export function mapError(err: unknown): { errorCode: ErrorCode; message: string } {
  const anyErr = err as {
    code?: unknown;
    rateLimitError?: unknown;
    message?: unknown;
    data?: { detail?: string; title?: string; errors?: Array<{ message?: string; detail?: string }> };
  };
  const base =
    typeof anyErr?.message === "string" ? anyErr.message : String(err ?? "unknown error");
  // Surface X's actual error body (e.g. "Your client app is not configured with the
  // appropriate oauth1 app permissions" or v2 access-tier 403 detail).
  let detail = "";
  const d = anyErr?.data;
  if (d) {
    if (typeof d.detail === "string") detail = d.detail;
    else if (Array.isArray(d.errors) && d.errors.length)
      detail = d.errors.map((e) => e.message ?? e.detail ?? JSON.stringify(e)).join("; ");
    else if (typeof d.title === "string") detail = d.title;
    else detail = JSON.stringify(d).slice(0, 300);
  }
  const message = detail ? `${base} — ${detail}` : base;

  if (anyErr?.rateLimitError === true) return { errorCode: "rate_limit", message };

  const code = typeof anyErr?.code === "number" ? anyErr.code : undefined;
  if (code === 401 || code === 403) return { errorCode: "auth", message };
  if (code === 429) return { errorCode: "rate_limit", message };
  if (code !== undefined && code >= 400 && code < 500) return { errorCode: "validation", message };

  // No HTTP status: likely a transport/connection error.
  if (code === undefined && /(ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network)/i.test(message)) {
    return { errorCode: "network", message };
  }
  return { errorCode: "unknown", message };
}
