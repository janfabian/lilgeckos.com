import { describe, it, expect, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../server.js";

// Keep the route's post-logging out of the real data/published.jsonl —
// without this, every test run appends mock records to the live stats log.
beforeAll(() => {
  process.env.POST_LOG_PATH = join(tmpdir(), `publish-test-log-${process.pid}.jsonl`);
});
import { MockPublisher } from "../../adapters/mock.js";
import type { Publisher } from "../../core/publisher.js";
import type { PlatformId } from "../../core/types.js";
import type { AppConfig } from "../../config/env.js";

const config: AppConfig = {
  port: 8137,
  logLevel: "silent",
  hubToken: "secret",
  mockEnabled: true,
  mediaMaxBytes: 1_000_000,
  videoMaxBytes: 512_000_000,
};

function app(registry: Map<PlatformId, Publisher>) {
  return buildServer(config, registry);
}

interface PublishBody {
  results: Array<{ platform: string; ok: boolean; errorCode?: string }>;
  summary: { total: number; succeeded: number; failed: number; partial: boolean };
}

const mockReg = (): Map<PlatformId, Publisher> => new Map([["mock", new MockPublisher()]]);

function post(body: unknown, token?: string) {
  return new Request("http://localhost/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /publish auth", () => {
  it("401 without a token", async () => {
    const res = await app(mockReg()).request(post({ post: { text: "hi" } }));
    expect(res.status).toBe(401);
  });
  it("401 with the wrong token", async () => {
    const res = await app(mockReg()).request(post({ post: { text: "hi" } }, "nope"));
    expect(res.status).toBe(401);
  });
});

describe("POST /publish behavior", () => {
  it("400 on malformed body", async () => {
    const res = await app(mockReg()).request(post({ nope: true }, "secret"));
    expect(res.status).toBe(400);
  });

  it("400 when post has no text, media, or link", async () => {
    const res = await app(mockReg()).request(post({ post: { text: "  " } }, "secret"));
    expect(res.status).toBe(400);
  });

  it("200 + results for a valid post (targets: mock)", async () => {
    const res = await app(mockReg()).request(
      post({ post: { text: "hello" }, targets: ["mock"] }, "secret"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0, partial: false });
    expect(body.results[0]).toMatchObject({ platform: "mock", ok: true });
  });

  it("fans out to all enabled platforms when targets omitted", async () => {
    const res = await app(mockReg()).request(post({ post: { text: "hello" } }, "secret"));
    const body = (await res.json()) as PublishBody;
    expect(body.results.map((r: { platform: string }) => r.platform)).toEqual(["mock"]);
  });

  it("returns a synthetic failure row for a not-enabled target", async () => {
    const res = await app(mockReg()).request(
      post({ post: { text: "hi" }, targets: ["facebook"] }, "secret"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.results[0]).toMatchObject({
      platform: "facebook",
      ok: false,
      errorCode: "validation",
    });
  });

  it("422 when no platforms are enabled", async () => {
    const res = await app(new Map()).request(post({ post: { text: "hi" } }, "secret"));
    expect(res.status).toBe(422);
  });

  it("E2E: text+image post succeeds via the mock adapter", async () => {
    const res = await app(mockReg()).request(
      post(
        { post: { text: "pic", media: [{ path: "/tmp/whatever.jpg", kind: "image" }] }, targets: ["mock"] },
        "secret",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublishBody;
    expect(body.results[0]).toMatchObject({ ok: true });
  });
});
