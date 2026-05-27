import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubReleaseMediaHost, type FetchLike } from "../media-host.js";

const file = join(tmpdir(), `hub-mh-${process.pid}.jpg`);
beforeAll(() => writeFileSync(file, Buffer.alloc(32)));
afterAll(() => rmSync(file, { force: true }));

/** Release found on first lookup. */
function existingReleaseFetch(): FetchLike {
  let asset = 0;
  return vi.fn(async (url: string) => {
    const j = async () => {
      if (url.includes("/releases/tags/")) return { id: 555 };
      if (url.includes("/releases/") && url.includes("/assets?name=")) {
        const id = ++asset;
        return { id, browser_download_url: `https://github.com/owner/repo/releases/download/hub-media/asset${id}` };
      }
      return {};
    };
    return { ok: true, status: 200, statusText: "OK", json: j };
  }) as unknown as FetchLike;
}

describe("GitHubReleaseMediaHost", () => {
  it("uploads files as release assets and returns their download URLs", async () => {
    const f = existingReleaseFetch();
    const host = new GitHubReleaseMediaHost({ token: "t", repo: "owner/repo" }, f);
    const { urls } = await host.host([file]);
    expect(urls).toEqual(["https://github.com/owner/repo/releases/download/hub-media/asset1"]);
    const calls = (f as unknown as { mock: { calls: [string, { method?: string }][] } }).mock.calls;
    expect(calls.some((c) => c[0].includes("uploads.github.com") && c[0].includes("/releases/555/assets?name="))).toBe(true);
  });

  it("creates the release on first use when the tag is missing (404)", async () => {
    let created = false;
    const f = vi.fn(async (url: string, init?: { method?: string }) => {
      const j = async () => {
        if (url.includes("/releases/tags/")) return {}; // body unused on 404
        if (url.endsWith("/releases")) {
          created = true;
          return { id: 777 };
        }
        if (url.includes("/assets?name=")) return { id: 1, browser_download_url: "https://x/asset1" };
        return {};
      };
      const is404 = url.includes("/releases/tags/");
      return { ok: !is404, status: is404 ? 404 : 200, statusText: is404 ? "Not Found" : "OK", json: j };
    }) as unknown as FetchLike;
    const host = new GitHubReleaseMediaHost({ token: "t", repo: "owner/repo" }, f);
    await host.host([file]);
    expect(created).toBe(true);
  });

  it("cleanup() deletes the uploaded assets", async () => {
    const f = existingReleaseFetch();
    const host = new GitHubReleaseMediaHost({ token: "t", repo: "owner/repo" }, f);
    const hosted = await host.host([file]);
    await hosted.cleanup();
    const calls = (f as unknown as { mock: { calls: [string, { method?: string }][] } }).mock.calls;
    expect(calls.some((c) => c[1]?.method === "DELETE" && c[0].includes("/releases/assets/1"))).toBe(true);
  });

  it("returns empty (no API calls) for no files", async () => {
    const f = existingReleaseFetch();
    const host = new GitHubReleaseMediaHost({ token: "t", repo: "owner/repo" }, f);
    expect((await host.host([])).urls).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});
