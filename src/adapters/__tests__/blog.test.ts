import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BlogPublisher,
  splitTitleBody,
  appendLink,
  renderMarkdown,
  yamlString,
  slugify,
  mapError,
  type BlogClientLike,
} from "../blog.js";
import type { BlogConfig } from "../../config/env.js";

const config: BlogConfig = {
  token: "ghp_test",
  repo: "janfabian/lilgeckos.com",
  branch: "main",
  contentDir: "site/src/content/blog",
  siteUrl: "https://janfabian.github.io/lilgeckos.com",
};

const FIXED = new Date("2026-05-25T12:00:00.000Z");

function mockClient(over: Partial<BlogClientLike> = {}): BlogClientLike {
  return {
    createFile: vi.fn(async () => ({ commitSha: "abc123", htmlUrl: "https://github.com/file" })),
    getRepo: vi.fn(async () => ({ fullName: "janfabian/lilgeckos.com" })),
    ...over,
  };
}

function adapter(client: BlogClientLike) {
  return new BlogPublisher(config, { client, now: () => FIXED });
}

describe("BlogPublisher.publish", () => {
  it("uses an explicit title and writes a dated, slugged markdown file", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ title: "Hello Geckos!", text: "Body line." });

    expect(res.ok).toBe(true);
    expect(res.postId).toBe("2026-05-25-hello-geckos");
    expect(res.url).toBe("https://janfabian.github.io/lilgeckos.com/blog/2026-05-25-hello-geckos");

    const call = (client.createFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.path).toBe("site/src/content/blog/2026-05-25-hello-geckos.md");
    expect(call.branch).toBe("main");
    const md = Buffer.from(call.contentBase64, "base64").toString("utf8");
    expect(md).toContain('title: "Hello Geckos!"');
    expect(md).toContain("pubDate: 2026-05-25T12:00:00.000Z");
    expect(md).toContain("Body line.");
  });

  it("derives title from the first line of text when no title is given", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ text: "My first post\n\nSecond paragraph." });
    expect(res.postId).toBe("2026-05-25-my-first-post");

    const call = (client.createFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const md = Buffer.from(call.contentBase64, "base64").toString("utf8");
    expect(md).toContain('title: "My first post"');
    expect(md).toContain("Second paragraph.");
    // first line became the title, not duplicated in the body
    expect(md.split("---").pop()).not.toContain("My first post");
  });

  it("appends a link to the body when present", async () => {
    const client = mockClient();
    await adapter(client).publish({ title: "T", text: "see this", link: "https://lilgeckos.com/x" });
    const call = (client.createFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const md = Buffer.from(call.contentBase64, "base64").toString("utf8");
    expect(md).toContain("https://lilgeckos.com/x");
  });

  it("falls back to a dated title for a text-less post", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({ text: "   " });
    expect(res.postId).toBe("2026-05-25-update-2026-05-25");
  });

  it("maps a 401 to auth and never throws", async () => {
    const client = mockClient({
      createFile: vi.fn(async () => {
        throw Object.assign(new Error("GitHub API 401"), { status: 401, detail: "Bad credentials" });
      }),
    });
    const res = await adapter(client).publish({ title: "x", text: "y" });
    expect(res).toMatchObject({ ok: false, errorCode: "auth" });
    expect(res.error).toContain("Bad credentials");
  });

  it("maps a 422 (file exists) to validation", async () => {
    const client = mockClient({
      createFile: vi.fn(async () => {
        throw Object.assign(new Error("GitHub API 422"), { status: 422 });
      }),
    });
    const res = await adapter(client).publish({ title: "x", text: "y" });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
  });
});

