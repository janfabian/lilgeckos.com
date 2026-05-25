import { describe, it, expect } from "vitest";
import { normalizeParsed } from "../parse.js";
import { resolveTargets } from "../router.js";
import { PendingProposals, isAffirmation, isCancel } from "../pending.js";
import { makeHandler } from "../orchestrate.js";
import type { InboundMessage } from "../bridge.js";
import type { HubOptions, PublishResponse } from "../hub.js";

describe("normalizeParsed", () => {
  const allowed = ["twitter", "blog"];
  it("unwraps the claude --output-format json envelope", () => {
    const env = JSON.stringify({ result: JSON.stringify({ targets: ["blog"], text: "hi", tags: ["#a", "b"] }) });
    expect(normalizeParsed(env, allowed)).toEqual({ targets: ["blog"], title: undefined, text: "hi", tags: ["a", "b"] });
  });
  it("extracts JSON embedded in prose", () => {
    const raw = 'Sure! Here:\n{"targets":["twitter"],"title":"T","text":"body","tags":["leopardgecko"]}\nDone.';
    expect(normalizeParsed(raw, allowed)).toEqual({ targets: ["twitter"], title: "T", text: "body", tags: ["leopardgecko"] });
  });
  it("drops platforms not in the allowed set", () => {
    const raw = JSON.stringify({ targets: ["tiktok", "blog"], text: "x", tags: [] });
    expect(normalizeParsed(raw, allowed).targets).toEqual(["blog"]);
  });
  it("returns empty shape on garbage", () => {
    expect(normalizeParsed("not json", allowed)).toEqual({ targets: [], title: undefined, text: "", tags: [] });
  });
});

describe("resolveTargets", () => {
  const enabled = ["twitter", "blog"];
  it("uses named targets when present", () => {
    expect(resolveTargets({ targets: ["blog"], text: "", tags: [] }, enabled)).toEqual(["blog"]);
  });
  it("falls back to all enabled when none named", () => {
    expect(resolveTargets({ targets: [], text: "", tags: [] }, enabled)).toEqual(["twitter", "blog"]);
  });
  it("falls back to all when named targets aren't enabled", () => {
    expect(resolveTargets({ targets: ["youtube"], text: "", tags: [] }, enabled)).toEqual(["twitter", "blog"]);
  });
});

describe("pending + affirmation", () => {
  it("set/take is one-shot and expires", () => {
    const p = new PendingProposals(1000);
    p.set("c", { parsed: { targets: [], text: "x", tags: [] }, targets: ["blog"] }, 0);
    expect(p.take("c", 500)?.targets).toEqual(["blog"]);
    expect(p.take("c", 600)).toBeUndefined(); // already taken
    p.set("c", { parsed: { targets: [], text: "x", tags: [] }, targets: ["blog"] }, 0);
    expect(p.take("c", 2000)).toBeUndefined(); // expired
  });
  it("recognizes affirmations but not bare 'ok'", () => {
    expect(isAffirmation("go")).toBe(true);
    expect(isAffirmation("Yes!")).toBe(true);
    expect(isAffirmation("👍")).toBe(true);
    expect(isAffirmation("ok")).toBe(false);
    expect(isAffirmation("post about geckos")).toBe(false);
    expect(isCancel("no")).toBe(true);
  });
});

// --- orchestration flow ---
const enabled = ["twitter", "blog"];
const hub: HubOptions = { base: "http://hub", token: "t" };
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  chatJid: "c@g.us",
  senderJid: "u@lid",
  isFromMe: false,
  messageId: "m1",
  content: "",
  mediaType: "",
  ...over,
});

function setup(parseOut: string) {
  const sent: Array<[string, string]> = [];
  const published: Array<{ post: { title?: string; media?: unknown }; targets: string[] }> = [];
  const pending = new PendingProposals();
  const handle = makeHandler({
    enabled,
    hub,
    pending,
    send: async (c, t) => void sent.push([c, t]),
    download: async () => "/tmp/clip.mp4",
    parseDeps: { run: async () => parseOut },
    publishImpl: async (_h, post, targets): Promise<PublishResponse> => {
      published.push({ post, targets });
      return {
        results: targets.map((p) => ({ platform: p, ok: true, url: `https://x/${p}` })),
        summary: { total: targets.length, succeeded: targets.length, failed: 0, partial: false },
      };
    },
  });
  return { handle, sent, published };
}

describe("orchestrator flow", () => {
  it("proposes on a substantial message, then publishes on 'go'", async () => {
    const { handle, sent, published } = setup(
      JSON.stringify({ targets: ["blog"], title: "Gecko News", text: "hello body", tags: ["leopardgecko"] }),
    );
    await handle(msg({ content: "post about the new gecko on the blog" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toContain("blog");
    expect(sent[0]![1]).toContain("#leopardgecko");
    expect(published).toHaveLength(0);

    await handle(msg({ content: "go" }));
    expect(published).toHaveLength(1);
    expect(published[0]!.targets).toEqual(["blog"]);
    expect(published[0]!.post.title).toBe("Gecko News");
    expect(sent).toHaveLength(2);
    expect(sent[1]![1]).toContain("✅");
  });

  it("defaults to all enabled when no platform is named", async () => {
    const { handle, sent } = setup(JSON.stringify({ targets: [], text: "some general update", tags: [] }));
    await handle(msg({ content: "here is some general update to share" }));
    expect(sent[0]![1]).toContain("twitter, blog");
  });

  it("cancels on 'no'", async () => {
    const { handle, sent, published } = setup(JSON.stringify({ targets: ["blog"], text: "x", tags: [] }));
    await handle(msg({ content: "a post worth sharing here" }));
    await handle(msg({ content: "no" }));
    expect(published).toHaveLength(0);
    expect(sent[1]![1]).toMatch(/cancel/i);
  });

  it("ignores own messages and short chatter", async () => {
    const { handle, sent } = setup(JSON.stringify({ targets: [], text: "x", tags: [] }));
    await handle(msg({ isFromMe: true, content: "post this please now" }));
    await handle(msg({ content: "lol" }));
    expect(sent).toHaveLength(0);
  });

  it("attaches downloaded media on confirm", async () => {
    const { handle, published } = setup(JSON.stringify({ targets: ["blog"], title: "Clip", text: "yum", tags: [] }));
    await handle(msg({ content: "water time", mediaType: "video", messageId: "vid1" }));
    await handle(msg({ content: "go" }));
    expect(published[0]!.post.media).toEqual([{ path: "/tmp/clip.mp4", kind: "video" }]);
  });
});
