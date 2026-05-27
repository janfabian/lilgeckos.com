import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { YouTubePublisher, composeMeta, mapError, type YouTubeClientLike } from "../youtube.js";
import type { YouTubeCredentials } from "../../config/env.js";

const creds: YouTubeCredentials = {
  clientId: "c",
  clientSecret: "s",
  refreshToken: "r",
  privacy: "public",
};

const vid = join(tmpdir(), `hub-yt-${process.pid}.mp4`);
const img = join(tmpdir(), `hub-yt-${process.pid}.jpg`);
beforeAll(() => {
  writeFileSync(vid, Buffer.alloc(4096));
  writeFileSync(img, Buffer.alloc(64));
});
afterAll(() => {
  rmSync(vid, { force: true });
  rmSync(img, { force: true });
});

function mockClient(over: Partial<YouTubeClientLike> = {}): YouTubeClientLike {
  return {
    insertVideo: vi.fn(async () => ({ id: "vid123" })),
    channelTitle: vi.fn(async () => "Lil Geckos"),
    ...over,
  };
}
function adapter(client: YouTubeClientLike) {
  return new YouTubePublisher(creds, { client, videoMaxBytes: 5_000_000 });
}

describe("YouTubePublisher.publish", () => {
  it("uploads a video and returns a Shorts URL", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ title: "Day 5", text: "day five", media: [{ path: vid, kind: "video" }] });
    expect(res).toMatchObject({ ok: true, platform: "youtube", postId: "vid123" });
    expect(res.url).toBe("https://www.youtube.com/shorts/vid123");
    const arg = (client.insertVideo as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.title).toBe("Day 5");
    expect(arg.privacyStatus).toBe("public");
    expect(arg.description).toContain("#Shorts");
    expect(arg.filePath).toBe(vid);
  });

  it("rejects a text-only post (no video) without calling the API", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ text: "hello" });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(client.insertVideo).not.toHaveBeenCalled();
  });

  it("rejects images-only", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ text: "x", media: [{ path: img, kind: "image" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(client.insertVideo).not.toHaveBeenCalled();
  });

  it("rejects more than one video", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      text: "x",
      media: [{ path: vid, kind: "video" }, { path: vid, kind: "video" }],
    });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(client.insertVideo).not.toHaveBeenCalled();
  });

  it("rejects a missing video file", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ text: "x", media: [{ path: "/nope/clip.mp4", kind: "video" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(client.insertVideo).not.toHaveBeenCalled();
  });

  it("maps a quota 403 to rate_limit", async () => {
    const client = mockClient({
      insertVideo: vi.fn(async () => {
        throw Object.assign(new Error("quota"), { code: 403, errors: [{ reason: "quotaExceeded" }] });
      }),
    });
    const res = await adapter(client).publish({ text: "x", media: [{ path: vid, kind: "video" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "rate_limit" });
  });

  it("maps a 401 to auth", async () => {
    const client = mockClient({
      insertVideo: vi.fn(async () => {
        throw Object.assign(new Error("bad creds"), { code: 401 });
      }),
    });
    const res = await adapter(client).publish({ text: "x", media: [{ path: vid, kind: "video" }] });
    expect(res).toMatchObject({ ok: false, errorCode: "auth" });
  });
});

describe("YouTubePublisher.checkStatus", () => {
  it("healthy with the channel title", async () => {
    const res = await adapter(mockClient()).checkStatus();
    expect(res).toMatchObject({ credentialsPresent: true, healthy: true, detail: "Lil Geckos" });
  });
  it("healthy=false on auth failure", async () => {
    const client = mockClient({
      channelTitle: vi.fn(async () => {
        throw Object.assign(new Error("nope"), { code: 401 });
      }),
    });
    const res = await adapter(client).checkStatus();
    expect(res.healthy).toBe(false);
  });
});

describe("composeMeta", () => {
  it("uses explicit title and appends #Shorts to the description", () => {
    const m = composeMeta({ title: "Title", text: "body" }, true);
    expect(m.title).toBe("Title");
    expect(m.description).toContain("body");
    expect(m.description).toContain("#Shorts");
  });
  it("derives the title from the first line of text", () => {
    const m = composeMeta({ text: "First line\nsecond" }, false);
    expect(m.title).toBe("First line");
    expect(m.description).not.toContain("#Shorts");
  });
  it("does not double-add #Shorts", () => {
    const m = composeMeta({ text: "already #shorts here" }, true);
    expect(m.description.match(/#shorts/gi)?.length).toBe(1);
  });
});

describe("mapError", () => {
  it("classifies statuses/reasons", () => {
    expect(mapError({ code: 401 }).errorCode).toBe("auth");
    expect(mapError({ code: 403, errors: [{ reason: "quotaExceeded" }] }).errorCode).toBe("rate_limit");
    expect(mapError({ code: 400 }).errorCode).toBe("validation");
    expect(mapError(new Error("fetch failed")).errorCode).toBe("network");
  });
});
