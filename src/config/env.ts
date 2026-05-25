import { z } from "zod";

const DEFAULT_MEDIA_MAX_BYTES = 15 * 1024 * 1024; // 15MB

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8137),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HUB_TOKEN: z.string().min(1).optional(),
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_SECRET: z.string().optional(),
  MOCK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(DEFAULT_MEDIA_MAX_BYTES),
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
  /** Present only when all four X credentials are set. */
  twitter?: TwitterCredentials;
}
