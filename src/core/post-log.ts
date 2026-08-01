// Append-only log of successfully published posts, so `bun run stats` can look
// up each platform's post id later and fetch its current metrics. The hub is
// otherwise stateless; this is the one bit of durable state it keeps.
//
// Format: JSONL (one PostRecord per line) at data/published.jsonl (override with
// POST_LOG_PATH). Writing is best-effort and must never break a publish.
import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { PlatformId, PublishResult } from "./types.js";

export interface PostRecord {
  /** ISO-8601 time the post was published. */
  ts: string;
  platform: PlatformId;
  /** Platform-native id (tweet id, YT video id, IG media id, FB post/video id, blog slug). */
  postId: string;
  url?: string;
  /** Human label so the stats report is readable without hitting each API. */
  title?: string;
}

const DEFAULT_LOG = "data/published.jsonl";

export function logPath(): string {
  const p = process.env.POST_LOG_PATH?.trim();
  return p && p.length > 0 ? p : DEFAULT_LOG;
}

/** Append records as JSONL, creating the parent dir if needed. No-op on []. */
export function appendRecords(records: PostRecord[], path: string = logPath()): void {
  if (records.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** Read all records; silently skips blank/corrupt lines so a bad append can't brick stats. */
export function readRecords(path: string = logPath()): PostRecord[] {
  if (!existsSync(path)) return [];
  const out: PostRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as PostRecord);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Build log records from a fan-out's results — only successful ones with a post id. */
export function recordsFromResults(
  results: PublishResult[],
  meta: { title?: string; ts: string },
): PostRecord[] {
  return results
    .filter((r) => r.ok && r.postId)
    .map((r) => ({
      ts: meta.ts,
      platform: r.platform,
      postId: r.postId as string,
      ...(r.url ? { url: r.url } : {}),
      ...(meta.title ? { title: meta.title } : {}),
    }));
}
