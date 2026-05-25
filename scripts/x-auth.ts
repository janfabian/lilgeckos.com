/**
 * One-time helper: mint a Twitter/X Access Token + Secret for the account you
 * want the hub to POST AS — which can be DIFFERENT from the developer account
 * that owns the app.
 *
 * Mental model:
 *   - API Key/Secret (consumer keys)  -> identify the APP (e.g. @howlpack's app)
 *   - Access Token/Secret             -> identify WHO it posts as (e.g. @lilgeckos)
 *
 * Prereq (once, in the app that owns the consumer keys):
 *   Developer Portal -> app -> User authentication settings -> enable OAuth 1.0a,
 *   App permissions = Read and Write, add a callback URL (http://localhost/ is fine).
 *
 * Usage:
 *   TWITTER_API_KEY=... TWITTER_API_SECRET=... bun run auth:x
 *   (or put those two in .env, then: bun run auth:x)
 *
 * Then: open the printed URL WHILE LOGGED IN AS THE TARGET ACCOUNT (@lilgeckos),
 * click Authorize, copy the PIN, paste it here. The script prints the
 * TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_SECRET to put in .env.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TwitterApi } from "twitter-api-v2";

async function main(): Promise<void> {
  const appKey = process.env.TWITTER_API_KEY;
  const appSecret = process.env.TWITTER_API_SECRET;
  if (!appKey || !appSecret) {
    console.error(
      "Set TWITTER_API_KEY and TWITTER_API_SECRET (the app's consumer keys) first.",
    );
    process.exit(1);
  }

  const client = new TwitterApi({ appKey, appSecret });

  // 'oob' = PIN-based out-of-band flow; authAccessType 'write' requests write scope.
  const authLink = await client.generateAuthLink("oob", { authAccessType: "write" });

  console.log("\n1. Open this URL in a browser **logged in as the account you want to post AS**:\n");
  console.log("   " + authLink.url + "\n");
  console.log("2. Click Authorize. Twitter shows you a PIN.\n");

  const rl = createInterface({ input: stdin, output: stdout });
  const pin = (await rl.question("3. Paste the PIN here: ")).trim();
  rl.close();

  const tmp = new TwitterApi({
    appKey,
    appSecret,
    accessToken: authLink.oauth_token,
    accessSecret: authLink.oauth_token_secret,
  });

  const { accessToken, accessSecret, screenName } = await tmp.login(pin);

  console.log(`\n✅ Authorized as @${screenName}. Put these in .env:\n`);
  console.log(`TWITTER_ACCESS_TOKEN=${accessToken}`);
  console.log(`TWITTER_ACCESS_SECRET=${accessSecret}\n`);
  console.log("(API Key/Secret stay as the app's consumer keys — don't change them.)");
}

main().catch((err) => {
  console.error("\nAuth failed:", err?.message ?? err);
  console.error(
    "Common causes: app not set to Read+Write, OAuth 1.0a not enabled, no callback URL, or a stale/expired PIN.",
  );
  process.exit(1);
});
