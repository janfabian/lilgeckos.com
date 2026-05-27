import { readFileSync } from "node:fs";
import { basename } from "node:path";

const GITHUB_API = "https://api.github.com";

/**
 * Turns local media files into public URLs. Needed by adapters (Instagram)
 * whose API ingests media by URL rather than by binary upload.
 */
export interface MediaHost {
  /** Upload local files and return their public URLs, in the same order. */
  hostAll(localPaths: string[]): Promise<string[]>;
}

export interface GitHubMediaHostConfig {
  /** PAT with Contents: write on the repo (reuses the blog token). */
  token: string;
  /** "owner/name". */
  repo: string;
  /** Branch to commit media to. */
  branch: string;
  /** Repo-relative dir for hosted media (kept OUT of the Astro site dir so it
   *  isn't part of the deployed site — only served raw). Default "hub-media". */
  dir?: string;
}

/** Minimal fetch shape (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;

/**
 * Hosts media in the GitHub repo and serves it from raw.githubusercontent.com,
 * which is **public immediately** after the commit (no Pages deploy wait) and
 * handles large files. Uses the Git Data API (blob → tree → commit → ref) in a
 * single commit so it isn't limited by the Contents API's ~5MB ceiling.
 */
export class GitHubMediaHost implements MediaHost {
  private readonly dir: string;
  constructor(
    private readonly config: GitHubMediaHostConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.dir = (config.dir ?? "hub-media").replace(/\/+$/, "");
  }

  async hostAll(localPaths: string[]): Promise<string[]> {
    if (localPaths.length === 0) return [];
    const { repo, branch, token } = this.config;
    const stamp = Date.now();
    const paths = localPaths.map((p, i) => `${this.dir}/${stamp}/${String(i + 1).padStart(2, "0")}-${safeName(p)}`);

    // 1) current branch tip
    const ref = await this.api(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, "GET");
    const headSha = String((ref as any).object?.sha ?? "");
    const headCommit = await this.api(`/repos/${repo}/git/commits/${headSha}`, "GET");
    const baseTree = String((headCommit as any).tree?.sha ?? "");

    // 2) one blob per file
    const blobShas: string[] = [];
    for (const local of localPaths) {
      const blob = await this.api(`/repos/${repo}/git/blobs`, "POST", {
        content: readFileSync(local).toString("base64"),
        encoding: "base64",
      });
      blobShas.push(String((blob as any).sha));
    }

    // 3) tree → 4) commit → 5) move the branch ref
    const tree = await this.api(`/repos/${repo}/git/trees`, "POST", {
      base_tree: baseTree,
      tree: paths.map((path, i) => ({ path, mode: "100644", type: "blob", sha: blobShas[i] })),
    });
    const commit = await this.api(`/repos/${repo}/git/commits`, "POST", {
      message: `hub media (${localPaths.length} file${localPaths.length > 1 ? "s" : ""})`,
      tree: String((tree as any).sha),
      parents: [headSha],
    });
    await this.api(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, "PATCH", {
      sha: String((commit as any).sha),
    });

    return paths.map((p) => `https://raw.githubusercontent.com/${repo}/${branch}/${encodePath(p)}`);
  }

  private async api(path: string, method: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lilgeckos-hub",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { message?: string };
        if (j?.message) detail = ` — ${j.message}`;
      } catch {
        /* non-JSON */
      }
      throw Object.assign(new Error(`GitHub media host ${res.status} ${res.statusText}${detail}`), {
        status: res.status,
      });
    }
    return res.json();
  }
}

function safeName(p: string): string {
  return basename(p).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "") || "media";
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
