import {
  envSchema,
  type AppConfig,
  type TwitterCredentials,
  type FacebookCredentials,
  type YouTubeCredentials,
  type BlogConfig,
} from "./env.js";

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

  let facebook: FacebookCredentials | undefined;
  if (e.FACEBOOK_PAGE_ID && e.FACEBOOK_PAGE_ACCESS_TOKEN) {
    facebook = {
      pageId: e.FACEBOOK_PAGE_ID,
      pageAccessToken: e.FACEBOOK_PAGE_ACCESS_TOKEN,
      graphVersion: e.FACEBOOK_GRAPH_VERSION,
    };
  } else if (e.FACEBOOK_PAGE_ID || e.FACEBOOK_PAGE_ACCESS_TOKEN) {
    warn(
      "whatsapp hub: partial Facebook credentials — adapter disabled until both FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN are set.",
    );
  }

  let youtube: YouTubeCredentials | undefined;
  if (e.YOUTUBE_CLIENT_ID && e.YOUTUBE_CLIENT_SECRET && e.YOUTUBE_REFRESH_TOKEN) {
    youtube = {
      clientId: e.YOUTUBE_CLIENT_ID,
      clientSecret: e.YOUTUBE_CLIENT_SECRET,
      refreshToken: e.YOUTUBE_REFRESH_TOKEN,
      privacy: e.YOUTUBE_PRIVACY,
    };
  } else if (e.YOUTUBE_CLIENT_ID || e.YOUTUBE_CLIENT_SECRET || e.YOUTUBE_REFRESH_TOKEN) {
    warn(
      "whatsapp hub: partial YouTube credentials — adapter disabled until YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN are all set.",
    );
  }

  let blog: BlogConfig | undefined;
  if (e.BLOG_GITHUB_TOKEN && e.BLOG_REPO) {
    blog = {
      token: e.BLOG_GITHUB_TOKEN,
      repo: e.BLOG_REPO,
      branch: e.BLOG_BRANCH,
      contentDir: e.BLOG_CONTENT_DIR,
      siteUrl: e.BLOG_SITE_URL,
    };
  } else if (e.BLOG_GITHUB_TOKEN || e.BLOG_REPO) {
    warn(
      "whatsapp hub: partial blog credentials — adapter disabled until both BLOG_GITHUB_TOKEN and BLOG_REPO are set.",
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
    facebook,
    youtube,
    blog,
  };
}
