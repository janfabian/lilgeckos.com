import type { Publisher } from "./publisher.js";
import type { Post, PublishResult, PlatformId, PublishSummary } from "./types.js";

/**
 * Synchronous fan-out. Runs every target concurrently with per-target isolation:
 * one platform failing never affects another. Adapters never throw, but
 * Promise.allSettled guards anyway. Results preserve target order.
 *
 * Future async upgrade (multi-platform, slow uploads): swap the execution
 * strategy here (enqueue + return a job id). The Publisher interface and
 * PublishResult shape stay identical.
 */
export async function publishToTargets(
  post: Post,
  targets: PlatformId[],
  registry: Map<PlatformId, Publisher>,
): Promise<PublishResult[]> {
  const settled = await Promise.allSettled(
    targets.map((id) => {
      const pub = registry.get(id);
      if (!pub) {
        return Promise.resolve<PublishResult>({
          platform: id,
          ok: false,
          error: "platform not enabled",
          errorCode: "validation",
          durationMs: 0,
        });
      }
      return pub.publish(post);
    }),
  );

  return settled.map((s, i): PublishResult => {
    if (s.status === "fulfilled") return s.value;
    return {
      platform: targets[i] as PlatformId,
      ok: false,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      errorCode: "unknown",
      durationMs: 0,
    };
  });
}

export function summarize(results: PublishResult[]): PublishSummary {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  return {
    total: results.length,
    succeeded,
    failed,
    partial: succeeded > 0 && failed > 0,
  };
}
