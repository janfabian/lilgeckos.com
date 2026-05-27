import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubMediaHost, type FetchLike } from "../media-host.js";

const file = join(tmpdir(), `hub-mh-${process.pid}.jpg`);
beforeAll(() => writeFileSync(file, Buffer.alloc(32)));
afterAll(() => rmSync(file, { force: true }));

function mockFetch(): FetchLike {
  let blob = 0;
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => {
      if (url.includes("/git/ref/heads/")) return { object: { sha: "headsha" } };
      if (url.includes("/git/blobs")) return { sha: `blob${++blob}` };
      if (url.includes("/git/trees")) return { sha: "newtree" };
      if (url.includes("/git/commits/")) return { tree: { sha: "basetree" } }; // GET commit
      if (url.includes("/git/commits")) return { sha: "newcommit" }; // POST create commit
      if (url.includes("/git/refs/heads/")) return {};
      return {};
    },
  })) as unknown as FetchLike;
}

describe("GitHubMediaHost", () => {
  it("commits files via the Git Data API and returns raw.githubusercontent URLs", async () => {
    const f = mockFetch();
    const host = new GitHubMediaHost({ token: "t", repo: "owner/repo", branch: "main" }, f);
    const urls = await host.hostAll([file]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/owner\/repo\/main\/hub-media\/\d+\/01-hub-mh-\d+\.jpg$/,
    );
    // Did the blob → tree → commit → ref sequence happen?
    const urlsCalled = (f as unknown as { mock: { calls: [string, { method?: string }][] } }).mock.calls.map(
      (c) => `${c[1]?.method ?? "GET"} ${c[0]}`,
    );
    expect(urlsCalled.some((u) => u.startsWith("POST") && u.includes("/git/blobs"))).toBe(true);
    expect(urlsCalled.some((u) => u.startsWith("POST") && u.includes("/git/trees"))).toBe(true);
    expect(urlsCalled.some((u) => u.startsWith("PATCH") && u.includes("/git/refs/heads/main"))).toBe(true);
  });

  it("returns empty for no files (no API calls)", async () => {
    const f = mockFetch();
    const host = new GitHubMediaHost({ token: "t", repo: "owner/repo", branch: "main" }, f);
    expect(await host.hostAll([])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});
