import type { Publisher } from "../core/publisher.js";
import type { Post, PublishResult, PlatformStatus, ErrorCode } from "../core/types.js";
import type { BlogConfig } from "../config/env.js";

const GITHUB_API = "https://api.github.com";
const MAX_TITLE_LEN = 100;
const MAX_SLUG_LEN = 60;

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
 * v1 is text-only: media is not embedded yet (a follow-up will upload images
 * into site/public/ and reference them). A post with media still publishes its
 * text so the blog never fails a default fan-out just because images came along.
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
    const markdown = renderMarkdown({ title, body: appendLink(body, post.link), date: now });

    const slug = slugify(title) || "post";
    const id = `${dateStamp(now)}-${slug}`;
    const fileName = `${id}.md`;
    const path = `${this.config.contentDir.replace(/\/+$/, "")}/${fileName}`;

    try {
      await this.client.createFile({
        path,
        contentBase64: Buffer.from(markdown, "utf8").toString("base64"),
        message: `blog: ${title}`.slice(0, 100),
        branch: this.config.branch,
      });
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
export function renderMarkdown(args: { title: string; body: string; date: Date }): string {
  const fm = [
    "---",
    `title: ${yamlString(args.title)}`,
    `pubDate: ${args.date.toISOString()}`,
    "draft: false",
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
