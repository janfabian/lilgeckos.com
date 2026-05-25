/**
 * X (Twitter) admin helper — delete a published tweet via twitter-api-v2 using
 * the same OAuth 1.0a creds as the publisher. One stable command so it can be
 * narrowly allow-listed in .claude/settings.json:
 *
 *   "Bash(bun run x:admin:*)"
 *
 * Usage:
 *   bun run x:admin delete <tweet-id>
 *
 * Note: the X API has NO edit endpoint (tweet editing is a consumer-Premium-only
 * feature). To "edit" a post, delete it and publish a new one.
 */
import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const k = process.env;
for (const v of ["TWITTER_API_KEY", "TWITTER_API_SECRET", "TWITTER_ACCESS_TOKEN", "TWITTER_ACCESS_SECRET"]) {
  if (!k[v]) die(`missing ${v} in .env`);
}

const client = new TwitterApi({
  appKey: k.TWITTER_API_KEY!,
  appSecret: k.TWITTER_API_SECRET!,
  accessToken: k.TWITTER_ACCESS_TOKEN!,
  accessSecret: k.TWITTER_ACCESS_SECRET!,
});

async function main(): Promise<void> {
  const [cmd, id] = process.argv.slice(2);
  switch (cmd) {
    case "delete": {
      if (!id) die("usage: x:admin delete <tweet-id>");
      const res = await client.v2.deleteTweet(id);
      console.log(res.data.deleted ? `deleted tweet ${id}` : `delete returned: ${JSON.stringify(res.data)}`);
      return;
    }
    case "edit":
      die("X has no edit API — delete the tweet and publish a new one instead.");
    default:
      die("commands: delete <tweet-id>   (edit is not supported by the X API)");
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
