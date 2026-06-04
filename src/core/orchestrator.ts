import type { Publisher } from "./publisher.js";
import type { Post, PublishResult, PlatformId, PublishSummary, PublishContext } from "./types.js";

/** Resolve a single target to a PublishResult. Never throws (adapters shouldn't,
 *  but a thrown error is mapped to a failed result anyway). */
async function publishOne(
  id: PlatformId,
  registry: Map<PlatformId, Publisher>,
  post: Post,
  ctx: PublishContext,
): Promise<PublishResult> {
  const pub = registry.get(id);
  if (!pub) {
    return { platform: id, ok: false, error: "platform not enabled", errorCode: "validation", durationMs: 0 };
  }
  try {
    return await pub.publish(post, ctx);
  } catch (err) {
    return {
      platform: id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "unknown",
      durationMs: 0,
    };
  }
}

/**
 * Synchronous fan-out with per-target isolation: one platform failing never
 * affects another. Results preserve target order.
 *
 * Ordering: YouTube (when targeted) runs FIRST so its uploaded video id can be
 * threaded to the blog adapter — which then embeds the YouTube player instead
 * of committing the raw mp4 (keeps videos out of the git repo / Pages limits).
 * Every other target runs concurrently afterward. If YouTube isn't targeted or
 * fails, the context stays empty and the blog self-hosts the video as before.
 *
 * Future async upgrade: swap the execution strategy here (enqueue + return a
 * job id). The Publisher interface and PublishResult shape stay identical.
 */
export async function publishToTargets(
  post: Post,
  targets: PlatformId[],
  registry: Map<PlatformId, Publisher>,
): Promise<PublishResult[]> {
  const results = new Array<PublishResult>(targets.length);
  let ctx: PublishContext = {};

  // Phase 1 — YouTube (so the blog can embed the resulting Short).
  const ytIdx = targets.indexOf("youtube");
  if (ytIdx !== -1) {
    const yt = await publishOne("youtube", registry, post, ctx);
    results[ytIdx] = yt;
    if (yt.ok && yt.postId) {
      ctx = { ...ctx, youtube: { videoId: yt.postId, url: yt.url ?? "" } };
    }
  }

  // Phase 2 — Blog (so its permalink can be threaded to platforms like Reddit
  // that want a link post pointing at the blog page).
  const blogIdx = targets.indexOf("blog");
  if (blogIdx !== -1) {
    const blog = await publishOne("blog", registry, post, ctx);
    results[blogIdx] = blog;
    if (blog.ok && blog.postId) {
      ctx = { ...ctx, blog: { postId: blog.postId, url: blog.url ?? "" } };
    }
  }

  // Phase 3 — everything else in parallel, with the full ctx.
  const rest = targets
    .map((id, i) => ({ id, i }))
    .filter(({ i }) => i !== ytIdx && i !== blogIdx);
  const settled = await Promise.all(rest.map(({ id }) => publishOne(id, registry, post, ctx)));
  rest.forEach(({ i }, k) => {
    results[i] = settled[k]!;
  });

  return results;
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
