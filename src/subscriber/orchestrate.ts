import type { ParsedPost } from "./parse.js";
import { parseMessage, type ParseDeps } from "./parse.js";
import { resolveTargets } from "./router.js";
import { PendingProposals, isAffirmation, isCancel } from "./pending.js";
import type { InboundMessage } from "./bridge.js";
import { publish, type HubMedia, type HubOptions, type PublishResponse } from "./hub.js";

export interface OrchestratorDeps {
  enabled: string[];
  hub: HubOptions;
  send: (chatId: string, text: string) => Promise<void>;
  download: (messageId: string, chatJid: string) => Promise<string>;
  parseDeps?: ParseDeps;
  pending?: PendingProposals;
  /** Injectable for tests; defaults to the real hub publish(). */
  publishImpl?: (hub: HubOptions, post: Parameters<typeof publish>[1], targets: string[]) => Promise<PublishResponse>;
  log?: (msg: string) => void;
}

/**
 * Handle one inbound message. Flow:
 *  - ignore our own / trivial messages
 *  - if a proposal is pending: "go" → publish, "no" → cancel
 *  - otherwise parse → resolve targets → propose a draft and wait
 */
export function makeHandler(deps: OrchestratorDeps) {
  const pending = deps.pending ?? new PendingProposals();
  const log = deps.log ?? (() => {});
  const doPublish = deps.publishImpl ?? publish;

  return async function handle(m: InboundMessage): Promise<void> {
    if (m.isFromMe) return;
    const text = m.content.trim();

    // Confirmation / cancellation of a pending draft.
    const existing = pending.take(m.chatJid);
    if (existing) {
      if (isAffirmation(text)) {
        try {
          const media = await loadMedia(existing.mediaMessageId, existing.mediaKind, m.chatJid, deps.download);
          const resp = await doPublish(
            deps.hub,
            { title: existing.parsed.title, text: composeText(existing.parsed), media },
            existing.targets,
          );
          await deps.send(m.chatJid, resultText(resp));
        } catch (err) {
          await deps.send(m.chatJid, `Publish failed: ${msg(err)}`);
        }
        return;
      }
      if (isCancel(text)) {
        await deps.send(m.chatJid, "Cancelled — nothing posted.");
        return;
      }
      // Any other message replaces the old draft: fall through to re-propose.
    }

    if (!shouldConsider(m, text)) return;

    let parsed: ParsedPost;
    try {
      parsed = await parseMessage(text, deps.enabled, deps.parseDeps);
    } catch (err) {
      log(`parse failed: ${msg(err)}`);
      return;
    }
    if (!parsed.text && !m.mediaType) return; // nothing postable

    const targets = resolveTargets(parsed, deps.enabled);
    const mediaKind = m.mediaType === "image" || m.mediaType === "video" ? m.mediaType : undefined;
    pending.set(m.chatJid, {
      parsed,
      targets,
      mediaMessageId: mediaKind ? m.messageId : undefined,
      mediaKind,
    });
    await deps.send(m.chatJid, proposalText(parsed, targets, mediaKind));
  };
}

async function loadMedia(
  messageId: string | undefined,
  kind: "image" | "video" | undefined,
  chatJid: string,
  download: (m: string, c: string) => Promise<string>,
): Promise<HubMedia[] | undefined> {
  if (!messageId || !kind) return undefined;
  const path = await download(messageId, chatJid);
  return [{ path, kind }];
}

/** Skip pure chatter / one-word noise; act on media or a message with substance. */
export function shouldConsider(m: InboundMessage, text: string): boolean {
  if (m.mediaType) return true;
  return text.length >= 8;
}

/** Fold hashtags into the body (the hub Post has no separate tags field). */
export function composeText(p: ParsedPost): string {
  const tagLine = p.tags.length ? p.tags.map((t) => `#${t}`).join(" ") : "";
  return [p.text, tagLine].filter((s) => s.length > 0).join("\n\n").trim();
}

export function proposalText(p: ParsedPost, targets: string[], mediaKind?: string): string {
  const lines = [`📝 Draft → ${targets.join(", ")}`];
  if (p.title) lines.push(`Title: ${p.title}`);
  lines.push("", composeText(p) || "(no text)");
  if (mediaKind) lines.push("", `(${mediaKind} attached)`);
  lines.push("", 'Reply "go" to publish, or "no" to cancel.');
  return lines.join("\n");
}

export function resultText(resp: PublishResponse): string {
  return resp.results
    .map((r) => (r.ok ? `✅ ${r.platform}: ${r.url ?? "ok"}` : `❌ ${r.platform}: ${r.error ?? "failed"}`))
    .join("\n");
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
