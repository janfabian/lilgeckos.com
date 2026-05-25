// Diagnostic: which account the .env token is for, and its access level.
// Read-only. x-access-level header = "read" | "read-write" | "read-write-directmessages".
import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

const k = process.env;
const client = new TwitterApi({
  appKey: k.TWITTER_API_KEY ?? "",
  appSecret: k.TWITTER_API_SECRET ?? "",
  accessToken: k.TWITTER_ACCESS_TOKEN ?? "",
  accessSecret: k.TWITTER_ACCESS_SECRET ?? "",
});

console.log("API key in use: " + (k.TWITTER_API_KEY ?? "").slice(0, 8) + "…");

// v1.1 — works for ANY valid app (does NOT require a Project)
try {
  const resp = await client.v1.get(
    "account/verify_credentials.json",
    {},
    { fullResponse: true },
  );
  const data = resp.data as { screen_name?: string };
  console.log("[v1.1 verify_credentials] OK — account: @" + (data.screen_name ?? "?") +
    ", access-level: " + (resp.headers["x-access-level"] ?? "?"));
} catch (err) {
  const e = err as { code?: number; data?: unknown; message?: string };
  console.log("[v1.1 verify_credentials] FAIL code=" + e.code + " — " + (e.data ? JSON.stringify(e.data) : e.message));
}

// v2 GET /2/users/me — a READ that the Free tier allows, but it REQUIRES the app
// to be attached to a Project. Same gate as posting, without posting anything.
try {
  const me = await client.v2.me();
  console.log("[v2 users/me] OK — @" + me.data.username + "  ✅ app IS in a Project (v2 works)");
} catch (err) {
  const e = err as { code?: number; data?: { detail?: string }; message?: string };
  console.log("[v2 users/me] FAIL code=" + e.code + " — " + (e.data?.detail ?? e.message));
  console.log("   ^ if this is the 'attached to a Project' 403, the app behind this API key is NOT in a Project.");
}
