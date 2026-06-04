import { describe, it, expect } from "vitest";
import { publishToTargets, summarize } from "../orchestrator.js";
import { MockPublisher } from "../../adapters/mock.js";
import type { Publisher } from "../publisher.js";
import type { PlatformId, Post, PublishResult, PublishContext, PlatformStatus } from "../types.js";

const post: Post = { text: "hello" };

function registry(entries: [PlatformId, Publisher][]): Map<PlatformId, Publisher> {
  return new Map(entries);
}

/** Records the ctx it was handed, for asserting cross-platform threading. */
class RecordingPublisher implements Publisher {
  receivedCtx?: PublishContext;
  publishedAt = 0;
  constructor(
    readonly platform: PlatformId,
    private readonly result: Partial<PublishResult> = {},
  ) {}
  async publish(_post: Post, ctx?: PublishContext): Promise<PublishResult> {
    this.receivedCtx = ctx;
    this.publishedAt = performance.now();
    return { platform: this.platform, ok: true, durationMs: 1, ...this.result };
  }
  async checkStatus(): Promise<PlatformStatus> {
    return { platform: this.platform, enabled: true, credentialsPresent: true };
  }
}

describe("publishToTargets", () => {
  it("runs all targets and preserves order", async () => {
    const reg = registry([
      ["mock", new MockPublisher()],
      ["twitter", new MockPublisher({ platform: "twitter" })],
    ]);
    const results = await publishToTargets(post, ["mock", "twitter"], reg);
    expect(results.map((r) => r.platform)).toEqual(["mock", "twitter"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("isolates a failing target from a succeeding one", async () => {
    const reg = registry([
      ["mock", new MockPublisher({ failWith: "rate_limit" })],
      ["twitter", new MockPublisher({ platform: "twitter" })],
    ]);
    const results = await publishToTargets(post, ["mock", "twitter"], reg);
    expect(results[0]).toMatchObject({ platform: "mock", ok: false, errorCode: "rate_limit" });
    expect(results[1]).toMatchObject({ platform: "twitter", ok: true });
  });

  it("returns a synthetic validation failure for an unregistered target", async () => {
    const reg = registry([["mock", new MockPublisher()]]);
    const results = await publishToTargets(post, ["facebook"], reg);
    expect(results[0]).toMatchObject({
      platform: "facebook",
      ok: false,
      errorCode: "validation",
      error: "platform not enabled",
    });
  });

  it("publishes YouTube first and threads its video id into the blog's ctx", async () => {
    const yt = new RecordingPublisher("youtube", {
      postId: "vidXYZ",
      url: "https://www.youtube.com/shorts/vidXYZ",
    });
    const blog = new RecordingPublisher("blog");
    const reg = registry([
      ["blog", blog],
      ["youtube", yt],
    ]);
    const results = await publishToTargets(post, ["blog", "youtube"], reg);
    // listed order preserved even though youtube runs first
    expect(results.map((r) => r.platform)).toEqual(["blog", "youtube"]);
    expect(yt.publishedAt).toBeLessThanOrEqual(blog.publishedAt);
    expect(blog.receivedCtx?.youtube).toEqual({
      videoId: "vidXYZ",
      url: "https://www.youtube.com/shorts/vidXYZ",
    });
  });

  it("leaves the blog ctx empty when YouTube fails (self-host fallback)", async () => {
    const yt = new RecordingPublisher("youtube", { ok: false, errorCode: "auth" });
    const blog = new RecordingPublisher("blog");
    const reg = registry([
      ["youtube", yt],
      ["blog", blog],
    ]);
    await publishToTargets(post, ["youtube", "blog"], reg);
    expect(blog.receivedCtx?.youtube).toBeUndefined();
  });

  it("runs blog before the rest and threads its url to downstream platforms (e.g. reddit)", async () => {
    const blog = new RecordingPublisher("blog", { postId: "2026-06-04-x", url: "https://lilgeckos.com/blog/2026-06-04-x" });
    const reddit = new RecordingPublisher("reddit");
    const twitter = new RecordingPublisher("twitter");
    const reg = registry([
      ["twitter", twitter],
      ["reddit", reddit],
      ["blog", blog],
    ]);
    const results = await publishToTargets(post, ["twitter", "reddit", "blog"], reg);
    // order preserved
    expect(results.map((r) => r.platform)).toEqual(["twitter", "reddit", "blog"]);
    // blog ran first (before reddit + twitter)
    expect(blog.publishedAt).toBeLessThanOrEqual(reddit.publishedAt);
    expect(blog.publishedAt).toBeLessThanOrEqual(twitter.publishedAt);
    // downstream platforms received ctx.blog
    expect(reddit.receivedCtx?.blog).toEqual({
      postId: "2026-06-04-x",
      url: "https://lilgeckos.com/blog/2026-06-04-x",
    });
    expect(twitter.receivedCtx?.blog).toEqual({
      postId: "2026-06-04-x",
      url: "https://lilgeckos.com/blog/2026-06-04-x",
    });
  });
});

describe("summarize", () => {
  it("counts succeeded/failed and flags partial", () => {
    expect(summarize([])).toEqual({ total: 0, succeeded: 0, failed: 0, partial: false });
    expect(
      summarize([
        { platform: "mock", ok: true, durationMs: 1 },
        { platform: "twitter", ok: false, durationMs: 1 },
      ]),
    ).toEqual({ total: 2, succeeded: 1, failed: 1, partial: true });
    expect(
      summarize([{ platform: "mock", ok: true, durationMs: 1 }]),
    ).toMatchObject({ partial: false, succeeded: 1, failed: 0 });
  });
});
