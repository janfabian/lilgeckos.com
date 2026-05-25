import { describe, it, expect, vi } from "vitest";
import { loadConfig, ConfigError } from "../index.js";

const base = { HUB_TOKEN: "secret" };

describe("loadConfig", () => {
  it("requires HUB_TOKEN", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("builds the twitter block only when all four creds are present", () => {
    const cfg = loadConfig({
      ...base,
      TWITTER_API_KEY: "k",
      TWITTER_API_SECRET: "s",
      TWITTER_ACCESS_TOKEN: "t",
      TWITTER_ACCESS_SECRET: "ts",
    });
    expect(cfg.twitter).toEqual({
      appKey: "k",
      appSecret: "s",
      accessToken: "t",
      accessSecret: "ts",
    });
  });

  it("warns and leaves twitter undefined on partial creds", () => {
    const warn = vi.fn();
    const cfg = loadConfig({ ...base, TWITTER_API_KEY: "k" }, warn);
    expect(cfg.twitter).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("parses MOCK_ENABLED and defaults port", () => {
    const cfg = loadConfig({ ...base, MOCK_ENABLED: "1" });
    expect(cfg.mockEnabled).toBe(true);
    expect(cfg.port).toBe(8137);
  });
});
