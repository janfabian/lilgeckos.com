import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FacebookPublisher, mapFbError, type FetchLike } from "../facebook.js";
import type { FacebookCredentials } from "../../config/env.js";

const creds: FacebookCredentials = {
  pageId: "PAGE",
  pageAccessToken: "TOK",
  graphVersion: "v21.0",
};

const imgA = join(tmpdir(), `hub-fb-a-${process.pid}.jpg`);
const imgB = join(tmpdir(), `hub-fb-b-${process.pid}.jpg`);
const vidA = join(tmpdir(), `hub-fb-v-${process.pid}.mp4`);
beforeAll(() => {
  writeFileSync(imgA, Buffer.alloc(64));
  writeFileSync(imgB, Buffer.alloc(64));
  writeFileSync(vidA, Buffer.alloc(2048));
});
afterAll(() => {
  [imgA, imgB, vidA].forEach((f) => rmSync(f, { force: true }));
});

function okFetch(): FetchLike {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes("rupload.facebook.com")) return { success: true };
      if (url.includes("/video_reels"))
        return { video_id: "reel123", upload_url: "https://rupload.facebook.com/video-upload/v21.0/reel123" };
      if (url.includes("fields=permalink_url"))
        return { permalink_url: "https://www.facebook.com/PAGE_ACTOR/posts/POST" };
      if (url.includes("/videos")) return { id: "vid_post" };
      if (url.includes("/photos")) return { id: "photo_fbid", post_id: "photo_post" };
      if (url.includes("/feed")) return { id: "feed_post" };
      return { name: "Lil Geckos" };
    },
  })) as unknown as FetchLike;
}

function adapter(fetchImpl: FetchLike) {
  return new FacebookPublisher(creds, { fetchImpl, mediaMaxBytes: 1_000_000, videoMaxBytes: 5_000_000 });
}

describe("FacebookPublisher.publish", () => {
  it("text-only -> /feed, returns the API's permalink_url (not the legacy composite URL)", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "hello page" });
    expect(res).toMatchObject({ ok: true, platform: "facebook", postId: "feed_post" });
    expect(res.url).toBe("https://www.facebook.com/PAGE_ACTOR/posts/POST");
    const calls = (f as unknown as { mock: { calls: [string, { method: string; body?: URLSearchParams }][] } }).mock.calls;
    const feedCall = calls.find((c) => c[0].includes("/v21.0/PAGE/feed"))!;
    expect(feedCall[1].method).toBe("POST");
    expect(feedCall[1].body!.get("message")).toBe("hello page");
    expect(feedCall[1].body!.get("access_token")).toBe("TOK");
    // and the follow-up permalink fetch happened
    expect(calls.some((c) => c[0].includes("fields=permalink_url"))).toBe(true);
  });

  it("link -> /feed with link param", async () => {
    const f = okFetch();
    await adapter(f).publish({ text: "see this", link: "https://lilgeckos.com" });
    const init = (f as unknown as { mock: { calls: [string, { body: URLSearchParams }][] } }).mock.calls[0]![1];
    expect(init.body.get("link")).toBe("https://lilgeckos.com");
  });

  it("single image -> /photos", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "pic", media: [{ path: imgA, kind: "image" }] });
    expect(res).toMatchObject({ ok: true, postId: "photo_post" });
    const url = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0];
    expect(url).toContain("/PAGE/photos");
  });

  it("multiple images -> two unpublished /photos then /feed with attached_media", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({
      text: "album",
      media: [
        { path: imgA, kind: "image" },
        { path: imgB, kind: "image" },
      ],
    });
    expect(res).toMatchObject({ ok: true, postId: "feed_post" });
    const calls = (f as unknown as { mock: { calls: [string, { body?: URLSearchParams }][] } }).mock.calls;
    // 2 photo uploads + 1 feed post + 1 permalink fetch
    expect(calls.length).toBe(4);
    expect(calls[0]![0]).toContain("/photos");
    expect(calls[1]![0]).toContain("/photos");
    expect(calls[2]![0]).toContain("/feed");
    expect(calls[2]![1].body!.get("attached_media[0]")).toContain("photo_fbid");
    expect(calls[3]![0]).toContain("fields=permalink_url");
  });

  it("video (reels on, default) -> 3-phase /video_reels upload", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "clip", media: [{ path: vidA, kind: "video" }] });
    expect(res).toMatchObject({ ok: true, postId: "reel123" });
    expect(res.url).toBe("https://www.facebook.com/reel/reel123");
    const calls = (f as unknown as { mock: { calls: [string, { method: string; body?: URLSearchParams; headers?: Record<string, string> }][] } }).mock.calls;
    // start -> upload -> finish
    expect(calls[0]![0]).toContain("/PAGE/video_reels");
    expect(calls[0]![1].body!.get("upload_phase")).toBe("start");
    expect(calls[1]![0]).toContain("rupload.facebook.com");
    expect(calls[1]![1].headers!.Authorization).toBe("OAuth TOK");
    expect(calls[1]![1].headers!.file_size).toBe("2048");
    expect(calls[2]![0]).toContain("/PAGE/video_reels");
    expect(calls[2]![1].body!.get("upload_phase")).toBe("finish");
    expect(calls[2]![1].body!.get("video_id")).toBe("reel123");
  });

  it("video with reels disabled -> /videos", async () => {
    const f = okFetch();
    const res = await new FacebookPublisher(creds, {
      fetchImpl: f,
      reels: false,
      videoMaxBytes: 5_000_000,
    }).publish({ text: "clip", media: [{ path: vidA, kind: "video" }] });
    expect(res).toMatchObject({ ok: true, postId: "vid_post" });
    const url = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0];
    expect(url).toContain("/PAGE/videos");
  });

  it("rejects video + image mixing without any network call", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({
      text: "x",
      media: [
        { path: vidA, kind: "video" },
        { path: imgA, kind: "image" },
      ],
    });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a missing media file (no network call)", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "x", media: [{ path: "/nope/x.jpg", kind: "image" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(f).not.toHaveBeenCalled();
  });

  it("maps a Graph 190 OAuth error to auth", async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid OAuth access token", code: 190 } }),
    })) as unknown as FetchLike;
    const res = await adapter(f).publish({ text: "hi" });
    expect(res).toMatchObject({ ok: false, errorCode: "auth" });
  });
});

