/**
 * `bun run stats` — read the published-posts log and print current per-post
 * metrics across platforms, with per-platform subtotals and a grand total.
 *
 * Usage:
 *   bun run stats                 # all logged posts
 *   bun run stats --since 7d      # only posts from the last 7 days (also: 30d, 12h, ISO date)
 *   bun run stats --sort date     # order each platform newest-first (default: by views)
 *   bun run stats --json          # machine-readable dump instead of the text report
 *
 * Reads post ids from data/published.jsonl (written by the hub on each publish;
 * override with POST_LOG_PATH). Analytics come live from each platform's API
 * using the same credentials as the publisher. Best-effort: a platform whose
 * stats API errors is reported as unavailable, never crashes the run.
 */
import "dotenv/config";
import { loadConfig } from "../src/config/index.js";
import { readRecords } from "../src/core/post-log.js";
import type { PlatformId } from "../src/core/types.js";
import { filterSince, parseSince, formatReport, NO_METRICS_PLATFORMS } from "../src/stats/report.js";
import {
  fetchYouTube,
  fetchTwitter,
  fetchFacebook,
  fetchInstagram,
  type MetricsByPostId,
} from "../src/stats/fetchers.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? (process.argv[i + 1] ?? "") : undefined;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const all = readRecords();
  if (all.length === 0) {
    console.log("No posts logged yet (data/published.jsonl is empty). Publish something first.");
    return;
  }

  const cutoff = parseSince(arg("--since"), Date.now());
  const records = filterSince(all, cutoff);

  // Group ids by platform.
  const idsByPlatform = new Map<PlatformId, string[]>();
  for (const r of records) {
    const arr = idsByPlatform.get(r.platform) ?? [];
    arr.push(r.postId);
    idsByPlatform.set(r.platform, arr);
  }

  const metricsByPlatform = new Map<PlatformId, MetricsByPostId>();
  const errors = new Map<PlatformId, string>();
  const run = async (platform: PlatformId, fn: () => Promise<MetricsByPostId>) => {
    if (!idsByPlatform.has(platform)) return;
    try {
      metricsByPlatform.set(platform, await fn());
    } catch (e) {
      errors.set(platform, e instanceof Error ? e.message : String(e));
    }
  };

  await Promise.all([
    cfg.youtube ? run("youtube", () => fetchYouTube(cfg.youtube!, idsByPlatform.get("youtube") ?? [])) : undefined,
    cfg.twitter ? run("twitter", () => fetchTwitter(cfg.twitter!, idsByPlatform.get("twitter") ?? [])) : undefined,
    cfg.facebook ? run("facebook", () => fetchFacebook(cfg.facebook!, idsByPlatform.get("facebook") ?? [])) : undefined,
    cfg.instagram ? run("instagram", () => fetchInstagram(cfg.instagram!, idsByPlatform.get("instagram") ?? [])) : undefined,
  ]);

  // Platforms present in the log but without configured creds → mark unavailable
  // (unless they're the no-metrics kind like blog).
  for (const platform of idsByPlatform.keys()) {
    if (
      !metricsByPlatform.has(platform) &&
      !errors.has(platform) &&
      !NO_METRICS_PLATFORMS.has(platform)
    ) {
      errors.set(platform, "credentials not configured");
    }
  }

  if (process.argv.includes("--json")) {
    const out = records.map((r) => ({
      ...r,
      metrics: metricsByPlatform.get(r.platform)?.get(r.postId) ?? null,
    }));
    console.log(JSON.stringify({ since: cutoff ?? null, posts: out }, null, 2));
    return;
  }

  const sort = arg("--sort") === "date" ? "date" : "views";
  const span = cutoff ? `since ${new Date(cutoff).toISOString().slice(0, 10)}` : "all time";
  console.log(`lilgeckos hub — post stats (${span}, ${records.length} posts, sorted by ${sort})`);
  console.log(formatReport(records, metricsByPlatform, { errors, sort }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
