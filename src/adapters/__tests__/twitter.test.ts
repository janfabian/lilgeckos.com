import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TwitterPublisher, mapError, type TwitterClientLike } from "../twitter.js";
import type { TwitterCredentials } from "../../config/env.js";

const creds: TwitterCredentials = {
  appKey: "k",
  appSecret: "s",
  accessToken: "t",
  accessSecret: "ts",
};

const imgA = join(tmpdir(), `hub-tw-a-${process.pid}.jpg`);
const imgB = join(tmpdir(), `hub-tw-b-${process.pid}.jpg`);
beforeAll(() => {
  writeFileSync(imgA, Buffer.alloc(64));
  writeFileSync(imgB, Buffer.alloc(64));
});
afterAll(() => {
  rmSync(imgA, { force: true });
  rmSync(imgB, { force: true });
});

function mockClient(over: Partial<TwitterClientLike["v2"]> = {}): TwitterClientLike {
  return {
    v2: {
      tweet: vi.fn(async () => ({ data: { id: "1850000000000000000" } })),
      uploadMedia: vi.fn(async () => "media-123"),
      me: vi.fn(async () => ({ data: { id: "9", username: "lilgeckos" } })),
      ...over,
    },
  };
}

function adapter(client: TwitterClientLike) {
  return new TwitterPublisher(creds, { client, mediaMaxBytes: 1_000_000 });
}

describe("TwitterPublisher.publish", () => {
  it("text-only: tweets with no media", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ text: "hello world" });
    expect(res.ok).toBe(true);
    expect(res.postId).toBe("1850000000000000000");
    expect(res.url).toContain("1850000000000000000");
    expect(client.v2.tweet).toHaveBeenCalledWith({ text: "hello world" });
    expect(client.v2.uploadMedia).not.toHaveBeenCalled();
  });

  it("text+image: uploads each image and attaches media_ids", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      text: "pics",
      media: [
        { path: imgA, kind: "image" },
        { path: imgB, kind: "image" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(client.v2.uploadMedia).toHaveBeenCalledTimes(2);
    expect(client.v2.tweet).toHaveBeenCalledWith({
      text: "pics",
      media: { media_ids: ["media-123", "media-123"] },
    });
  });

  it("link: appends the URL into the tweet text", async () => {
    const client = mockClient();
    await adapter(client).publish({ text: "see this", link: "https://x.com/foo" });
    expect(client.v2.tweet).toHaveBeenCalledWith({ text: "see this https://x.com/foo" });
  });

  it("rejects >4 images as validation without calling the SDK", async () => {
    const client = mockClient();
    const media = [imgA, imgB, imgA, imgB, imgA].map((path) => ({ path, kind: "image" as const }));
    const res = await adapter(client).publish({ text: "too many", media });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(client.v2.tweet).not.toHaveBeenCalled();
    expect(client.v2.uploadMedia).not.toHaveBeenCalled();
  });

  it("rejects video as unsupported without calling the SDK", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      text: "clip",
      media: [{ path: imgA, kind: "video" }],
    });
    expect(res).toMatchObject({ ok: false, errorCode: "unsupported" });
    expect(client.v2.uploadMedia).not.toHaveBeenCalled();
  });

  it("rejects a missing media file as validation", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      text: "x",
      media: [{ path: "/nope/missing.jpg", kind: "image" }],
    });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(client.v2.uploadMedia).not.toHaveBeenCalled();
  });

  it("maps a 401 to auth and does not throw", async () => {
    const client = mockClient({
      tweet: vi.fn(async () => {
        throw Object.assign(new Error("Unauthorized"), { code: 401 });
      }),
    });
    const res = await adapter(client).publish({ text: "hi" });
    expect(res).toMatchObject({ ok: false, errorCode: "auth" });
  });

  it("maps a 429 to rate_limit", async () => {
    const client = mockClient({
      tweet: vi.fn(async () => {
        throw Object.assign(new Error("Too Many Requests"), { code: 429 });
      }),
    });
    const res = await adapter(client).publish({ text: "hi" });
    expect(res).toMatchObject({ ok: false, errorCode: "rate_limit" });
  });
});

describe("TwitterPublisher.checkStatus", () => {
  it("healthy when me() succeeds", async () => {
    const res = await adapter(mockClient()).checkStatus();
    expect(res).toMatchObject({ credentialsPresent: true, healthy: true, detail: "@lilgeckos" });
  });

  it("healthy=undefined when reads are restricted (does not fail)", async () => {
    const client = mockClient({
      me: vi.fn(async () => {
        throw Object.assign(new Error("Forbidden"), { code: 403 });
      }),
    });
    const res = await adapter(client).checkStatus();
    expect(res.credentialsPresent).toBe(true);
    expect(res.healthy).toBeUndefined();
  });
});

describe("mapError", () => {
  it("classifies common cases", () => {
    expect(mapError({ code: 403 }).errorCode).toBe("auth");
    expect(mapError({ rateLimitError: true }).errorCode).toBe("rate_limit");
    expect(mapError({ code: 400 }).errorCode).toBe("validation");
    expect(mapError(new Error("fetch failed")).errorCode).toBe("network");
    expect(mapError("weird").errorCode).toBe("unknown");
  });
});
