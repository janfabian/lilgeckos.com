import { envSchema, type AppConfig, type TwitterCredentials } from "./env.js";

export class ConfigError extends Error {}

/**
 * Parse process.env into a typed AppConfig.
 *
 * - HUB_TOKEN is required (the server refuses to start without auth).
 * - Twitter creds are all-or-nothing: all four present -> twitter block set;
 *   partial -> warn and leave undefined (shows credentialsPresent:false in /platforms).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (m) => console.warn(m),
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;

  if (!e.HUB_TOKEN) {
    throw new ConfigError(
      "HUB_TOKEN is required. Set it in .env to a long random secret; callers send it as Authorization: Bearer <HUB_TOKEN>.",
    );
  }

  const twitterParts = {
    appKey: e.TWITTER_API_KEY,
    appSecret: e.TWITTER_API_SECRET,
    accessToken: e.TWITTER_ACCESS_TOKEN,
    accessSecret: e.TWITTER_ACCESS_SECRET,
  };
  const present = Object.values(twitterParts).filter(Boolean).length;
  let twitter: TwitterCredentials | undefined;
  if (present === 4) {
    twitter = twitterParts as TwitterCredentials;
  } else if (present > 0) {
    warn(
      `whatsapp hub: ${present}/4 Twitter credentials set — Twitter adapter disabled until all four (TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET) are present.`,
    );
  }

  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    hubToken: e.HUB_TOKEN,
    mockEnabled: e.MOCK_ENABLED ?? false,
    mediaMaxBytes: e.MEDIA_MAX_BYTES,
    videoMaxBytes: e.MEDIA_VIDEO_MAX_BYTES,
    twitter,
  };
}
