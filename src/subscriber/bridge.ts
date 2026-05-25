import { randomUUID } from "node:crypto";

export interface InboundMessage {
  chatJid: string;
  senderJid: string;
  isFromMe: boolean;
  messageId: string;
  content: string;
  mediaType: string; // "", "image", "video", ...
}

export interface BridgeOptions {
  wsUrl: string; // ws://127.0.0.1:8080/ws/events
  httpBase: string; // http://127.0.0.1:8080
  chats: string[]; // chat JIDs to subscribe to
  clientId?: string;
  log?: (msg: string) => void;
}

/**
 * Connects to the WhatsApp bridge: subscribes to the given chats over WS and
 * exposes send/download over HTTP. Auto-reconnects.
 */
export class BridgeClient {
  private ws?: WebSocket;
  private handler?: (m: InboundMessage) => void;
  private readonly clientId: string;
  private readonly log: (msg: string) => void;
  private closed = false;

  constructor(private readonly opts: BridgeOptions) {
    this.clientId = opts.clientId ?? randomUUID();
    this.log = opts.log ?? (() => {});
  }

  onMessage(cb: (m: InboundMessage) => void): void {
    this.handler = cb;
  }

  connect(): void {
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          client_id: this.clientId,
          filter: { chats: this.opts.chats, excludeChats: [], exclusive: false },
        }),
      );
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (parsed.type === "subscribe_ack") {
        if (!parsed.ok) this.log(`subscribe rejected: ${String(parsed.error)}`);
        else this.log(`subscribed (session ${String(parsed.session_id)})`);
        return;
      }
      if (parsed.type === "message" && this.handler) {
        this.handler({
          chatJid: String(parsed.chat_jid ?? ""),
          senderJid: String(parsed.sender_jid ?? ""),
          isFromMe: Boolean(parsed.is_from_me),
          messageId: String(parsed.message_id ?? ""),
          content: String(parsed.content ?? ""),
          mediaType: String(parsed.media_type ?? ""),
        });
      }
    });
    ws.addEventListener("close", () => {
      if (this.closed) return;
      this.log("ws closed, reconnecting in 2s");
      setTimeout(() => this.connect(), 2000);
    });
    ws.addEventListener("error", () => ws.close());
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  async send(recipient: string, message: string): Promise<void> {
    const res = await fetch(`${this.opts.httpBase}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient, message }),
    });
    if (!res.ok) throw new Error(`bridge /api/send failed: ${res.status}`);
  }

  /** Download a message's media; returns the local file path. */
  async download(messageId: string, chatJid: string): Promise<string> {
    const res = await fetch(`${this.opts.httpBase}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: messageId, chat_jid: chatJid }),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; path?: string; message?: string };
    if (!res.ok || !json.success || !json.path) {
      throw new Error(`bridge /api/download failed: ${json.message ?? res.status}`);
    }
    return json.path;
  }
}
