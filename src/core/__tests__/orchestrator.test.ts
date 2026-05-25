import { describe, it, expect } from "vitest";
import { publishToTargets, summarize } from "../orchestrator.js";
import { MockPublisher } from "../../adapters/mock.js";
import type { Publisher } from "../publisher.js";
import type { PlatformId, Post } from "../types.js";

const post: Post = { text: "hello" };

function registry(entries: [PlatformId, Publisher][]): Map<PlatformId, Publisher> {
  return new Map(entries);
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
