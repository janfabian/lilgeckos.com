import { Hono } from "hono";

export function healthRoute(): Hono {
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ status: "ok", uptimeSec: Math.round(process.uptime()) }),
  );
  return app;
}
