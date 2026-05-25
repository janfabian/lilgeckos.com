export interface HubMedia {
  path: string;
  kind: "image" | "video";
  altText?: string;
}

export interface HubPost {
  title?: string;
  text: string;
  media?: HubMedia[];
  link?: string;
}

export interface PublishResultRow {
  platform: string;
  ok: boolean;
  url?: string;
  error?: string;
}

export interface PublishResponse {
  results: PublishResultRow[];
  summary: { total: number; succeeded: number; failed: number; partial: boolean };
}

export interface HubOptions {
  base: string; // http://127.0.0.1:8137
  token: string; // HUB_TOKEN
}

/** Call the hub's POST /publish. */
export async function publish(
  opts: HubOptions,
  post: HubPost,
  targets: string[],
): Promise<PublishResponse> {
  const res = await fetch(`${opts.base}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({ post, targets }),
  });
  if (res.status === 401) throw new Error("hub rejected token (401)");
  const json = (await res.json().catch(() => ({}))) as Partial<PublishResponse> & { error?: string };
  if (!res.ok) throw new Error(`hub /publish failed: ${json.error ?? res.status}`);
  return json as PublishResponse;
}

/** Fetch enabled platform ids from the hub. */
export async function enabledPlatforms(opts: HubOptions): Promise<string[]> {
  const res = await fetch(`${opts.base}/platforms`);
  const json = (await res.json()) as { platforms?: Array<{ platform: string }> };
  return (json.platforms ?? []).map((p) => p.platform);
}
