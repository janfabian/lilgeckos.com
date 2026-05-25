import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { MediaItem } from "./types.js";

export type MediaValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validate a media item before any upload:
 *  - path must be absolute (we never resolve against cwd — caller passes real paths)
 *  - file must exist and be a regular file
 *  - size must be within maxBytes
 *
 * Because /publish is synchronous, this runs in-request; the file is read moments
 * later in the same request, so there is no "file deleted before a background job"
 * race. The hub never deletes caller files.
 */
export function validateMedia(item: MediaItem, maxBytes: number): MediaValidation {
  if (!item.path || !isAbsolute(item.path)) {
    return { ok: false, reason: `media path must be absolute: ${item.path || "(empty)"}` };
  }
  let stat;
  try {
    stat = statSync(item.path);
  } catch {
    return { ok: false, reason: `media file not found: ${item.path}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `media path is not a regular file: ${item.path}` };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      reason: `media file too large: ${stat.size} bytes > ${maxBytes} limit (${item.path})`,
    };
  }
  return { ok: true };
}
