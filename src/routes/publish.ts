import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Publisher } from "../core/publisher.js";
import type { PlatformId } from "../core/types.js";
import { publishToTargets, summarize } from "../core/orchestrator.js";
import { enabledPlatforms } from "../core/registry.js";

const platformEnum = z.enum(["twitter", "facebook", "instagram", "youtube", "blog", "mock"]);

const mediaItemSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["image", "video"]),
  mimeType: z.string().optional(),
  altText: z.string().optional(),
});

const publishSchema = z.object({
  post: z
    .object({
      // Optional blog post title; ignored by platforms without a title concept.
      title: z.string().optional(),
      text: z.string().default(""),
      media: z.array(mediaItemSchema).optional(),
      link: z.string().url().optional(),
      translations: z
        .object({
          cs: z.object({ title: z.string().optional(), text: z.string().default("") }).optional(),
        })
        .optional(),
    })
    .refine((p) => p.text.trim().length > 0 || (p.media?.length ?? 0) > 0 || !!p.link, {
      message: "post must have text, media, or a link",
    }),
  targets: z.array(platformEnum).optional(),
});

/** POST /publish — synchronous fan-out. Auth is applied where this is mounted. */
export function publishRoute(registry: Map<PlatformId, Publisher>): Hono {
  const app = new Hono();
  app.post("/publish", zValidator("json", publishSchema), async (c) => {
    const { post, targets } = c.req.valid("json");
    const enabled = enabledPlatforms(registry);

    if (enabled.length === 0) {
      return c.json({ error: "no platforms enabled" }, 422);
    }

    const requested = targets && targets.length > 0 ? targets : enabled;
    const results = await publishToTargets(post, requested, registry);
    return c.json({ results, summary: summarize(results) });
  });
  return app;
}
