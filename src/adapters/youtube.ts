import { createReadStream } from "node:fs";
import { youtube } from "@googleapis/youtube";
import { OAuth2Client } from "google-auth-library";
import type { Publisher } from "../core/publisher.js";
import type { Post, PublishResult, PlatformStatus, ErrorCode } from "../core/types.js";
import type { YouTubeCredentials } from "../config/env.js";
import { validateMedia } from "../core/media.js";

const MAX_TITLE = 100;
const DEFAULT_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const CATEGORY_PETS_ANIMALS = "15";

/** The slice of the YouTube API we use. Lets tests inject a fake. */
export interface YouTubeClientLike {
  insertVideo(args: {
    title: string;
    description: string;
    privacyStatus: string;
    filePath: string;
  }): Promise<{ id: string }>;
  channelTitle(): Promise<string>;
}

export interface YouTubeDeps {
  client?: YouTubeClientLike;
  videoMaxBytes?: number;
  /** Tag uploads as Shorts (vertical source still required by YouTube). Default true. */
  shorts?: boolean;
}

/**
 * Uploads a video to YouTube via Data API v3 `videos.insert` (OAuth2 refresh
 * token). Shorts-oriented: a video is a Short when it's vertical and ≤3 min;
 * we add #Shorts to reinforce it. YouTube transcodes the file server-side, so
 * no local format conversion is needed.
 */
export class YouTubePublisher implements Publisher {
  readonly platform = "youtube" as const;
  private readonly client: YouTubeClientLike;
  private readonly privacy: string;
  private readonly videoMaxBytes: number;
  private readonly shorts: boolean;

  constructor(creds: YouTubeCredentials, deps: YouTubeDeps = {}) {
    this.client = deps.client ?? new GoogleYouTubeClient(creds);
    this.privacy = creds.privacy;
    this.videoMaxBytes = deps.videoMaxBytes ?? DEFAULT_VIDEO_MAX_BYTES;
    this.shorts = deps.shorts ?? true;
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

    const videos = (post.media ?? []).filter((m) => m.kind === "video");
    if (videos.length === 0) return fail("validation", "YouTube requires a video to upload");
    if (videos.length > 1) return fail("validation", "YouTube uploads one video at a time");
    const video = videos[0]!;
    const v = validateMedia(video, this.videoMaxBytes);
    if (!v.ok) return fail("validation", v.reason);

    const { title, description } = composeMeta(post, this.shorts);
    try {
      const { id } = await this.client.insertVideo({
        title,
        description,
        privacyStatus: this.privacy,
        filePath: video.path,
      });
      return {
        platform: this.platform,
        ok: true,
        postId: id,
        url: this.shorts ? `https://www.youtube.com/shorts/${id}` : `https://youtu.be/${id}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const { errorCode, message } = mapError(err);
      return fail(errorCode, message);
    }
  }

  async checkStatus(): Promise<PlatformStatus> {
    try {
      const title = await this.client.channelTitle();
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: true,
        detail: title,
      };
    } catch (err) {
      const { errorCode, message } = mapError(err);
      const healthy = errorCode === "auth" ? false : undefined;
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy,
        detail: `liveness ${healthy === false ? "failed" : "unknown"} (${errorCode}): ${message}`,
      };
    }
  }
}

/** Build the YouTube title + description from a post (Shorts reinforced). */
export function composeMeta(post: Post, shorts: boolean): { title: string; description: string } {
  const firstLine = (post.text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const title = (post.title?.trim() || firstLine.trim() || "lilgeckos").slice(0, MAX_TITLE);
  let description = (post.text ?? "").trim();
  if (post.link) description = description ? `${description}\n\n${post.link}` : post.link;
  if (shorts && !/#shorts\b/i.test(`${title} ${description}`)) {
    description = `${description}\n\n#Shorts`.trim();
  }
  return { title, description };
}

/** Map a Google/YouTube API error to our ErrorCode without throwing. */
export function mapError(err: unknown): { errorCode: ErrorCode; message: string } {
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }> } } };
  };
  const status = typeof e?.code === "number" ? e.code : (e?.status ?? e?.response?.status);
  const reason = e?.errors?.[0]?.reason ?? e?.response?.data?.error?.errors?.[0]?.reason ?? "";
  const message = typeof e?.message === "string" ? e.message : String(err ?? "unknown error");

  const quotaReasons = /quota|rateLimit|uploadLimit/i;
  if (quotaReasons.test(reason) || status === 429) return { errorCode: "rate_limit", message };
  if (status === 401) return { errorCode: "auth", message };
  if (status === 403) return { errorCode: "auth", message };
  if (typeof status === "number" && status >= 400 && status < 500) return { errorCode: "validation", message };
  if (status === undefined && /(ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network)/i.test(message)) {
    return { errorCode: "network", message };
  }
  return { errorCode: "unknown", message };
}

// --- default client (real YouTube Data API v3 over OAuth2) ---

class GoogleYouTubeClient implements YouTubeClientLike {
  private readonly yt;
  constructor(creds: YouTubeCredentials) {
    const oauth = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret });
    oauth.setCredentials({ refresh_token: creds.refreshToken });
    this.yt = youtube({ version: "v3", auth: oauth });
  }

  async insertVideo(args: {
    title: string;
    description: string;
    privacyStatus: string;
    filePath: string;
  }): Promise<{ id: string }> {
    const res = await this.yt.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title: args.title, description: args.description, categoryId: CATEGORY_PETS_ANIMALS },
        status: { privacyStatus: args.privacyStatus, selfDeclaredMadeForKids: false },
      },
      media: { body: createReadStream(args.filePath) },
    });
    return { id: res.data.id ?? "" };
  }

  async channelTitle(): Promise<string> {
    const res = await this.yt.channels.list({ part: ["snippet"], mine: true });
    return res.data.items?.[0]?.snippet?.title ?? "channel";
  }
}
