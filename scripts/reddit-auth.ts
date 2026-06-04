/**
 * Mint a Reddit OAuth refresh token + capture the username, and write both
 * to .env. Refresh tokens are permanent until revoked.
 *
 * Prereqs (~3 min, one-time):
 *  - Create an app at https://www.reddit.com/prefs/apps → "create app…" →
 *    type **web app** → name "lilgeckos-hub" (anything) → about URL anything,
 *    **redirect uri exactly** `http://localhost:4182/`.
 *  - Copy the client id (the short string under the app name) into .env as
 *    REDDIT_CLIENT_ID and the **secret** as REDDIT_CLIENT_SECRET.
 *
 * Usage:
 *   REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=... bun run auth:reddit
 *
 * Open the printed URL signed in as the Reddit account that should publish
 * (lilgeckos's Reddit account), approve, and paste the redirected URL back.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env first (from reddit.com/prefs/apps → your web app).");
  process.exit(1);
}

const PORT = Number(process.env.REDDIT_AUTH_PORT || 4182);
const REDIRECT_URI = `http://localhost:${PORT}/`;
const STATE = Math.random().toString(36).slice(2) + Date.now().toString(36);
const SCOPES = ["identity", "submit", "read"];
const USER_AGENT = "lilgeckos-hub-auth/0.1";
const ENV_PATH = resolve(process.cwd(), ".env");

const authUrl =
  `https://www.reddit.com/api/v1/authorize?` +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    state: STATE,
    redirect_uri: REDIRECT_URI,
    duration: "permanent",
    scope: SCOPES.join(" "),
  }).toString();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

function extractCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const c = new URL(s).searchParams.get("code");
    if (c) return c;
  } catch {
    /* not a URL */
  }
  const m = s.match(/[?&]code=([^&\s]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return s;
}

function writeEnvVar(key: string, value: string): void {
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  body = re.test(body) ? body.replace(re, line) : body.replace(/\s*$/, "") + `\n${line}\n`;
  writeFileSync(ENV_PATH, body);
}

let done = false;
async function finish(code: string): Promise<void> {
  if (done) return;
  done = true;
  try {
    const basic = Buffer.from(`${CLIENT_ID!}:${CLIENT_SECRET!}`).toString("base64");
    const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
    });
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
    if (!tokenRes.ok || !tokenJson.refresh_token) {
      console.error(`\n❌ Token exchange failed (${tokenRes.status}): ${tokenJson.error ?? "no refresh_token"}`);
      console.error("   Auth codes expire fast — re-run and paste a fresh URL.");
      process.exit(1);
    }
    const meRes = await fetch("https://oauth.reddit.com/api/v1/me", {
      headers: { Authorization: `bearer ${tokenJson.access_token}`, "User-Agent": USER_AGENT },
    });
    const me = (await meRes.json().catch(() => ({}))) as { name?: string };
    if (!me.name) {
      console.error("Could not read Reddit username from /api/v1/me.");
      process.exit(1);
    }
    writeEnvVar("REDDIT_REFRESH_TOKEN", tokenJson.refresh_token);
    writeEnvVar("REDDIT_USERNAME", me.name);
    console.log(`\n✅ Wrote REDDIT_REFRESH_TOKEN + REDDIT_USERNAME (=${me.name}) to ${ENV_PATH} (token not printed).`);
    console.log(`   Default subreddit: u_${me.name} (your profile sub — always safe).`);
    console.log("   To post to a community sub (e.g. r/leopardgeckos), set REDDIT_SUBREDDIT=leopardgeckos in .env.");
    console.log("   Restart the hub:  bun run hub:restart");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", REDIRECT_URI);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code) {
    res.writeHead(400);
    res.end("Missing ?code");
    return;
  }
  if (state !== STATE) {
    res.writeHead(400);
    res.end("State mismatch");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<h2>Authorized — you can close this tab.</h2>");
  server.close();
  await finish(code);
});
server.listen(PORT);

console.log("\n1) Open this URL signed in as the Reddit account that should publish:\n");
console.log(authUrl + "\n");
console.log("2) Approve the permissions (identity + submit + read).");
console.log("3) Your browser lands on a localhost page that won't load — expected.");
console.log("   Copy the FULL address-bar URL (it contains ?code=... and ?state=...) and paste below.\n");
console.log(`(Reminder: http://localhost:${PORT}/ must be in the app's redirect URI on reddit.com/prefs/apps.)\n`);

ask("Paste the redirected URL (or code) here: ").then(async (answer) => {
  rl.close();
  const code = extractCode(answer);
  if (!code) {
    console.error("No code found.");
    process.exit(1);
  }
  server.close();
  await finish(code);
});
