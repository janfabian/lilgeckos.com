import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Publisher } from "../core/publisher.js";
import type { Post, PublishResult, PlatformStatus, ErrorCode, MediaItem } from "../core/types.js";
import type { BlogConfig } from "../config/env.js";
import { validateMedia } from "../core/media.js";

const GITHUB_API = "https://api.github.com";
const MAX_TITLE_LEN = 100;
const MAX_SLUG_LEN = 60;
// GitHub Contents API is fine for modest files; keep blog media well under its limit.
const MAX_BLOG_MEDIA_BYTES = 25 * 1024 * 1024;

/** The slice of the GitHub Contents API we use. Lets tests inject a fake. */
export interface BlogClientLike {
  /**
   * Create a file at `path` on `branch`. Resolves the commit + published file
   * URL. Throws on any non-2xx response (error carries `status` + parsed body).
   */
  createFile(args: {
    path: string;
    /** UTF-8 file contents, base64-encoded (Contents API requirement). */
    contentBase64: string;
    message: string;
    branch: string;
  }): Promise<{ commitSha: string; htmlUrl: string }>;
  /** Best-effort repo read for health (verifies token + repo visibility). */
  getRepo(): Promise<{ fullName: string }>;
}

export interface BlogDeps {
  client?: BlogClientLike;
  /** Clock injection for deterministic slugs/dates in tests. */
  now?: () => Date;
}

/**
 * Publishes a post as a markdown file in the Astro blog (site/src/content/blog)
 * via the GitHub Contents API. The commit triggers the Pages deploy workflow.
 *
 * Media: each image/video is uploaded into the site's public dir
 * (site/public/blog-media/<id>/) and embedded in the post markdown by absolute
 * URL (images via ![], video via a <video> tag), which avoids Astro base-path
 * quirks. Each upload + the post are separate Contents API commits on the
 * branch; the final commit triggers the Pages deploy.
 */
export class BlogPublisher implements Publisher {
  readonly platform = "blog" as const;
  private readonly client: BlogClientLike;
  private readonly now: () => Date;

