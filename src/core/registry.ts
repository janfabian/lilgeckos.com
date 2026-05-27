import type { AppConfig } from "../config/env.js";
import type { Publisher } from "./publisher.js";
import type { PlatformId } from "./types.js";
import { TwitterPublisher } from "../adapters/twitter.js";
import { FacebookPublisher } from "../adapters/facebook.js";
import { YouTubePublisher } from "../adapters/youtube.js";
import { BlogPublisher } from "../adapters/blog.js";
import { MockPublisher } from "../adapters/mock.js";

/**
 * Build the set of enabled adapters from config. Adding a platform later =
 * one more branch here (plus its adapter file). An adapter is registered only
 * when its credentials are present.
 */
export function buildRegistry(config: AppConfig): Map<PlatformId, Publisher> {
  const registry = new Map<PlatformId, Publisher>();

  if (config.twitter) {
    registry.set(
      "twitter",
      new TwitterPublisher(config.twitter, {
        mediaMaxBytes: config.mediaMaxBytes,
        videoMaxBytes: config.videoMaxBytes,
      }),
    );
  }
  if (config.facebook) {
    registry.set(
      "facebook",
      new FacebookPublisher(config.facebook, {
        mediaMaxBytes: config.mediaMaxBytes,
        videoMaxBytes: config.videoMaxBytes,
      }),
    );
  }
  if (config.youtube) {
    registry.set(
      "youtube",
      new YouTubePublisher(config.youtube, { videoMaxBytes: config.videoMaxBytes }),
    );
  }
  if (config.blog) {
    registry.set("blog", new BlogPublisher(config.blog));
  }
  if (config.mockEnabled) {
    registry.set("mock", new MockPublisher());
  }

  return registry;
}

export function enabledPlatforms(registry: Map<PlatformId, Publisher>): PlatformId[] {
  return [...registry.keys()];
}
