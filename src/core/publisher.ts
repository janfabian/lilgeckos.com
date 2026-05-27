import type { Post, PublishResult, PlatformId, PlatformStatus, PublishContext } from "./types.js";

/**
 * One adapter per social platform implements this.
 *
 * Contract: neither method throws. publish() always resolves a PublishResult
 * (errors become ok:false + errorCode); checkStatus() always resolves a
 * PlatformStatus (a failed probe is healthy:undefined, never a thrown error).
 *
 * `ctx` carries cross-platform results from earlier in the same fan-out (e.g.
 * the YouTube video id, used by the blog adapter to embed rather than upload).
 * Adapters that don't need it simply ignore the argument.
 */
export interface Publisher {
  readonly platform: PlatformId;
  publish(post: Post, ctx?: PublishContext): Promise<PublishResult>;
  checkStatus(): Promise<PlatformStatus>;
}
