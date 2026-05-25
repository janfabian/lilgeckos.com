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
  it("text-only -> /feed", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "hello page" });
    expect(res).toMatchObject({ ok: true, platform: "facebook", postId: "feed_post" });
    const [url, init] = (f as unknown as { mock: { calls: [string, { method: string; body: URLSearchParams }][] } }).mock.calls[0]!;
    expect(url).toContain("/v21.0/PAGE/feed");
    expect(init.method).toBe("POST");
    expect(init.body.get("message")).toBe("hello page");
    expect(init.body.get("access_token")).toBe("TOK");
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
    const calls = (f as unknown as { mock: { calls: [string, { body: URLSearchParams }][] } }).mock.calls;
    expect(calls.length).toBe(3);
    expect(calls[0]![0]).toContain("/photos");
    expect(calls[1]![0]).toContain("/photos");
    expect(calls[2]![0]).toContain("/feed");
    expect(calls[2]![1].body.get("attached_media[0]")).toContain("photo_fbid");
  });

  it("video -> /videos", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "clip", media: [{ path: vidA, kind: "video" }] });
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
