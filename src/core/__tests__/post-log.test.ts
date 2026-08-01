import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { appendRecords, readRecords, recordsFromResults, type PostRecord } from "../post-log.js";
import type { PublishResult } from "../types.js";

function tmpFile(): string {
  return join(tmpdir(), `plog-${process.pid}-${Date.now()}.jsonl`);
}

describe("post-log", () => {
  it("append + read roundtrip preserves records", () => {
    const p = tmpFile();
    const recs: PostRecord[] = [
      { ts: "2026-08-01T00:00:00Z", platform: "youtube", postId: "abc", url: "u", title: "t" },
      { ts: "2026-08-01T00:00:00Z", platform: "twitter", postId: "123" },
    ];
    appendRecords(recs, p);
    expect(readRecords(p)).toEqual(recs);
    rmSync(p, { force: true });
  });

  it("append is additive, not overwriting", () => {
    const p = tmpFile();
    appendRecords([{ ts: "t1", platform: "blog", postId: "a" }], p);
    appendRecords([{ ts: "t2", platform: "blog", postId: "b" }], p);
    expect(readRecords(p).map((r) => r.postId)).toEqual(["a", "b"]);
    rmSync(p, { force: true });
  });

  it("readRecords skips blank and corrupt lines", () => {
    const p = tmpFile();
    writeFileSync(p, '{"ts":"t","platform":"youtube","postId":"ok"}\n\nnot json\n', "utf8");
    const out = readRecords(p);
    expect(out).toHaveLength(1);
    expect(out[0]!.postId).toBe("ok");
    rmSync(p, { force: true });
  });

  it("readRecords returns [] for a missing file", () => {
    expect(readRecords(join(tmpdir(), `nope-${process.pid}.jsonl`))).toEqual([]);
  });

  it("recordsFromResults keeps only ok results with a postId", () => {
    const results: PublishResult[] = [
      { platform: "youtube", ok: true, postId: "yt1", url: "yu", durationMs: 1 },
      { platform: "twitter", ok: false, error: "boom", durationMs: 1 },
      { platform: "instagram", ok: true, durationMs: 1 }, // ok but no postId → skipped
    ];
    const recs = recordsFromResults(results, { title: "Hi", ts: "2026-08-01T00:00:00Z" });
    expect(recs).toEqual([
      { ts: "2026-08-01T00:00:00Z", platform: "youtube", postId: "yt1", url: "yu", title: "Hi" },
    ]);
  });
});
