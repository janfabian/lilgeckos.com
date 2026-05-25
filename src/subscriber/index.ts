import "dotenv/config";
import { BridgeClient } from "./bridge.js";
import { makeHandler } from "./orchestrate.js";
import { enabledPlatforms, type HubOptions } from "./hub.js";

const log = (m: string) => console.log(`[subscriber] ${m}`);

async function main(): Promise<void> {
  const hubToken = process.env.HUB_TOKEN;
  const chats = (process.env.SUBSCRIBER_CHATS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!hubToken) {
    console.error("subscriber: HUB_TOKEN is required");
    process.exit(1);
  }
  if (chats.length === 0) {
    console.error("subscriber: SUBSCRIBER_CHATS is required (comma-separated chat JIDs to watch)");
    process.exit(1);
  }

  // Auth sanity for the LLM parse step.
  if (process.env.ANTHROPIC_API_KEY) {
    log("WARNING: ANTHROPIC_API_KEY is set — the LLM parse will bill API credits, not your subscription. Unset it to use CLAUDE_CODE_OAUTH_TOKEN.");
  } else if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    log("WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set — `claude -p` may be unauthenticated. Run `claude setup-token`.");
  }

  const hub: HubOptions = { base: process.env.HUB_URL ?? "http://127.0.0.1:8137", token: hubToken };
  const wsUrl = process.env.BRIDGE_WS_URL ?? "ws://127.0.0.1:8080/ws/events";
  const httpBase = process.env.BRIDGE_HTTP_URL ?? "http://127.0.0.1:8080";

  let enabled: string[];
  try {
    enabled = await enabledPlatforms(hub);
  } catch (err) {
    console.error(`subscriber: cannot reach hub at ${hub.base}/platforms — ${err}`);
    process.exit(1);
  }
  if (enabled.length === 0) {
    console.error("subscriber: hub reports no enabled platforms");
    process.exit(1);
  }

  const bridge = new BridgeClient({ wsUrl, httpBase, chats, log });
  const handle = makeHandler({
    enabled,
    hub,
    send: (chatId, text) => bridge.send(chatId, text),
    download: (mid, cid) => bridge.download(mid, cid),
    log,
  });
  bridge.onMessage((m) => {
    handle(m).catch((err) => log(`handler error: ${err}`));
  });
  bridge.connect();
  log(`watching ${chats.join(", ")} → targets [${enabled.join(", ")}], propose-then-confirm`);
}

main();
