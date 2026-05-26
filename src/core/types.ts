// Domain model for the broadcast hub. Platform adapters depend only on these types.

export type PlatformId = "twitter" | "facebook" | "instagram" | "youtube" | "blog" | "mock";

export type MediaKind = "image" | "video";

export interface MediaItem {
  /** Absolute local path the caller (e.g. WhatsApp bridge) already downloaded the file to. */
  path: string;
  kind: MediaKind;
  /** Optional MIME hint; adapters may also sniff from the extension. */
  mimeType?: string;
  /** Optional alt text (X supports alt text on images). */
  altText?: string;
}

export interface Post {
  /**
   * Optional title. Used by the blog adapter as the post title; platforms that
   * have no title concept (X) ignore it. When absent, the blog adapter derives
   * a title from the first line of `text`.
   */
  title?: string;
  /** Main body text. For X, links live inside this text. */
  text: string;
  /** Optional media. X (increment 1): up to 4 images. Video is rejected until increment 1.5. */
  media?: MediaItem[];
  /** Optional link; adapters that have no link object (X) append it into the text. */
  link?: string;
  /**
   * Optional per-language translations, produced by the caller at creation time
   * (the hub does not translate). The blog adapter publishes each as a linked
   * language version; platforms without i18n (X) ignore this.
   */
  translations?: { cs?: PostTranslation };
}

export interface PostTranslation {
  title?: string;
  text: string;
}

export type ErrorCode =
  | "auth"
  | "rate_limit"
  | "validation"
  | "media_upload"
  | "network"
  | "unsupported"
  | "unknown";

/** Per-platform outcome of a single publish attempt. Adapters never throw — they resolve this. */
export interface PublishResult {
  platform: PlatformId;
  ok: boolean;
  /** Platform-native id on success (e.g. tweet id). */
  postId?: string;
  /** Permalink to the published post if derivable. */
  url?: string;
  error?: string;
  errorCode?: ErrorCode;
  /** Wall-clock duration of the attempt in ms. */
  durationMs: number;
}

/** Credential/health snapshot for GET /platforms. */
export interface PlatformStatus {
  platform: PlatformId;
  enabled: boolean;
  /** Required credentials present and well-formed at boot. */
  credentialsPresent: boolean;
  /** Best-effort live probe. undefined = could not determine (e.g. reads restricted). */
  healthy?: boolean;
  detail?: string;
}

/** Aggregate of a fan-out across one or more platforms. */
export interface PublishSummary {
  total: number;
  succeeded: number;
  failed: number;
  /** true when some platforms succeeded and some failed. */
  partial: boolean;
}
