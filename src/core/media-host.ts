import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

/** Public URLs for hosted media + a way to clean them up afterwards. */
export interface HostedMedia {
  urls: string[];
  /** Best-effort removal of the hosted files. Called once the consumer (e.g.
   *  Instagram) has ingested the media. No-op hosts may leave this empty. */
  cleanup(): Promise<void>;
}

/**
 * Turns local media files into public URLs. Needed by adapters (Instagram)
 * whose API ingests media by URL rather than by binary upload.
 */
export interface MediaHost {
  host(localPaths: string[]): Promise<HostedMedia>;
}

export interface GitHubReleaseMediaHostConfig {
  /** PAT with Contents: write on the repo (reuses the blog token; Contents
   *  also governs releases + their assets). */
  token: string;
  /** "owner/name". */
  repo: string;
  /** Tag of the (single, reused) release assets are attached to. Default "hub-media". */
  tag?: string;
}

/** Minimal fetch shape (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string | Uint8Array; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<any> }>;

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/**
 * Hosts media as **GitHub Release assets**, not git objects. Assets live in
 * GitHub's separate asset storage, so they (a) don't bloat the repo/git history,
 * (b) have public download URLs (works for a public repo), and (c) can be truly
 * deleted to reclaim space. All assets hang off one reused prerelease tag; each
 * `host()` returns a `cleanup()` that deletes the assets it created.
 */
export class GitHubReleaseMediaHost implements MediaHost {
  private readonly tag: string;
  constructor(
    private readonly config: GitHubReleaseMediaHostConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.tag = config.tag ?? "hub-media";
  }

  async host(localPaths: string[]): Promise<HostedMedia> {
    if (localPaths.length === 0) return { urls: [], cleanup: async () => {} };

    const releaseId = await this.getOrCreateReleaseId();
    const assetIds: number[] = [];
    const urls: string[] = [];
    const stamp = Date.now();

    for (let i = 0; i < localPaths.length; i++) {
      const local = localPaths[i]!;
      const name = `${stamp}-${String(i + 1).padStart(2, "0")}-${safeName(local)}`;
      const contentType = CONTENT_TYPES[extname(local).toLowerCase()] ?? "application/octet-stream";
      const res = await this.fetchImpl(
        `${UPLOADS}/repos/${this.config.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { ...this.authHeaders(), "Content-Type": contentType }, body: readFileSync(local) },
      );
      if (!res.ok) throw await this.err(res, "asset upload");
      const j = await res.json();
      assetIds.push(j.id);
      urls.push(j.browser_download_url);
    }

    return {
      urls,
      cleanup: async () => {
        for (const id of assetIds) {
          try {
            await this.fetchImpl(`${API}/repos/${this.config.repo}/releases/assets/${id}`, {
              method: "DELETE",
              headers: this.authHeaders(),
            });
          } catch {
            /* best-effort — a leftover asset is harmless and re-cleaned on the next run never matters */
          }
        }
      },
    };
  }

  /** Find the reused release by tag, creating it (as a prerelease) the first time. */
  private async getOrCreateReleaseId(): Promise<number> {
    const get = await this.fetchImpl(
      `${API}/repos/${this.config.repo}/releases/tags/${encodeURIComponent(this.tag)}`,
      { method: "GET", headers: this.authHeaders() },
    );
    if (get.ok) return (await get.json()).id;
    if (get.status !== 404) throw await this.err(get, "get release");

    const create = await this.fetchImpl(`${API}/repos/${this.config.repo}/releases`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: this.tag,
        name: "hub media (transient)",
        body: "Transient media the broadcast hub uploads so Instagram can ingest it by URL. Assets are deleted after publishing.",
        prerelease: true,
        make_latest: "false",
      }),
    });
    if (!create.ok) throw await this.err(create, "create release");
    return (await create.json()).id;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lilgeckos-hub",
    };
  }

  private async err(
    res: { status: number; statusText: string; json: () => Promise<any> },
    what: string,
  ): Promise<Error & { status: number }> {
    let detail = "";
    try {
      const j = await res.json();
      if (j?.message) detail = ` — ${j.message}`;
    } catch {
      /* non-JSON */
    }
    return Object.assign(new Error(`GitHub release media host ${what} ${res.status} ${res.statusText}${detail}`), {
      status: res.status,
    });
  }
}

function safeName(p: string): string {
  return basename(p).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "") || "media";
}
