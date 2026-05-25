import "dotenv/config";
import { serve } from "@hono/node-server";
import { loadConfig, ConfigError } from "./config/index.js";
import { createLogger } from "./lib/logger.js";
import { buildRegistry, enabledPlatforms } from "./core/registry.js";
import { buildServer } from "./server.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(config.logLevel);
  const registry = buildRegistry(config);
  const app = buildServer(config, registry);

  // Bind to localhost only — the publish endpoint posts to real accounts.
  serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
    log.info(
      { port: info.port, platforms: enabledPlatforms(registry) },
      "broadcast hub listening on 127.0.0.1",
    );
    if (enabledPlatforms(registry).length === 0) {
      log.warn("no platforms enabled — set Twitter creds or MOCK_ENABLED=1");
    }
  });
}

main();
