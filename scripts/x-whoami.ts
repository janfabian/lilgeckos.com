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

try {
  const resp = await client.v1.get(
    "account/verify_credentials.json",
    {},
    { fullResponse: true },
  );
  const data = resp.data as { screen_name?: string };
  console.log("account: @" + (data.screen_name ?? "?"));
  console.log("x-access-level:", resp.headers["x-access-level"] ?? "(not present)");
} catch (err) {
  const e = err as { code?: number; data?: unknown; message?: string; headers?: Record<string, string> };
  console.log("verify_credentials error code:", e.code);
  console.log("body:", e.data ? JSON.stringify(e.data) : e.message);
  if (e.headers?.["x-access-level"]) console.log("x-access-level:", e.headers["x-access-level"]);
}
