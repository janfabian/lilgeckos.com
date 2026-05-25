import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateMedia } from "../media.js";
import type { MediaItem } from "../types.js";

const file = join(tmpdir(), `hub-media-test-${process.pid}.jpg`);

beforeAll(() => writeFileSync(file, Buffer.alloc(1024)));
afterAll(() => rmSync(file, { force: true }));

const img = (path: string): MediaItem => ({ path, kind: "image" });

describe("validateMedia", () => {
  it("rejects a non-absolute path", () => {
    expect(validateMedia(img("relative/x.jpg"), 1_000_000)).toMatchObject({ ok: false });
  });

  it("rejects an empty path", () => {
    expect(validateMedia(img(""), 1_000_000)).toMatchObject({ ok: false });
  });

  it("rejects a missing file", () => {
    expect(validateMedia(img("/nope/does-not-exist.jpg"), 1_000_000)).toMatchObject({
      ok: false,
    });
  });

  it("rejects an oversize file", () => {
    const r = validateMedia(img(file), 100); // file is 1024 bytes > 100
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/);
  });

  it("accepts a valid file within the limit", () => {
    expect(validateMedia(img(file), 1_000_000)).toEqual({ ok: true });
  });
});
