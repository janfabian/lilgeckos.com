import type { Post, PublishResult, PlatformId, PlatformStatus } from "./types.js";

/**
 * One adapter per social platform implements this.
 *
 * Contract: neither method throws. publish() always resolves a PublishResult
 * (errors become ok:false + errorCode); checkStatus() always resolves a
 * PlatformStatus (a failed probe is healthy:undefined, never a thrown error).
 */
export interface Publisher {
  readonly platform: PlatformId;
  publish(post: Post): Promise<PublishResult>;
  checkStatus(): Promise<PlatformStatus>;
}
