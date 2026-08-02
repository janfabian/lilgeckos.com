// Pure aggregation + text formatting for the stats report (no IO, unit-tested).
import type { PostRecord } from "../core/post-log.js";
import type { PlatformId } from "../core/types.js";
import type { MetricsByPostId, PostMetrics } from "./fetchers.js";

export interface StatRow {
  record: PostRecord;
  metrics: PostMetrics;
}

/**
 * Parse a --since spec into a cutoff epoch-ms (records at/after are kept).
 * Accepts "7d"/"12h", an ISO date/datetime, or undefined/"all" → no cutoff.
 * `nowMs` is injected so callers stay deterministic/testable.
 */
export function parseSince(spec: string | undefined, nowMs: number): number | undefined {
  if (!spec || spec.toLowerCase() === "all") return undefined;
  const rel = spec.match(/^(\d+)\s*([dh])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = rel[2]!.toLowerCase() === "d" ? 86_400_000 : 3_600_000;
    return nowMs - n * unitMs;
  }
  const t = Date.parse(spec);
  return Number.isNaN(t) ? undefined : t;
}

export function filterSince(records: PostRecord[], cutoffMs: number | undefined): PostRecord[] {
  if (cutoffMs === undefined) return records;
  return records.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isNaN(t) ? true : t >= cutoffMs;
  });
}

/** Platforms that expose no fetchable metrics — listed but not summed. */
export const NO_METRICS_PLATFORMS: ReadonlySet<PlatformId> = new Set(["blog", "reddit", "mock"]);

function fmt(n: number | undefined): string {
  return n === undefined ? "—" : n.toLocaleString("en-US");
}

function sum(rows: StatRow[], key: keyof PostMetrics): number | undefined {
  let total = 0;
  let any = false;
  for (const r of rows) {
    const v = r.metrics[key];
    if (typeof v === "number") {
      total += v;
      any = true;
    }
  }
  return any ? total : undefined;
}

/**
 * Build the text report. `metricsByPlatform` maps each platform to the metrics
 * fetched for its post ids; platforms absent from the map (or in
 * NO_METRICS_PLATFORMS) are shown without numbers.
 */
export function formatReport(
  records: PostRecord[],
  metricsByPlatform: Map<PlatformId, MetricsByPostId>,
  opts: { errors?: Map<PlatformId, string>; sort?: "views" | "date" } = {},
): string {
  const sortMode = opts.sort ?? "views";
  const byPlatform = new Map<PlatformId, PostRecord[]>();
  for (const r of records) {
    const arr = byPlatform.get(r.platform) ?? [];
    arr.push(r);
    byPlatform.set(r.platform, arr);
  }

  const lines: string[] = [];
  const grand = { views: 0, likes: 0, comments: 0, shares: 0 };
  const grandSeen = { views: false, likes: false, comments: false, shares: false };

  const platforms = [...byPlatform.keys()].sort();
  for (const platform of platforms) {
    const recs = byPlatform.get(platform)!;
    const metrics = metricsByPlatform.get(platform) ?? new Map();
    const rows: StatRow[] = recs.map((record) => ({
      record,
      metrics: metrics.get(record.postId) ?? {},
    }));

    lines.push("");
    const err = opts.errors?.get(platform);
    if (NO_METRICS_PLATFORMS.has(platform)) {
      lines.push(`${platform.toUpperCase()} — ${recs.length} post(s), no analytics API`);
    } else if (err) {
      lines.push(`${platform.toUpperCase()} — ${recs.length} post(s) · stats unavailable: ${err}`);
    } else {
      lines.push(`${platform.toUpperCase()} — ${recs.length} post(s)`);
    }

    if (!NO_METRICS_PLATFORMS.has(platform) && !err) {
      if (sortMode === "date") {
        rows.sort((a, b) => Date.parse(b.record.ts) - Date.parse(a.record.ts));
      } else {
        rows.sort((a, b) => (b.metrics.views ?? -1) - (a.metrics.views ?? -1));
      }
      for (const { record, metrics: m } of rows) {
        const label = record.title ?? record.postId;
        lines.push(
          `  ${fmt(m.views)} views · ${fmt(m.likes)} likes · ${fmt(m.comments)} cmts${
            m.shares !== undefined ? ` · ${fmt(m.shares)} shares` : ""
          }  — ${label}`,
        );
      }
      const sv = sum(rows, "views");
      const sl = sum(rows, "likes");
      const sc = sum(rows, "comments");
      lines.push(`  subtotal: ${fmt(sv)} views · ${fmt(sl)} likes · ${fmt(sc)} cmts`);
      for (const [k, s] of [
        ["views", sv],
        ["likes", sl],
        ["comments", sc],
      ] as const) {
        if (typeof s === "number") {
          grand[k] += s;
          grandSeen[k] = true;
        }
      }
    }
  }

  lines.push("");
  lines.push(
    `TOTAL (fetchable platforms): ${grandSeen.views ? grand.views.toLocaleString("en-US") : "—"} views · ${
      grandSeen.likes ? grand.likes.toLocaleString("en-US") : "—"
    } likes · ${grandSeen.comments ? grand.comments.toLocaleString("en-US") : "—"} comments · ${records.length} posts logged`,
  );
  return lines.join("\n");
}
