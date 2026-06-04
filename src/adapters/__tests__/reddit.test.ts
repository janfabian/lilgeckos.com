import { describe, it, expect, vi } from "vitest";
import { RedditPublisher, splitTitleBody, mapError, type RedditFetchLike } from "../reddit.js";
import type { RedditCredentials } from "../../config/env.js";

const creds: RedditCredentials = {
  clientId: "CID",
  clientSecret: "SEC",
  refreshToken: "RT",
  username: "lilgeckos",
  subreddit: "u_lilgeckos",
};

/** Mock fetch that handles token + submit + /me. */
function okFetch(submitData: { id: string; url: string } = { id: "abc123", url: "https://www.reddit.com/r/sub/comments/abc123/x/" }): RedditFetchLike {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes("/api/v1/access_token")) return { access_token: "AT", refresh_token: "RT", expires_in: 3600 };
      if (url.endsWith("/api/v1/me")) return { name: "lilgeckos" };
      if (url.includes("/api/submit")) return { json: { errors: [], data: submitData } };
      return {};
    },
  })) as unknown as RedditFetchLike;
}

function adapter(f: RedditFetchLike) {
  return new RedditPublisher(creds, { fetchImpl: f });
}

describe("RedditPublisher.publish", () => {
  it("text-only -> kind=self with title + selftext + subreddit", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ title: "Hello", text: "Body line." });
    expect(res).toMatchObject({ ok: true, postId: "abc123" });
    expect(res.url).toBe("https://www.reddit.com/r/sub/comments/abc123/x/");
    const calls = (f as unknown as { mock: { calls: [string, { body?: URLSearchParams; headers?: Record<string, string> }][] } }).mock.calls;
    // token exchange happened
    expect(calls[0]![0]).toBe("https://www.reddit.com/api/v1/access_token");
    // submit POST
    const submitCall = calls.find((c) => c[0].includes("/api/submit"))!;
    expect(submitCall[1].body!.get("kind")).toBe("self");
    expect(submitCall[1].body!.get("title")).toBe("Hello");
    expect(submitCall[1].body!.get("text")).toBe("Body line.");
    expect(submitCall[1].body!.get("sr")).toBe("u_lilgeckos");
    expect(submitCall[1].headers!.Authorization).toBe("bearer AT");
    expect(submitCall[1].headers!["User-Agent"]).toContain("lilgeckos-hub/");
  });

  it("post.link -> kind=link with url", async () => {
    const f = okFetch();
    await adapter(f).publish({ title: "Linky", text: "see this", link: "https://lilgeckos.com/blog/x" });
    const calls = (f as unknown as { mock: { calls: [string, { body?: URLSearchParams }][] } }).mock.calls;
    const submitCall = calls.find((c) => c[0].includes("/api/submit"))!;
    expect(submitCall[1].body!.get("kind")).toBe("link");
    expect(submitCall[1].body!.get("url")).toBe("https://lilgeckos.com/blog/x");
  });

  it("media post uses ctx.youtube.url over everything else", async () => {
    const f = okFetch();
    await adapter(f).publish(
      { title: "Reel", text: "watch", media: [{ path: "/tmp/x.mp4", kind: "video" }] },
      { youtube: { videoId: "abc", url: "https://youtu.be/abc" }, blog: { postId: "p", url: "https://lilgeckos.com/blog/p" } },
    );
    const calls = (f as unknown as { mock: { calls: [string, { body?: URLSearchParams }][] } }).mock.calls;
    const submitCall = calls.find((c) => c[0].includes("/api/submit"))!;
    expect(submitCall[1].body!.get("url")).toBe("https://youtu.be/abc");
  });

  it("media post falls back to ctx.blog.url when no youtube/link", async () => {
    const f = okFetch();
    await adapter(f).publish(
      { title: "Photo", text: "look", media: [{ path: "/tmp/x.jpg", kind: "image" }] },
      { blog: { postId: "p", url: "https://lilgeckos.com/blog/p" } },
    );
    const calls = (f as unknown as { mock: { calls: [string, { body?: URLSearchParams }][] } }).mock.calls;
    const submitCall = calls.find((c) => c[0].includes("/api/submit"))!;
    expect(submitCall[1].body!.get("url")).toBe("https://lilgeckos.com/blog/p");
  });

  it("media post without any link source -> validation error (no API call beyond token)", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ title: "Photo", text: "x", media: [{ path: "/tmp/x.jpg", kind: "image" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    const calls = (f as unknown as { mock: { calls: [string, unknown][] } }).mock.calls;
    // no submit call
    expect(calls.find((c) => c[0].includes("/api/submit"))).toBeUndefined();
  });

  it("maps a RATELIMIT envelope error to rate_limit", async () => {
    const f = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url.includes("/api/v1/access_token")) return { access_token: "AT", expires_in: 3600 };
        if (url.includes("/api/submit"))
          return { json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]], data: {} } };
        return {};
      },
    })) as unknown as RedditFetchLike;
    const res = await new RedditPublisher(creds, { fetchImpl: f }).publish({ title: "t", text: "b" });
    expect(res).toMatchObject({ ok: false, errorCode: "rate_limit" });
  });

  it("maps a 401 from /api/submit to auth", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/api/v1/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "AT", expires_in: 3600 }) };
      return { ok: false, status: 401, json: async () => ({ message: "Unauthorized" }) };
    }) as unknown as RedditFetchLike;
    const res = await new RedditPublisher(creds, { fetchImpl: f }).publish({ title: "t", text: "b" });
    expect(res).toMatchObject({ ok: false, errorCode: "auth" });
  });

  it("derives title from first non-empty text line when post.title is missing", async () => {
    expect(splitTitleBody({ text: "First line\n\nbody" })).toEqual({ title: "First line", body: "body" });
  });
});

describe("RedditPublisher.checkStatus", () => {
  it("healthy with username + subreddit", async () => {
    const res = await adapter(okFetch()).checkStatus();
    expect(res).toMatchObject({ credentialsPresent: true, healthy: true });
    expect(res.detail).toBe("/u/lilgeckos → u_lilgeckos");
  });
});

describe("mapError", () => {
  it("classifies codes/statuses", () => {
    expect(mapError({ code: "RATELIMIT" }).errorCode).toBe("rate_limit");
    expect(mapError({ httpStatus: 429 }).errorCode).toBe("rate_limit");
    expect(mapError({ httpStatus: 401 }).errorCode).toBe("auth");
    expect(mapError({ httpStatus: 400 }).errorCode).toBe("validation");
    expect(mapError(new Error("fetch failed")).errorCode).toBe("network");
  });
});
