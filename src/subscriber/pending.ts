import type { ParsedPost } from "./parse.js";

export interface Proposal {
  parsed: ParsedPost;
  targets: string[];
  /** message id of the original media message, if any, to download on confirm. */
  mediaMessageId?: string;
  mediaKind?: "image" | "video";
  createdAt: number;
}

/**
 * One pending proposal per chat. The subscriber proposes a draft, then the
 * user's next affirmative message ("go") publishes it. Proposals expire so a
 * stale "go" much later doesn't fire an old draft.
 */
export class PendingProposals {
  private readonly byChat = new Map<string, Proposal>();
  constructor(private readonly ttlMs = 15 * 60 * 1000) {}

  set(chatId: string, p: Omit<Proposal, "createdAt">, now = Date.now()): void {
    this.byChat.set(chatId, { ...p, createdAt: now });
  }

  /** Return the live proposal for a chat, dropping it if expired. */
  take(chatId: string, now = Date.now()): Proposal | undefined {
    const p = this.byChat.get(chatId);
    if (!p) return undefined;
    if (now - p.createdAt > this.ttlMs) {
      this.byChat.delete(chatId);
      return undefined;
    }
    this.byChat.delete(chatId);
    return p;
  }

  clear(chatId: string): void {
    this.byChat.delete(chatId);
  }
}

const AFFIRM = /^\s*(go|yes|yep|yeah|publish|post it|do it|send it|ship it|👍|✅)\s*!*\s*$/i;
const CANCEL = /^\s*(no|nope|cancel|stop|nvm|never ?mind|❌)\s*!*\s*$/i;

/** A short, standalone affirmation like "go" / "yes" / 👍 — not bare "ok". */
export function isAffirmation(text: string): boolean {
  return AFFIRM.test(text);
}

export function isCancel(text: string): boolean {
  return CANCEL.test(text);
}
