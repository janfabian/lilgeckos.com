import type { ParsedPost } from "./parse.js";

/**
 * Resolve which platforms to publish to:
 * - If the message named platforms (parsed.targets ∩ enabled is non-empty) → those.
 * - Otherwise → all enabled platforms.
 */
export function resolveTargets(parsed: ParsedPost, enabled: string[]): string[] {
  const enabledSet = new Set(enabled);
  const named = parsed.targets.filter((t) => enabledSet.has(t));
  return named.length > 0 ? [...new Set(named)] : [...enabled];
}