describe("FacebookPublisher misleading-error recovery", () => {
  it("recovers from 'reduce the amount of data' by finding the matching recent post", async () => {
    const matching = {
      id: "1199764649879474_999",
      permalink_url: "https://www.facebook.com/ACTOR/posts/999",
      message: "Just a routine skin refresh. Nothing to see here.\n\nMid-shed",
    };
    const f = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (url.includes("/PAGE/photos") && method === "POST")
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 },
          }),
        };
      if (url.includes("/PAGE/posts?fields="))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: matching.id,
                message: matching.message,
                created_time: new Date().toISOString(),
                permalink_url: matching.permalink_url,
              },
            ],
          }),
        };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as FetchLike;
    const res = await new FacebookPublisher(creds, {
      fetchImpl: f,
      mediaMaxBytes: 1_000_000,
      videoMaxBytes: 5_000_000,
    }).publish({
      text: "Just a routine skin refresh. Nothing to see here.\n\nMid-shed and pretending it's just spa day.",
      media: [{ path: imgA, kind: "image" }],
    });
    expect(res).toMatchObject({ ok: true, postId: "1199764649879474_999" });
    expect(res.url).toBe("https://www.facebook.com/ACTOR/posts/999");
  });

  it("still reports failure when 'reduce' fires but no matching post is found", async () => {
    const f = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (url.includes("/PAGE/photos") && method === "POST")
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 },
          }),
        };
      if (url.includes("/PAGE/posts?fields="))
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as FetchLike;
    const res = await new FacebookPublisher(creds, {
      fetchImpl: f,
      mediaMaxBytes: 1_000_000,
      videoMaxBytes: 5_000_000,
    }).publish({ text: "nothing will match", media: [{ path: imgA, kind: "image" }] });
    expect(res.ok).toBe(false);
  });

  it("ignores a recent post older than the 90s window", async () => {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    const f = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (url.includes("/PAGE/photos") && method === "POST")
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: { message: "Please reduce the amount of data you're asking for", code: 1 },
          }),
        };
      if (url.includes("/PAGE/posts?fields="))
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "x", message: "Just a routine", created_time: stale, permalink_url: "u" }] }),
        };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as FetchLike;
    const res = await new FacebookPublisher(creds, {
      fetchImpl: f,
      mediaMaxBytes: 1_000_000,
      videoMaxBytes: 5_000_000,
    }).publish({ text: "Just a routine skin refresh", media: [{ path: imgA, kind: "image" }] });
    expect(res.ok).toBe(false);
  });
});

describe("FacebookPublisher.checkStatus", () => {
  it("healthy with page name", async () => {
    const res = await adapter(okFetch()).checkStatus();
    expect(res).toMatchObject({ credentialsPresent: true, healthy: true, detail: "Lil Geckos" });
  });
});

describe("mapFbError", () => {
  it("classifies codes", () => {
    expect(mapFbError({ code: 190 }).errorCode).toBe("auth");
    expect(mapFbError({ code: 4 }).errorCode).toBe("rate_limit");
    expect(mapFbError({ httpStatus: 400 }).errorCode).toBe("validation");
    expect(mapFbError(new Error("fetch failed")).errorCode).toBe("network");
  });
});
