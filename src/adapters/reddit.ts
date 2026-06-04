import type { Publisher } from "../core/publisher.js";
import type { Post, PublishResult, PlatformStatus, ErrorCode, PublishContext } from "../core/types.js";
import type { RedditCredentials } from "../config/env.js";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";
const MAX_TITLE = 300; // Reddit's hard cap

/** Minimal fetch shape (injectable for tests). */
export interface RedditFetchLike {
  (
    url: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
}

export interface RedditDeps {
  fetchImpl?: RedditFetchLike;
  /** Inject a clock for token expiry tests. */
  now?: () => number;
}

/**
 * Submits posts to Reddit (installed-app OAuth, refresh-token grant).
 *
 *  - text-only post  -> `self` submission (selftext = post.text)
 *  - post.link OR ctx.youtube.url OR ctx.blog.url (when media present) -> `link`
 *  - media without any usable link  -> validation error (native media upload
 *    isn't implemented yet — include `blog` in targets or pass `post.link`)
 *
 * Defaults to the user's own profile sub (`u_<username>`) which is always
 * safe; override with `REDDIT_SUBREDDIT` for community subs (mind their rules).
 */
export class RedditPublisher implements Publisher {
  readonly platform = "reddit" as const;
  private readonly fetchImpl: RedditFetchLike;
  private readonly now: () => number;
  private readonly userAgent: string;
  private accessToken?: string;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly creds: RedditCredentials,
    deps: RedditDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as RedditFetchLike);
    this.now = deps.now ?? (() => Date.now());
    this.userAgent = `lilgeckos-hub/0.1 by /u/${creds.username}`;
  }

  async publish(post: Post, ctx?: PublishContext): Promise<PublishResult> {
    const start = Date.now();
    const fail = (errorCode: ErrorCode, error: string): PublishResult => ({
      platform: this.platform,
      ok: false,
      error,
      errorCode,
      durationMs: Date.now() - start,
    });

    const { title, body } = splitTitleBody(post);
    if (!title) return fail("validation", "Reddit post needs a title (post.title or non-empty text)");

    const hasMedia = (post.media ?? []).length > 0;
    const linkUrl =
      post.link ?? ctx?.youtube?.url ?? ctx?.blog?.url ?? undefined;
    let kind: "self" | "link";
    const params: Record<string, string> = {
      sr: this.creds.subreddit,
      title: title.slice(0, MAX_TITLE),
      api_type: "json",
      resubmit: "true",
      sendreplies: "false",
    };
    if (linkUrl) {
      kind = "link";
      params.url = linkUrl;
    } else if (hasMedia) {
      // Media post but nothing to link to — native upload isn't built yet.
      return fail(
        "validation",
        "Reddit needs a link source for media posts (include `blog` in targets, set `post.link`, or wait for native upload support)",
      );
    } else {
      kind = "self";
      params.text = body;
    }
    params.kind = kind;

    try {
      const submitted = await this.submit(params);
      return {
        platform: this.platform,
        ok: true,
        postId: submitted.id,
        url: submitted.url,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const { errorCode, message } = mapError(err);
      return fail(errorCode, message);
    }
  }

  async checkStatus(): Promise<PlatformStatus> {
    try {
      const me = await this.api("GET", "/api/v1/me");
      const name = typeof me.name === "string" ? me.name : this.creds.username;
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: true,
        detail: `/u/${name} → ${this.creds.subreddit}`,
      };
    } catch (err) {
      const { errorCode, message } = mapError(err);
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

  /** Submit a post via /api/submit and unwrap the {errors,data} envelope. */
  private async submit(params: Record<string, string>): Promise<{ id: string; url: string }> {
    const res = await this.api("POST", "/api/submit", params);
    const errors: any[] = res?.json?.errors ?? [];
    if (errors.length > 0) {
      const [code, message] = errors[0]!;
      const e = new Error(`Reddit: ${message ?? code}`) as Error & { code?: string };
      e.code = String(code ?? "");
      throw e;
    }
    const data = res?.json?.data ?? {};
    const id = String(data.id ?? "");
    const url = String(data.url ?? "");
    if (!id || !url) throw new Error("Reddit submit returned no id/url");
    return { id, url };
  }

  /** Authenticated Reddit API call. Refreshes the access token on demand. */
  private async api(method: "GET" | "POST", path: string, params?: Record<string, string>): Promise<any> {
    await this.ensureAccessToken();
    const headers: Record<string, string> = {
      Authorization: `bearer ${this.accessToken}`,
      "User-Agent": this.userAgent,
    };
    let url = `${API_BASE}${path}`;
    let body: URLSearchParams | undefined;
    if (method === "POST") {
      body = new URLSearchParams(params);
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (params) {
      url += `?${new URLSearchParams(params).toString()}`;
    }
    const res = await this.fetchImpl(url, { method, headers, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(
        typeof json?.message === "string" ? `Reddit API ${res.status}: ${json.message}` : `Reddit API ${res.status}`,
      ) as Error & { httpStatus?: number };
      e.httpStatus = res.status;
      throw e;
    }
    return json;
  }

  /** Refresh the OAuth access token if we don't have one or it's about to expire. */
  private async ensureAccessToken(): Promise<void> {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt - 30_000) return;
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.creds.refreshToken }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !json.access_token) {
      const e = new Error(`Reddit token exchange ${res.status}`) as Error & { httpStatus?: number };
      e.httpStatus = res.status;
      throw e;
    }
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
  }
}

/** Reddit needs a title — derive it the same way the blog adapter does. */
export function splitTitleBody(post: Post): { title: string; body: string } {
  const explicit = post.title?.trim();
  if (explicit) return { title: explicit, body: (post.text ?? "").trim() };
  const lines = (post.text ?? "").split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return { title: "", body: "" };
  return {
    title: (lines[firstIdx] ?? "").trim(),
    body: lines.slice(firstIdx + 1).join("\n").trim(),
  };
}

export function mapError(err: unknown): { errorCode: ErrorCode; message: string } {
  const e = err as { code?: string; httpStatus?: number; message?: string };
  const message = typeof e?.message === "string" ? e.message : String(err ?? "unknown error");
  if (e?.code === "RATELIMIT" || e?.httpStatus === 429) return { errorCode: "rate_limit", message };
  if (e?.httpStatus === 401 || e?.httpStatus === 403) return { errorCode: "auth", message };
  if (e?.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500) return { errorCode: "validation", message };
  if (e?.httpStatus === undefined && /(ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network)/i.test(message))
    return { errorCode: "network", message };
  return { errorCode: "unknown", message };
}
