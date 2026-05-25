/**
 * Blog admin helper — delete / edit existing posts via the GitHub Contents API
 * using BLOG_GITHUB_TOKEN (no gh, no git). Gives delete/edit a single stable
 * command so it can be allow-listed narrowly in .claude/settings.json:
 *
 *   "Bash(bun run blog:admin:*)"
 *
 * Usage:
 *   bun run blog:admin list
 *   bun run blog:admin delete <slug>
 *   bun run blog:admin set-title <slug> "New title"
 *   bun run blog:admin append <slug> "text to add"
 *
 * <slug> is the post id (filename without .md), e.g. 2026-05-25-water-break.
 */
import "dotenv/config";

const API = "https://api.github.com";
const token = process.env.BLOG_GITHUB_TOKEN ?? "";
const repo = process.env.BLOG_REPO ?? "";
const branch = process.env.BLOG_BRANCH || "main";
const contentDir = (process.env.BLOG_CONTENT_DIR || "site/src/content/blog").replace(/\/+$/, "");

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
if (!token || !repo) die("BLOG_GITHUB_TOKEN and BLOG_REPO must be set in .env");

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lilgeckos-blog-admin",
};

function pathFor(slug: string): string {
  return `${contentDir}/${slug.replace(/\.md$/, "")}.md`;
}

async function getFile(path: string): Promise<{ sha: string; text: string }> {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${branch}`, { headers });
  if (res.status === 404) die(`post not found: ${path}`);
  if (!res.ok) die(`GET failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { sha: string; content: string };
  return { sha: j.sha, text: Buffer.from(j.content, "base64").toString("utf8") };
}

async function putFile(path: string, text: string, sha: string, message: string): Promise<void> {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(text, "utf8").toString("base64"), sha, branch }),
  });
  if (!res.ok) die(`PUT failed: ${res.status} ${await res.text()}`);
}

async function listPosts(): Promise<void> {
  const res = await fetch(`${API}/repos/${repo}/contents/${contentDir}?ref=${branch}`, { headers });
  if (!res.ok) die(`list failed: ${res.status}`);
  const items = (await res.json()) as Array<{ name: string }>;
  items.filter((i) => i.name.endsWith(".md")).forEach((i) => console.log(i.name.replace(/\.md$/, "")));
}

async function main(): Promise<void> {
  const [cmd, slug, arg] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      return listPosts();
    case "delete": {
      if (!slug) die("usage: blog:admin delete <slug>");
      const path = pathFor(slug);
      const { sha } = await getFile(path);
      const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ message: `blog: delete ${slug}`, sha, branch }),
      });
      if (!res.ok) die(`DELETE failed: ${res.status} ${await res.text()}`);
      console.log(`deleted ${path}`);
      return;
    }
    case "set-title": {
      if (!slug || !arg) die('usage: blog:admin set-title <slug> "New title"');
      const path = pathFor(slug);
      const { sha, text } = await getFile(path);
      if (!/^title:.*$/m.test(text)) die("no title line in frontmatter");
      const updated = text.replace(/^title:.*$/m, `title: ${JSON.stringify(arg)}`);
      await putFile(path, updated, sha, `blog: retitle ${slug}`);
      console.log(`set title of ${slug}`);
      return;
    }
    case "append": {
      if (!slug || !arg) die('usage: blog:admin append <slug> "text"');
      const path = pathFor(slug);
      const { sha, text } = await getFile(path);
      const updated = `${text.replace(/\s+$/, "")}\n\n${arg}\n`;
      await putFile(path, updated, sha, `blog: append to ${slug}`);
      console.log(`appended to ${slug}`);
      return;
    }
    default:
      die("commands: list | delete <slug> | set-title <slug> <title> | append <slug> <text>");
  }
}

main().catch((e) => die(String(e)));
