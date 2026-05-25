import type { AppConfig } from "../config/env.js";
import type { Publisher } from "./publisher.js";
import type { PlatformId } from "./types.js";
import { TwitterPublisher } from "../adapters/twitter.js";
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
      new TwitterPublisher(config.twitter, { mediaMaxBytes: config.mediaMaxBytes }),
    );
  }
  if (config.mockEnabled) {
    registry.set("mock", new MockPublisher());
  }

  return registry;
}

export function enabledPlatforms(registry: Map<PlatformId, Publisher>): PlatformId[] {
  return [...registry.keys()];
}
