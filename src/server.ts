import { Hono } from "hono";
import type { AppConfig } from "./config/env.js";
import type { Publisher } from "./core/publisher.js";
import type { PlatformId } from "./core/types.js";
import { bearerAuth } from "./middleware/auth.js";
import { healthRoute } from "./routes/health.js";
import { platformsRoute } from "./routes/platforms.js";
import { publishRoute } from "./routes/publish.js";

/** Build the Hono app. Exported (without listening) so tests can use app.request(). */
export function buildServer(
  config: AppConfig,
  registry: Map<PlatformId, Publisher>,
): Hono {
  const app = new Hono();

  // Auth guards the mutating endpoint only; health + platforms are read-only.
  app.use("/publish", bearerAuth(config.hubToken));

  app.route("/", healthRoute());
  app.route("/", platformsRoute(registry));
  app.route("/", publishRoute(registry));

  return app;
}
