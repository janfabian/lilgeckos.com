import type { Publisher } from "../core/publisher.js";
import type { Post, PublishResult, PlatformStatus, ErrorCode, MediaItem } from "../core/types.js";
import type { InstagramCredentials } from "../config/env.js";
import type { MediaHost } from "../core/media-host.js";
import { validateMedia } from "../core/media.js";
import { mapFbError } from "./facebook.js";

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const MAX_CAROUSEL = 10;

/** Minimal fetch shape (injectable for tests). */
export interface IgFetchLike {
  (
    url: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface InstagramDeps {
  fetchImpl?: IgFetchLike;
  /** Hosts local media as public URLs (IG ingests media by URL, not upload). */
  mediaHost?: MediaHost;
  mediaMaxBytes?: number;
  videoMaxBytes?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface GraphError {
  message?: string;
  code?: number;
}

/**
 * Publishes to an Instagram Business account via the Graph API (Facebook-Login
 * path) using the Page access token. IG ingests media by **public URL**, so
 * local files are first uploaded through a MediaHost. Flow per the IG Content
 * Publishing API: create container(s) → poll until FINISHED → media_publish.
 *  - single image    -> image_url container
 *  - single video    -> REELS container (video_url)
 *  - 2..10 images     -> carousel (child containers + a CAROUSEL parent)
 * Instagram has no text-only posts: at least one media item is required.
 */
export class InstagramPublisher implements Publisher {
  readonly platform = "instagram" as const;
  private readonly fetchImpl: IgFetchLike;
  private readonly host?: MediaHost;
  private readonly graphBase: string;
  private readonly igUserId: string;
  private readonly token: string;
  private readonly maxBytes: number;
  private readonly videoMaxBytes: number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(creds: InstagramCredentials, deps: InstagramDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as IgFetchLike);
    this.host = deps.mediaHost;
    this.graphBase = `https://graph.facebook.com/${creds.graphVersion}`;
    this.igUserId = creds.igUserId;
    this.token = creds.accessToken;
    this.maxBytes = deps.mediaMaxBytes ?? DEFAULT_MAX_BYTES;
    this.videoMaxBytes = deps.videoMaxBytes ?? DEFAULT_VIDEO_MAX_BYTES;
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
    this.pollTimeoutMs = deps.pollTimeoutMs ?? 90_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
    const videos = media.filter((m) => m.kind === "video");
    const images = media.filter((m) => m.kind === "image");

    // --- validation (no network) ---
    if (media.length === 0) return fail("validation", "Instagram requires at least one photo or video");
    if (videos.length > 1) return fail("validation", `Instagram allows 1 video per post, got ${videos.length}`);
    if (videos.length === 1 && images.length > 0)
      return fail("validation", "Instagram: don't mix a video with images in one post");
    if (images.length > MAX_CAROUSEL)
      return fail("validation", `Instagram carousels allow up to ${MAX_CAROUSEL} images, got ${images.length}`);
    for (const item of media) {
      const v = validateMedia(item, item.kind === "video" ? this.videoMaxBytes : this.maxBytes);
      if (!v.ok) return fail("validation", v.reason);
    }
    if (!this.host) return fail("validation", "Instagram has no media host configured (needs the blog GitHub repo to host media URLs)");

    const caption = post.text ?? "";
    try {
      const urls = await this.host.hostAll(media.map((m) => m.path));

      let creationId: string;
      if (videos.length === 1) {
        creationId = await this.createContainer({ media_type: "REELS", video_url: urls[0]!, caption });
        await this.waitForContainer(creationId);
      } else if (images.length === 1) {
        creationId = await this.createContainer({ image_url: urls[0]!, caption });
        await this.waitForContainer(creationId);
      } else {
        // carousel: a child container per image, then a CAROUSEL parent
        const children: string[] = [];
        for (const url of urls) {
          children.push(await this.createContainer({ image_url: url, is_carousel_item: "true" }));
        }
        creationId = await this.createContainer({
          media_type: "CAROUSEL",
          children: children.join(","),
          caption,
        });
        await this.waitForContainer(creationId);
      }

      const publishedId = await this.publishContainer(creationId);
      return {
        platform: this.platform,
        ok: true,
        postId: publishedId,
        url: await this.permalink(publishedId),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const { errorCode, message } = mapFbError(err);
      return fail(errorCode, message);
    }
  }

  async checkStatus(): Promise<PlatformStatus> {
    try {
      const res = await this.graph(`${this.igUserId}?fields=username&access_token=${encodeURIComponent(this.token)}`, "GET");
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: true,
        detail: typeof res.username === "string" ? `@${res.username}` : `ig ${this.igUserId}`,
      };
    } catch (err) {
      const { errorCode, message } = mapFbError(err);
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: errorCode === "auth" ? false : undefined,
        detail: `${errorCode}: ${message}`,
      };
    }
  }

  // --- helpers ---

  private async createContainer(fields: Record<string, string>): Promise<string> {
    const res = await this.graph(`${this.igUserId}/media`, "POST", fields);
    const id = res.id;
    if (typeof id !== "string") throw new Error("Instagram container creation returned no id");
    return id;
  }

  private async publishContainer(creationId: string): Promise<string> {
    const res = await this.graph(`${this.igUserId}/media_publish`, "POST", { creation_id: creationId });
    const id = res.id;
    if (typeof id !== "string") throw new Error("Instagram media_publish returned no id");
    return id;
  }

  /** Poll a container until it's FINISHED (ready to publish). Video/carousel need processing. */
  private async waitForContainer(containerId: string): Promise<void> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const res = await this.graph(
        `${containerId}?fields=status_code,status&access_token=${encodeURIComponent(this.token)}`,
        "GET",
      );
      const status = String(res.status_code ?? "");
      if (status === "FINISHED") return;
      if (status === "ERROR" || status === "EXPIRED") {
        throw new Error(`Instagram media processing ${status}${res.status ? `: ${res.status}` : ""}`);
      }
      if (Date.now() >= deadline) throw new Error("Instagram media processing timed out");
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async permalink(mediaId: string): Promise<string> {
    try {
      const res = await this.graph(`${mediaId}?fields=permalink&access_token=${encodeURIComponent(this.token)}`, "GET");
      if (typeof res.permalink === "string") return res.permalink;
    } catch {
      /* permalink is best-effort */
    }
    return `https://www.instagram.com/`;
  }

  private async graph(
    path: string,
    method: "GET" | "POST",
    fields?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const init: { method: string; body?: URLSearchParams; headers?: Record<string, string> } = { method };
    if (method === "POST") {
      const body = new URLSearchParams(fields);
      body.set("access_token", this.token);
      init.body = body;
    }
    const res = await this.fetchImpl(`${this.graphBase}/${path}`, init);
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
