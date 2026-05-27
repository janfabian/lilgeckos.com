/**
 * Mint a long-lived Facebook Page access token + Page id and write them to .env.
 *
 * The hub posts to a Page (not a Group — Meta removed Group publishing). You
 * need to be an admin of at least one Page.
 *
 * Prereqs:
 *  - A Meta app: developers.facebook.com → Create App → "Business".
 *  - Add the "Facebook Login" product; under its settings add this exact value
 *    to "Valid OAuth Redirect URIs":   http://localhost:4181/
 *  - Keep the app in Development mode — as an app admin you can post to your own
 *    Page without App Review (no demo-video circus).
 *  - From the app's Settings → Basic, grab the App ID + App Secret.
 *
 * Usage:
 *   FACEBOOK_APP_ID=... FACEBOOK_APP_SECRET=... bun run auth:facebook
 *
 * Open the printed URL signed in as the Page admin, approve. Your browser lands
 * on a localhost page that won't load (expected) — copy the full address-bar
 * URL (it has ?code=...) and paste it back. Pick your Page if you manage more
 * than one. It writes FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN to .env
 * (token never printed). A Page token derived from a long-lived user token does
 * not expire — set once and done.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const APP_ID = process.env.FACEBOOK_APP_ID;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET;
if (!APP_ID || !APP_SECRET) {
  console.error(
    "Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env first (Meta app → Settings → Basic).",
  );
  process.exit(1);
}

const VERSION = process.env.FACEBOOK_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const DIALOG = `https://www.facebook.com/${VERSION}/dialog/oauth`;
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  // Instagram (Facebook-Login publishing path) — needs these two added under
  // the app's use case → Permissions, else the dialog throws "Invalid Scopes".
  "instagram_basic",
  "instagram_content_publish",
];

const PORT = Number(process.env.FACEBOOK_AUTH_PORT || 4181);
const redirectUri = `http://localhost:${PORT}/`;
const ENV_PATH = resolve(process.cwd(), ".env");

const authUrl =
  `${DIALOG}?` +
  new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri,
    scope: SCOPES.join(","),
    response_type: "code",
  }).toString();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

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
  if (m?.[1]) return decodeURIComponent(m[1]);
  return s; // assume they pasted the bare code
}

/** Upsert KEY=value in .env, preserving everything else. */
function writeEnvVar(key: string, value: string): void {
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  body = re.test(body) ? body.replace(re, line) : body.replace(/\s*$/, "") + `\n${line}\n`;
  writeFileSync(ENV_PATH, body);
}

/** GET a Graph endpoint, throwing the API's error message on failure. */
async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${GRAPH}/${path}?` + new URLSearchParams(params).toString());
  const json = (await res.json()) as any;
  if (!res.ok || json?.error) {
    throw new Error(json?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return json;
}

let done = false;
async function finish(code: string): Promise<void> {
  if (done) return;
  done = true;
  try {
    // 1) code -> short-lived user token
    const short = await graphGet("oauth/access_token", {
      client_id: APP_ID!,
      redirect_uri: redirectUri,
      client_secret: APP_SECRET!,
      code,
    });
    // 2) short -> long-lived user token (~60 days)
    const long = await graphGet("oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: APP_ID!,
      client_secret: APP_SECRET!,
      fb_exchange_token: short.access_token,
    });
    // 3) Pages this user manages. A page token from a long-lived user token is
    //    itself long-lived (effectively non-expiring).
    const accounts = await graphGet("me/accounts", {
      access_token: long.access_token,
      fields: "id,name,access_token,tasks",
    });
    const pages: any[] = accounts.data ?? [];
    if (pages.length === 0) {
      console.error(
        "\n❌ No Pages found for this account. You must be an admin of a Facebook Page (Groups aren't supported).",
      );
      process.exit(1);
    }

    let page = pages[0];
    if (pages.length > 1) {
      console.log("\nPages you manage:");
      pages.forEach((p, i) => console.log(`  [${i + 1}] ${p.name}  (id ${p.id})`));
      const idx = Number((await ask(`Pick a page [1-${pages.length}]: `)).trim()) - 1;
      if (!(idx >= 0 && idx < pages.length)) {
        console.error("Invalid choice.");
        process.exit(1);
      }
      page = pages[idx];
    }

    writeEnvVar("FACEBOOK_PAGE_ID", String(page.id));
    writeEnvVar("FACEBOOK_PAGE_ACCESS_TOKEN", String(page.access_token));
    console.log(
      `\n✅ Wrote FACEBOOK_PAGE_ID (${page.id}) and FACEBOOK_PAGE_ACCESS_TOKEN to ${ENV_PATH} (token not printed).`,
    );
    console.log(`   Page: ${page.name}`);

    // Discover the linked Instagram Business account (needs instagram_basic, now requested).
    try {
      const ig = await graphGet(String(page.id), {
        fields: "instagram_business_account{id,username}",
        access_token: String(page.access_token),
      });
      const iga = ig?.instagram_business_account;
      if (iga?.id) {
        writeEnvVar("INSTAGRAM_BUSINESS_ACCOUNT_ID", String(iga.id));
        console.log(
          `   📸 Instagram linked: @${iga.username ?? "?"} (id ${iga.id}) → wrote INSTAGRAM_BUSINESS_ACCOUNT_ID.`,
        );
      } else {
        console.log(
          "   ⚠️  No Instagram Business account is linked to this Page. Link a *Business/Creator* IG account to the Page, then re-run.",
        );
      }
    } catch (e) {
      console.log(`   ⚠️  Could not read Instagram link: ${e instanceof Error ? e.message : e}`);
    }
    if (Array.isArray(page.tasks) && !page.tasks.includes("CREATE_CONTENT")) {
      console.log(
        "   ⚠️  This page token may lack CREATE_CONTENT (posting) rights — confirm you're a full admin of the Page.",
      );
    }
    console.log("   Restart the hub to load it:  bun run hub:restart");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Failed:", err instanceof Error ? err.message : err);
    console.error("   Auth codes expire fast — re-run and paste a fresh redirect URL if needed.");
    process.exit(1);
  }
}

// Local listener — used automatically if the browser is on this machine.
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

console.log("\n1) Open this URL, signed in as the Facebook account that administers the Page:\n");
console.log(authUrl + "\n");
console.log("2) Approve the requested permissions.");
console.log("3) Your browser lands on a localhost page that won't load — that's expected.");
console.log("   Copy the FULL address-bar URL (it has ?code=...) and paste it below.\n");
console.log(`(Reminder: http://localhost:${PORT}/ must be in the app's Valid OAuth Redirect URIs.)\n`);

// Paste fallback — for when the hub/server is a different machine than the browser.
ask("Paste the redirected URL (or code) here: ").then(async (answer) => {
  const code = extractCode(answer);
  if (!code) {
    console.error("No code found in what you pasted.");
    process.exit(1);
  }
  server.close();
  await finish(code);
});