  constructor(
    private readonly config: BlogConfig,
    deps: BlogDeps = {},
  ) {
    this.client = deps.client ?? new GitHubContentsClient(config);
    this.now = deps.now ?? (() => new Date());
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

    const now = this.now();
    const { title, body } = splitTitleBody(post, now);
    const slug = slugify(title) || "post";
    const id = `${dateStamp(now)}-${slug}`;

    const media = post.media ?? [];
    // Validate media up front (no network): exists + within size cap.
    for (const item of media) {
      const v = validateMedia(item, MAX_BLOG_MEDIA_BYTES);
      if (!v.ok) return fail("validation", v.reason);
    }

    const siteUrl = this.config.siteUrl.replace(/\/+$/, "");
    const mediaDir = mediaDirFor(this.config.contentDir, id); // e.g. site/public/blog-media/<id>
    const branch = this.config.branch;

    try {
      // 1) Upload each media file into the site's public dir, collect markdown embeds.
      const embeds: string[] = [];
      for (let i = 0; i < media.length; i++) {
        const item = media[i]!;
        const fileName = mediaFileName(item, i);
        await this.client.createFile({
          path: `${mediaDir}/${fileName}`,
          contentBase64: readFileSync(item.path).toString("base64"),
          message: `blog media: ${title}`.slice(0, 100),
          branch,
        });
        const publicUrl = `${siteUrl}/blog-media/${id}/${fileName}`;
        embeds.push(embedFor(item, publicUrl, title));
      }

      // 2) Write the post markdown per language. translationKey ties the
      //    en + cs versions together; media embeds are shared across both.
      const dir = this.config.contentDir.replace(/\/+$/, "");
      const writeLang = async (lang: "en" | "cs", ttl: string, bodyText: string) => {
        const fullBody = [embeds.join("\n\n"), appendLink(bodyText, post.link)]
          .filter((s) => s.length > 0)
          .join("\n\n");
        const md = renderMarkdown({ title: ttl, body: fullBody, date: now, lang, translationKey: id });
        await this.client.createFile({
          path: `${dir}/${id}${lang === "en" ? "" : `.${lang}`}.md`,
          contentBase64: Buffer.from(md, "utf8").toString("base64"),
          message: `blog: ${ttl}`.slice(0, 100),
          branch,
        });
      };
      await writeLang("en", title, body);
      const cs = post.translations?.cs;
      if (cs) await writeLang("cs", cs.title?.trim() || title, cs.text ?? "");
      return {
        platform: this.platform,
        ok: true,
        postId: id,
        // Permalink on the published site (htmlUrl is the source file on GitHub).
        url: `${this.config.siteUrl.replace(/\/+$/, "")}/blog/${id}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const { errorCode, message } = mapError(err);
      return fail(errorCode, message);
    }
  }

  async checkStatus(): Promise<PlatformStatus> {
    // credentials are present by construction (registry only builds this when set)
    try {
      const repo = await this.client.getRepo();
      return {
        platform: this.platform,
        enabled: true,
        credentialsPresent: true,
        healthy: true,
        detail: repo.fullName,
      };
    } catch (err) {
      const { errorCode, message } = mapError(err);
      // A bad/insufficient token is genuinely unhealthy; anything else we can't
      // confirm, so leave healthy undefined rather than asserting failure.
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

// --- pure helpers (exported for tests) ---

/**
 * Decide the post title and body.
 * - Explicit `post.title` wins; body is the full text.
 * - Otherwise the first non-empty line becomes the title and the rest the body.
 * - Title-less, text-less posts (media/link only) get a dated fallback title.
 */
export function splitTitleBody(post: Post, now: Date): { title: string; body: string } {
  const explicit = post.title?.trim();
  if (explicit) return { title: clampTitle(explicit), body: post.text.trim() };

  const lines = post.text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return { title: `Update ${dateStamp(now)}`, body: "" };

  const title = clampTitle((lines[firstIdx] ?? "").trim());
  const body = lines.slice(firstIdx + 1).join("\n").trim();
  return { title, body };
}

function clampTitle(s: string): string {
  return s.length > MAX_TITLE_LEN ? `${s.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…` : s;
}

/** Append a link to the body if present and not already there. */
export function appendLink(body: string, link?: string): string {
  if (!link || body.includes(link)) return body;
  return body ? `${body}\n\n${link}` : link;
}

/** Render YAML frontmatter + body. Frontmatter strings are quoted + escaped. */
export function renderMarkdown(args: {
  title: string;
  body: string;
  date: Date;
  lang?: "en" | "cs";
  translationKey?: string;
}): string {
  const fm = [
    "---",
    `title: ${yamlString(args.title)}`,
    `pubDate: ${args.date.toISOString()}`,
    "draft: false",
    ...(args.lang ? [`lang: ${args.lang}`] : []),
    ...(args.translationKey ? [`translationKey: ${yamlString(args.translationKey)}`] : []),
    "---",
  ].join("\n");
  return `${fm}\n\n${args.body}\n`.replace(/\n{3,}/g, "\n\n");
}

/**
 * Serialize a string as a safe double-quoted YAML scalar: escape backslashes and
 * quotes, collapse newlines. Prevents a malicious/odd title from breaking or
 * injecting frontmatter.
 */
export function yamlString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return `"${escaped}"`;
}

/** URL/file-safe slug: ascii-fold, lowercase, dashes, trimmed and capped. */
export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
}

function dateStamp(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Repo-relative public dir for a post's media, derived from the content dir. */
export function mediaDirFor(contentDir: string, id: string): string {
  const siteRoot = contentDir.split("/src/")[0] || "site";
  return `${siteRoot}/public/blog-media/${id}`;
}

/** Safe, ordered filename for an uploaded media item. */
export function mediaFileName(item: MediaItem, index: number): string {
  const raw = basename(item.path).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "");
  const safe = raw || `media${extname(item.path) || ""}`;
  return `${String(index + 1).padStart(2, "0")}-${safe}`;
}

/** Markdown/HTML embed for a media item referenced by its published URL. */
export function embedFor(item: MediaItem, url: string, title: string): string {
  if (item.kind === "video") {
    return `<video controls playsinline style="max-width:100%" src="${url}"></video>`;
  }
  const alt = (item.altText ?? title).replace(/[[\]]/g, "");
  return `![${alt}](${url})`;
}

/** Map a GitHub API error (or anything) to our ErrorCode without throwing. */
export function mapError(err: unknown): { errorCode: ErrorCode; message: string } {
  const anyErr = err as { status?: unknown; message?: unknown; detail?: unknown };
  const base =
    typeof anyErr?.message === "string" ? anyErr.message : String(err ?? "unknown error");
  const detail = typeof anyErr?.detail === "string" && anyErr.detail ? ` — ${anyErr.detail}` : "";
  const message = `${base}${detail}`;
  const status = typeof anyErr?.status === "number" ? anyErr.status : undefined;

  if (status === 401 || status === 403) return { errorCode: "auth", message };
  if (status === 429) return { errorCode: "rate_limit", message };
  // 404 = repo/path not visible to the token; 409/422 = conflict (file exists)
  // or invalid request. All are caller-fixable validation problems.
  if (status === 404 || status === 409 || status === 422) {
    return { errorCode: "validation", message };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { errorCode: "validation", message };
  }
  if (status === undefined && /(ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network)/i.test(message)) {
    return { errorCode: "network", message };
  }
  return { errorCode: "unknown", message };
}

// --- default client (real GitHub Contents API over fetch) ---

class GitHubContentsClient implements BlogClientLike {
  constructor(private readonly config: BlogConfig) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lilgeckos-hub",
    };
  }

  async createFile(args: {
    path: string;
    contentBase64: string;
    message: string;
    branch: string;
  }): Promise<{ commitSha: string; htmlUrl: string }> {
    const url = `${GITHUB_API}/repos/${this.config.repo}/contents/${encodePath(args.path)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: args.message,
        content: args.contentBase64,
        branch: args.branch,
      }),
    });
    if (!res.ok) throw await httpError(res);
    const json = (await res.json()) as {
      commit?: { sha?: string };
      content?: { html_url?: string };
    };
    return {
      commitSha: json.commit?.sha ?? "",
      htmlUrl: json.content?.html_url ?? "",
    };
  }

  async getRepo(): Promise<{ fullName: string }> {
    const res = await fetch(`${GITHUB_API}/repos/${this.config.repo}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await httpError(res);
    const json = (await res.json()) as { full_name?: string };
    return { fullName: json.full_name ?? this.config.repo };
  }
}

/** Build a thrown error carrying the HTTP status + GitHub's message body. */
async function httpError(res: Response): Promise<Error & { status: number; detail?: string }> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    if (typeof body?.message === "string") detail = body.message;
  } catch {
    /* non-JSON body */
  }
  return Object.assign(new Error(`GitHub API ${res.status} ${res.statusText}`), {
    status: res.status,
    detail,
  });
}

/** Encode each path segment but keep the slashes. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
