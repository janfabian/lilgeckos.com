/**
 * Mint (or re-mint) a YouTube OAuth2 refresh token and write it into .env.
 *
 * Why this exists: while the Google app stays in "Testing" publishing status,
 * refresh tokens expire after ~7 days. When an upload starts failing with an
 * auth error, just run this again — it's the whole re-mint in one command.
 *
 *   bun run youtube:refresh      # mint + write .env + restart the hub
 *   bun run auth:youtube         # just mint + write .env
 *
 * Flow: it prints a consent URL. Open it signed in as the channel's Google
 * account, approve, and your browser lands on a localhost page that won't load
 * (nothing is listening there if you're on a different machine — that's fine).
 * Copy the full address-bar URL (it contains ?code=...) and paste it back here.
 * If you happen to run this on the same machine as the browser, the local
 * listener catches the redirect automatically and you don't paste anything.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { OAuth2Client } from "google-auth-library";

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const PORT = Number(process.env.YOUTUBE_AUTH_PORT || 4180);
const redirectUri = `http://localhost:${PORT}`;
const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
const scope = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope });

const ENV_PATH = resolve(process.cwd(), ".env");

/** Pull an auth code out of a pasted full redirect URL, a "?code=..." fragment, or a raw code. */
function extractCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const c = new URL(s).searchParams.get("code");
    if (c) return c;
  } catch {
    /* not a URL — fall through */
  }
  const m = s.match(/[?&]code=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return s; // assume they pasted the bare code
}

/** Upsert KEY=value in .env, preserving everything else. */
function writeEnvVar(key: string, value: string): void {
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) {
    body = body.replace(re, line);
  } else {
    body = body.replace(/\s*$/, "") + `\n${line}\n`;
  }
  writeFileSync(ENV_PATH, body);
}

let done = false;
async function finish(code: string): Promise<void> {
  if (done) return;
  done = true;
  try {
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      console.error(
        "\n⚠️  No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and re-run (prompt=consent is set).",
      );
      process.exit(1);
    }
    writeEnvVar("YOUTUBE_REFRESH_TOKEN", tokens.refresh_token);
    console.log(`\n✅ Wrote YOUTUBE_REFRESH_TOKEN to ${ENV_PATH} (value not printed).`);
    console.log("   Restart the hub to load it (or use `bun run youtube:refresh`, which does that for you).");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Token exchange failed:", err instanceof Error ? err.message : err);
    console.error("   Auth codes expire within minutes — re-run and paste a fresh one.");
    process.exit(1);
  }
}

// 1) Local listener — used automatically if the browser is on this machine.
const server = createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", redirectUri).searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing ?code");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<h2>Authorized — you can close this tab.</h2>");
  server.close();
  await finish(code);
});
server.listen(PORT);

console.log("\n1) Open this URL, signed in as the lilgeckos channel's Google account:\n");
console.log(url + "\n");
console.log('2) Approve (click through "unverified app → Continue" if shown).');
console.log("3) Your browser lands on a localhost page that won't load — that's expected.");
console.log("   Copy the FULL address-bar URL (it has ?code=...) and paste it below.\n");

// 2) Paste fallback — for when the hub/server is a different machine than the browser.
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste the redirected URL (or code) here: ", async (answer) => {
  rl.close();
  const code = extractCode(answer);
  if (!code) {
    console.error("No code found in what you pasted.");
    process.exit(1);
  }
  server.close();
  await finish(code);
});
