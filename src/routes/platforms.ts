import { Hono } from "hono";
import type { Publisher } from "../core/publisher.js";
import type { PlatformId, PlatformStatus } from "../core/types.js";

/**
 * GET /platforms — list enabled adapters and credential status.
 * ?check=true runs each adapter's best-effort live probe (may incur a read call).
 * Read-only, no secrets returned, so no auth.
 */
export function platformsRoute(registry: Map<PlatformId, Publisher>): Hono {
  const app = new Hono();
  app.get("/platforms", async (c) => {
    const check = c.req.query("check") === "true";
    const platforms: PlatformStatus[] = [];
    for (const [id, pub] of registry) {
      if (check) {
        platforms.push(await pub.checkStatus());
      } else {
        platforms.push({ platform: id, enabled: true, credentialsPresent: true });
      }
    }
    return c.json({ platforms });
  });
  return app;
}
