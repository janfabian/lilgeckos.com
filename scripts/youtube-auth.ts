/**
 * One-time helper: mint a YouTube OAuth2 refresh token for uploads.
 *
 * Prereqs (see the API-key writeup): a Google Cloud project with YouTube Data
 * API v3 enabled, and an OAuth client (type "Desktop app" or "Web") whose
 * Authorized redirect URIs include http://localhost:4180.
 *
 * Usage:
 *   YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... bun run auth:youtube
 *
 * Open the printed URL **logged into the Google account that owns the target
 * YouTube channel**, approve, and the script prints YOUTUBE_REFRESH_TOKEN.
 */
import "dotenv/config";
import { createServer } from "node:http";
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

const server = createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", redirectUri).searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing ?code");
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h2>Authorized — you can close this tab.</h2>");
    if (tokens.refresh_token) {
      console.log("\n✅ Put this in .env:\n\nYOUTUBE_REFRESH_TOKEN=" + tokens.refresh_token + "\n");
    } else {
      console.log("\n⚠️ No refresh_token returned. Revoke prior access at myaccount.google.com/permissions and re-run (prompt=consent is set).");
    }
  } catch (err) {
    res.writeHead(500);
    res.end("Token exchange failed");
    console.error(err);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`Open this URL (logged into the target channel's Google account):\n\n${url}\n\nWaiting for the redirect on ${redirectUri} …`);
});
