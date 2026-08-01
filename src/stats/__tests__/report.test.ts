import { describe, it, expect } from "vitest";
import { parseSince, filterSince, formatReport } from "../report.js";
import type { PostRecord } from "../../core/post-log.js";
import type { PlatformId } from "../../core/types.js";
import type { MetricsByPostId } from "../fetchers.js";

const NOW = Date.parse("2026-08-01T00:00:00Z");

describe("parseSince", () => {
  it("returns undefined for all/undefined", () => {
    expect(parseSince(undefined, NOW)).toBeUndefined();
    expect(parseSince("all", NOW)).toBeUndefined();
  });
  it("parses relative days and hours", () => {
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseSince("12h", NOW)).toBe(NOW - 12 * 3_600_000);
  });
  it("parses an ISO date", () => {
    expect(parseSince("2026-07-01", NOW)).toBe(Date.parse("2026-07-01"));
  });
  it("returns undefined for garbage", () => {
    expect(parseSince("banana", NOW)).toBeUndefined();
  });
});

describe("filterSince", () => {
  const recs: PostRecord[] = [
    { ts: "2026-07-01T00:00:00Z", platform: "youtube", postId: "old" },
    { ts: "2026-07-31T00:00:00Z", platform: "youtube", postId: "new" },
  ];
  it("keeps all when cutoff undefined", () => {
    expect(filterSince(recs, undefined)).toHaveLength(2);
  });
  it("drops records before the cutoff", () => {
    const kept = filterSince(recs, Date.parse("2026-07-15T00:00:00Z"));
    expect(kept.map((r) => r.postId)).toEqual(["new"]);
  });
});

describe("formatReport", () => {
  const records: PostRecord[] = [
    { ts: "t", platform: "youtube", postId: "y1", title: "Vid A" },
    { ts: "t", platform: "youtube", postId: "y2", title: "Vid B" },
    { ts: "t", platform: "blog", postId: "slug-a", title: "Vid A" },
  ];
  const yt: MetricsByPostId = new Map([
    ["y1", { views: 100, likes: 5, comments: 1 }],
    ["y2", { views: 900, likes: 10, comments: 0 }],
  ]);
  const metricsByPlatform = new Map<PlatformId, MetricsByPostId>([["youtube", yt]]);

  it("sorts by views desc, subtotals, and totals", () => {
    const out = formatReport(records, metricsByPlatform);
    // higher-view video listed first
    expect(out.indexOf("Vid B")).toBeLessThan(out.indexOf("Vid A"));
    expect(out).toContain("subtotal: 1,000 views · 15 likes · 1 cmts");
    expect(out).toContain("TOTAL (fetchable platforms): 1,000 views");
  });

  it("shows blog as a no-analytics platform, not summed", () => {
    const out = formatReport(records, metricsByPlatform);
    expect(out).toContain("BLOG — 1 post(s), no analytics API");
  });

  it("surfaces a per-platform error instead of numbers", () => {
    const out = formatReport(records, new Map(), {
      errors: new Map<PlatformId, string>([["youtube", "rate limited"]]),
    });
    expect(out).toContain("stats unavailable: rate limited");
  });
});