describe("BlogPublisher media", () => {
  const img = join(tmpdir(), `hub-blog-img-${process.pid}.jpg`);
  const vid = join(tmpdir(), `hub-blog-vid-${process.pid}.mp4`);
  beforeAll(() => {
    writeFileSync(img, Buffer.alloc(128));
    writeFileSync(vid, Buffer.alloc(256));
  });
  afterAll(() => {
    rmSync(img, { force: true });
    rmSync(vid, { force: true });
  });

  it("uploads an image and embeds it by absolute URL", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      title: "Photo Post",
      text: "look at this",
      media: [{ path: img, kind: "image", altText: "a gecko" }],
    });
    expect(res.ok).toBe(true);
    const calls = (client.createFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2); // media + markdown
    expect(calls[0]![0].path).toBe("site/public/blog-media/2026-05-25-photo-post/01-hub-blog-img-" + process.pid + ".jpg");
    const md = Buffer.from(calls[1]![0].contentBase64, "base64").toString("utf8");
    expect(md).toContain(
      "![a gecko](https://janfabian.github.io/lilgeckos.com/blog-media/2026-05-25-photo-post/01-hub-blog-img-" +
        process.pid +
        ".jpg)",
    );
    expect(md).toContain("look at this");
  });

  it("uploads a video and embeds a <video> tag", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      title: "Clip Post",
      text: "yum",
      media: [{ path: vid, kind: "video" }],
    });
    expect(res.ok).toBe(true);
    const calls = (client.createFile as ReturnType<typeof vi.fn>).mock.calls;
    const md = Buffer.from(calls[1]![0].contentBase64, "base64").toString("utf8");
    expect(md).toContain("<video controls");
    expect(md).toContain("/blog-media/2026-05-25-clip-post/01-hub-blog-vid-" + process.pid + ".mp4");
  });

  it("embeds multiple mixed media (image + video) in order in one post", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      title: "Album",
      text: "a few shots",
      media: [
        { path: img, kind: "image", altText: "shot 1" },
        { path: vid, kind: "video" },
      ],
    });
    expect(res.ok).toBe(true);
    const calls = (client.createFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(3); // 2 media uploads + 1 markdown
    const md = Buffer.from(calls[2]![0].contentBase64, "base64").toString("utf8");
    expect(md).toContain("/blog-media/2026-05-25-album/01-");
    expect(md).toContain("/blog-media/2026-05-25-album/02-");
    expect(md).toContain("![shot 1]");
    expect(md).toContain("<video controls");
  });

  it("rejects a missing media file without any upload", async () => {
    const client = mockClient();
    const res = await adapter(client).publish({
      title: "x",
      text: "y",
      media: [{ path: "/nope/missing.jpg", kind: "image" }],
    });
    expect(res).toMatchObject({ ok: false, errorCode: "validation" });
    expect(client.createFile).not.toHaveBeenCalled();
  });
});

describe("BlogPublisher.checkStatus", () => {
  it("healthy when the repo is readable", async () => {
    const res = await adapter(mockClient()).checkStatus();
    expect(res).toMatchObject({ credentialsPresent: true, healthy: true });
    expect(res.detail).toContain("janfabian/lilgeckos.com");
  });

  it("healthy=false on an auth failure", async () => {
    const client = mockClient({
      getRepo: vi.fn(async () => {
        throw Object.assign(new Error("401"), { status: 401 });
      }),
    });
    const res = await adapter(client).checkStatus();
    expect(res.healthy).toBe(false);
  });

  it("healthy=undefined on a non-auth failure (cannot confirm)", async () => {
    const client = mockClient({
      getRepo: vi.fn(async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      }),
    });
    const res = await adapter(client).checkStatus();
    expect(res.healthy).toBeUndefined();
  });
});

describe("blog helpers", () => {
  it("yamlString escapes quotes and backslashes and collapses newlines", () => {
    expect(yamlString('a "quote" and \\ slash')).toBe('"a \\"quote\\" and \\\\ slash"');
    expect(yamlString("line1\nline2")).toBe('"line1 line2"');
  });

  it("a title that tries to break frontmatter stays a single safe scalar", () => {
    const evil = 'X"\ndraft: true\nfoo: bar';
    const md = renderMarkdown({ title: evil, body: "b", date: FIXED });
    // exactly one title line, and no injected draft:true / foo: bar keys
    expect(md.match(/^title:/gm)?.length).toBe(1);
    expect(md).not.toMatch(/^foo: bar$/m);
    expect(md).toContain("draft: false");
  });

  it("slugify ascii-folds, lowercases, and dashes", () => {
    expect(slugify("Héllo, Wörld!")).toBe("hello-world");
    expect(slugify("  spaced  out  ")).toBe("spaced-out");
    expect(slugify("!!!")).toBe("");
  });

  it("splitTitleBody prefers explicit title", () => {
    expect(splitTitleBody({ title: " T ", text: "body" }, FIXED)).toEqual({
      title: "T",
      body: "body",
    });
  });

  it("appendLink is idempotent when the link is already in the body", () => {
    expect(appendLink("see https://a.com here", "https://a.com")).toBe("see https://a.com here");
  });

  it("mapError classifies by HTTP status", () => {
    expect(mapError({ status: 403 }).errorCode).toBe("auth");
    expect(mapError({ status: 429 }).errorCode).toBe("rate_limit");
    expect(mapError({ status: 404 }).errorCode).toBe("validation");
    expect(mapError(new Error("fetch failed")).errorCode).toBe("network");
    expect(mapError("weird").errorCode).toBe("unknown");
  });
});
