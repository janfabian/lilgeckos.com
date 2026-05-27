import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstagramPublisher, type IgFetchLike } from "../instagram.js";
import type { MediaHost } from "../../core/media-host.js";
import type { InstagramCredentials } from "../../config/env.js";

const creds: InstagramCredentials = { igUserId: "IG", accessToken: "TOK", graphVersion: "v21.0" };

const imgA = join(tmpdir(), `hub-ig-a-${process.pid}.jpg`);
const imgB = join(tmpdir(), `hub-ig-b-${process.pid}.jpg`);
const vid = join(tmpdir(), `hub-ig-v-${process.pid}.mp4`);
beforeAll(() => {
  writeFileSync(imgA, Buffer.alloc(64));
  writeFileSync(imgB, Buffer.alloc(64));
  writeFileSync(vid, Buffer.alloc(2048));
});
afterAll(() => [imgA, imgB, vid].forEach((f) => rmSync(f, { force: true })));

const host: MediaHost = { hostAll: vi.fn(async (paths: string[]) => paths.map((_, i) => `https://raw.example/${i}.bin`)) };

function okFetch(status = "FINISHED"): IgFetchLike {
  let n = 0;
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes("/media_publish")) return { id: "pub_999" };
      if (url.includes("fields=status_code")) return { status_code: status };
      if (url.includes("fields=permalink")) return { permalink: "https://www.instagram.com/p/ABC/" };
      if (url.includes("fields=username")) return { username: "lilgeckos" };
      if (url.includes("/media")) return { id: `cont_${++n}` }; // container create
      return {};
    },
  })) as unknown as IgFetchLike;
}

function adapter(fetchImpl: IgFetchLike, withHost = true) {
  return new InstagramPublisher(creds, {
    fetchImpl,
    mediaHost: withHost ? host : undefined,
    videoMaxBytes: 5_000_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
}

describe("InstagramPublisher.publish", () => {
  it("single image -> container + publish, returns permalink", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "a gecko", media: [{ path: imgA, kind: "image" }] });
    expect(res).toMatchObject({ ok: true, platform: "instagram", postId: "pub_999" });
    expect(res.url).toBe("https://www.instagram.com/p/ABC/");
    const calls = (f as unknown as { mock: { calls: [string, { method: string; body?: URLSearchParams }][] } }).mock.calls;
    const create = calls.find((c) => c[1].method === "POST" && c[0].endsWith("/IG/media"))![1];
    expect(create.body!.get("image_url")).toBe("https://raw.example/0.bin");
    expect(create.body!.get("caption")).toBe("a gecko");
    expect(calls.some((c) => c[0].includes("/IG/media_publish"))).toBe(true);
  });

  it("single video -> REELS container, polls, publishes", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "clip", media: [{ path: vid, kind: "video" }] });
    expect(res).toMatchObject({ ok: true, postId: "pub_999" });
    const calls = (f as unknown as { mock: { calls: [string, { method: string; body?: URLSearchParams }][] } }).mock.calls;
    const create = calls.find((c) => c[1].method === "POST" && c[0].endsWith("/IG/media"))![1];
    expect(create.body!.get("media_type")).toBe("REELS");
    expect(create.body!.get("video_url")).toBe("https://raw.example/0.bin");
    expect(calls.some((c) => c[0].includes("fields=status_code"))).toBe(true); // polled
  });

  it("multiple images -> carousel children + CAROUSEL parent", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({
      text: "album",
      media: [
        { path: imgA, kind: "image" },
        { path: imgB, kind: "image" },
      ],
    });
    expect(res.ok).toBe(true);
    const calls = (f as unknown as { mock: { calls: [string, { method: string; body?: URLSearchParams }][] } }).mock.calls;
    const creates = calls.filter((c) => c[1].method === "POST" && c[0].endsWith("/IG/media"));
    expect(creates.length).toBe(3); // 2 children + 1 parent
    expect(creates[0]![1].body!.get("is_carousel_item")).toBe("true");
    const parent = creates[2]![1].body!;
    expect(parent.get("media_type")).toBe("CAROUSEL");
    expect(parent.get("children")).toBe("cont_1,cont_2");
  });

  it("rejects a text-only post (no media) without any network call", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({ text: "hi" });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects video + image mixing", async () => {
    const f = okFetch();
    const res = await adapter(f).publish({
      text: "x",
      media: [
        { path: vid, kind: "video" },
        { path: imgA, kind: "image" },
      ],
    });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects when no media host is configured", async () => {
    const f = okFetch();
    const res = await adapter(f, false).publish({ text: "x", media: [{ path: imgA, kind: "image" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(res.error).toContain("media host");
    expect(f).not.toHaveBeenCalled();
  });

  it("fails when media processing returns ERROR", async () => {
    const f = okFetch("ERROR");
    const res = await adapter(f).publish({ text: "clip", media: [{ path: vid, kind: "video" }] });
    expect(res.ok).toBe(false);
  });

  it("maps a Graph 190 OAuth error to auth", async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid OAuth access token", code: 190 } }),
    })) as unknown as IgFetchLike;
    const res = await adapter(f).publish({ text: "x", media: [{ path: imgA, kind: "image" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "auth" });
  });
});

describe("InstagramPublisher.checkStatus", () => {
  it("healthy with @username", async () => {
    const res = await adapter(okFetch()).checkStatus();
    expect(res).toMatchObject({ credentialsPresent: true, healthy: true, detail: "@lilgeckos" });
  });
});
