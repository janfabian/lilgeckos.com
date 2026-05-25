import type { Publisher } from "../core/publisher.js";
import type { Post, PublishResult, PlatformStatus, ErrorCode, PlatformId } from "../core/types.js";

export interface MockOptions {
  /** When set, publish() resolves a failure with this code (for tests). */
  failWith?: ErrorCode;
  /** Simulated latency in ms. */
  delayMs?: number;
  /** Platform id this mock reports as. Defaults to "mock". Lets tests stand in for other platforms. */
  platform?: PlatformId;
}

/**
 * No-cost adapter for local smoke tests and as a test double. Registered as the
 * "mock" platform when MOCK_ENABLED is set.
 */
export class MockPublisher implements Publisher {
  readonly platform: PlatformId;
  constructor(private readonly opts: MockOptions = {}) {
    this.platform = opts.platform ?? "mock";
  }

  async publish(post: Post): Promise<PublishResult> {
    const start = Date.now();
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (this.opts.failWith) {
      return {
        platform: this.platform,
        ok: false,
        error: `mock failure (${this.opts.failWith})`,
        errorCode: this.opts.failWith,
        durationMs: Date.now() - start,
      };
    }
    return {
      platform: this.platform,
      ok: true,
      postId: `mock-${Date.now()}`,
      url: "mock://published",
      durationMs: Date.now() - start,
    };
  }

  async checkStatus(): Promise<PlatformStatus> {
    return {
      platform: this.platform,
      enabled: true,
      credentialsPresent: true,
      healthy: true,
      detail: `mock adapter${this.opts.failWith ? ` (forced ${this.opts.failWith})` : ""}`,
    };
  }
}
