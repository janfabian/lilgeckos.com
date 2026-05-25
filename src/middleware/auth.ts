import type { MiddlewareHandler } from "hono";

/**
 * Bearer-token guard for mutating endpoints. Requires:
 *   Authorization: Bearer <HUB_TOKEN>
 * Returns 401 on missing/malformed/incorrect token. Pairs with binding the
 * server to 127.0.0.1 (defense in depth).
 */
export function bearerAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== expectedToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
