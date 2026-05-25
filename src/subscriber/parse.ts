import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Structured result the LLM extracts from a freeform WhatsApp message. */
export interface ParsedPost {
  /** Platforms explicitly named in the message (subset of allowed). Empty = none named. */
  targets: string[];
  /** Optional title (mainly for the blog). */
  title?: string;
  /** Cleaned post body. */
  text: string;
  /** Hashtags WITHOUT the leading '#'. */
  tags: string[];
}

/** Runs the parse prompt and returns raw stdout. Injectable for tests. */
export type CliRunner = (prompt: string) => Promise<string>;

export interface ParseDeps {
  run?: CliRunner;
}

/**
 * Parse a WhatsApp message into a ParsedPost using the `claude` CLI in headless
 * mode (subscription billing via CLAUDE_CODE_OAUTH_TOKEN; ANTHROPIC_API_KEY must
 * be unset or it bills API credits).
 */
export async function parseMessage(
  message: string,
  allowed: string[],
  deps: ParseDeps = {},
): Promise<ParsedPost> {
  const run = deps.run ?? defaultRunner;
  const raw = await run(buildPrompt(message, allowed));
  return normalizeParsed(raw, allowed);
}

export function buildPrompt(message: string, allowed: string[]): string {
  return [
    "You turn a freeform chat message into a social post spec. Output ONLY one JSON object, no prose.",
    "Schema: {\"targets\": string[], \"title\": string, \"text\": string, \"tags\": string[]}",
    `Allowed platform ids: ${allowed.join(", ")}.`,
    "Rules:",
    "- targets: ONLY platform ids the message explicitly names/mentions (e.g. 'post to the blog', '#x'). If none are named, return an EMPTY array.",
    "- title: a short title (used by the blog). Omit or empty if not applicable.",
    "- text: the post body, lightly cleaned. Keep it human and casual — NOT marketing copy. No rule-of-three, no forced wordplay.",
    "- tags: 1-3 specific, relevant hashtags WITHOUT the '#'. Prefer specific over generic; no near-duplicates. Omit if nothing fits.",
    "",
    `MESSAGE: ${message}`,
  ].join("\n");
}

/** Tolerantly extract the ParsedPost from CLI stdout (handles json envelope or raw JSON). */
export function normalizeParsed(raw: string, allowed: string[]): ParsedPost {
  const obj = extractJson(raw);
  const allowSet = new Set(allowed);
  const targets = asStringArray(obj.targets)
    .map((t) => t.toLowerCase().trim())
    .filter((t) => allowSet.has(t));
  const tags = asStringArray(obj.tags)
    .map((t) => t.replace(/^#+/, "").trim())
    .filter((t) => t.length > 0);
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined;
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  return { targets: [...new Set(targets)], title, text, tags: [...new Set(tags)] };
}

/**
 * Find the post JSON in CLI output. `claude --output-format json` wraps the
 * answer in an envelope ({ result: "..." }); the answer itself is our JSON.
 * Strategy: parse the outer JSON if present and unwrap `result`/`structured_output`,
 * else scan for the first balanced {...} object.
 */
function extractJson(raw: string): Record<string, unknown> {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  const outer = tryParse(raw.trim());
  if (outer) {
    if (outer.structured_output && typeof outer.structured_output === "object") {
      return outer.structured_output as Record<string, unknown>;
    }
    if (typeof outer.result === "string") {
      const inner = firstJsonObject(outer.result);
      if (inner) return inner;
    }
    // already looks like our shape
    if ("text" in outer || "targets" in outer) return outer;
  }
  return firstJsonObject(raw) ?? {};
}

/** Scan for the first balanced top-level {...} and parse it. */
function firstJsonObject(s: string): Record<string, unknown> | undefined {
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Default: call `claude -p` with JSON output, subscription auth, no API key. */
const defaultRunner: CliRunner = async (prompt) => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // force subscription (CLAUDE_CODE_OAUTH_TOKEN)
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--output-format", "json"],
    { env, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
  );
  return stdout;
};
