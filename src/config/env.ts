import { z } from "zod";

const DEFAULT_MEDIA_MAX_BYTES = 15 * 1024 * 1024; // 15MB (images)
const DEFAULT_VIDEO_MAX_BYTES = 512 * 1024 * 1024; // 512MB (X video ceiling)

// Empty env vars (e.g. `MEDIA_MAX_BYTES=` left blank in .env) arrive as "".
// Treat "" as unset so .default()/optional behave; otherwise z.coerce turns
// "" into 0 and trips .positive().
const blankToUndef = (v: unknown) => (v === "" ? undefined : v);

export const envSchema = z.object({
  PORT: z.preprocess(blankToUndef, z.coerce.number().int().positive().default(8137)),
  LOG_LEVEL: z.preprocess(
    blankToUndef,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
  HUB_TOKEN: z.preprocess(blankToUndef, z.string().min(1).optional()),
  TWITTER_API_KEY: z.preprocess(blankToUndef, z.string().optional()),
  TWITTER_API_SECRET: z.preprocess(blankToUndef, z.string().optional()),
  TWITTER_ACCESS_TOKEN: z.preprocess(blankToUndef, z.string().optional()),
  TWITTER_ACCESS_SECRET: z.preprocess(blankToUndef, z.string().optional()),
  FACEBOOK_PAGE_ID: z.preprocess(blankToUndef, z.string().optional()),
  FACEBOOK_PAGE_ACCESS_TOKEN: z.preprocess(blankToUndef, z.string().optional()),
  FACEBOOK_GRAPH_VERSION: z.preprocess(blankToUndef, z.string().default("v21.0")),
  // Instagram (Graph API via Facebook Login): the IG Business account id linked
  // to the Page. Publishing reuses the Facebook Page access token + graph
  // version. Enabled when this + FACEBOOK_PAGE_ACCESS_TOKEN are set.
  INSTAGRAM_BUSINESS_ACCOUNT_ID: z.preprocess(blankToUndef, z.string().optional()),
  // Blog adapter — publishes markdown posts to the Astro site (site/) via the
  // GitHub Contents API. Enabled when both token and repo are present.
  YOUTUBE_CLIENT_ID: z.preprocess(blankToUndef, z.string().optional()),
  YOUTUBE_CLIENT_SECRET: z.preprocess(blankToUndef, z.string().optional()),
  YOUTUBE_REFRESH_TOKEN: z.preprocess(blankToUndef, z.string().optional()),
  YOUTUBE_PRIVACY: z.preprocess(blankToUndef, z.enum(['public', 'unlisted', 'private']).default('public')),
  BLOG_GITHUB_TOKEN: z.preprocess(blankToUndef, z.string().optional()),
  BLOG_REPO: z.preprocess(blankToUndef, z.string().optional()),
  BLOG_BRANCH: z.preprocess(blankToUndef, z.string().default("main")),
  BLOG_CONTENT_DIR: z.preprocess(blankToUndef, z.string().default("site/src/content/blog")),
  BLOG_SITE_URL: z.preprocess(
    blankToUndef,
    z.string().default("https://janfabian.github.io/lilgeckos.com"),
  ),
  MOCK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  MEDIA_MAX_BYTES: z.preprocess(
    blankToUndef,
    z.coerce.number().int().positive().default(DEFAULT_MEDIA_MAX_BYTES),
  ),
  MEDIA_VIDEO_MAX_BYTES: z.preprocess(
    blankToUndef,
    z.coerce.number().int().positive().default(DEFAULT_VIDEO_MAX_BYTES),
  ),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface TwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export interface AppConfig {
  port: number;
  logLevel: RawEnv["LOG_LEVEL"];
  /** Bearer token required on POST /publish. Required to start the server. */
  hubToken: string;
  mockEnabled: boolean;
  mediaMaxBytes: number;
  videoMaxBytes: number;
  /** Present only when all four X credentials are set. */
  twitter?: TwitterCredentials;
  /** Present only when both Facebook page id + token are set. */
  facebook?: FacebookCredentials;
  /** Present only when INSTAGRAM_BUSINESS_ACCOUNT_ID + FACEBOOK_PAGE_ACCESS_TOKEN are set. */
  instagram?: InstagramCredentials;
  /** Present only when YouTube OAuth client id/secret/refresh token are all set. */
  youtube?: YouTubeCredentials;
  /** Present only when both BLOG_GITHUB_TOKEN and BLOG_REPO are set. */
  blog?: BlogConfig;
}

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  privacy: 'public' | 'unlisted' | 'private';
}

export interface FacebookCredentials {
  pageId: string;
  pageAccessToken: string;
  graphVersion: string;
}

export interface InstagramCredentials {
  /** instagram_business_account id, discovered from the linked Page. */
  igUserId: string;
  /** Reuses the Facebook Page access token (Facebook-Login publishing path). */
  accessToken: string;
  graphVersion: string;
}

export interface BlogConfig {
  /** Fine-grained PAT scoped to the blog repo with Contents: write. */
  token: string;
  /** "owner/name", e.g. "janfabian/lilgeckos.com". */
  repo: string;
  /** Branch to commit posts to (triggers the Pages deploy). */
  branch: string;
  /** Repo-relative dir for post markdown, e.g. "site/src/content/blog". */
  contentDir: string;
  /** Public site origin (+ base path) used to build post permalinks. */
  siteUrl: string;
}
