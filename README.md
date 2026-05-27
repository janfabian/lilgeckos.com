# lilgeckos.com — Social Broadcast Hub

A backend HTTP service that takes one post (text + optional media + optional link) and
broadcasts it across social platforms behind a uniform `Publisher` interface. Built one
platform at a time.

A separate process (e.g. a Claude Code session handling WhatsApp) calls this hub's API; the
hub does not connect to WhatsApp itself.

## Status

**Twitter/X** supports text, image (≤4), video (1), and links. **Facebook Page** (Meta Graph
API) supports text, link, single/multiple images, and video. **YouTube** uploads a video via the
Data API v3 (OAuth2) as a **Short** — vertical source + #Shorts; YouTube transcodes the file, so
no ffmpeg needed. Instagram lands in a later increment.

**Video handling across blog + YouTube:** when a single `/publish` targets both `youtube`
and `blog`, the hub uploads to YouTube **first** and the blog embeds the resulting Short
(iframe) instead of committing the raw `.mp4` — keeping videos out of the git repo and clear
of GitHub Pages size/bandwidth limits. If YouTube isn't a target (or fails), the blog
self-hosts the video as before. Orchestration detail lives in `src/core/orchestrator.ts`
(YouTube runs before the concurrent fan-out, threading its id via `PublishContext`).

## API

- `GET /health` — liveness, no auth.
- `GET /platforms[?check=true]` — configured adapters + credential status; `?check` does a
  best-effort live probe.
- `POST /publish` — **requires `Authorization: Bearer <HUB_TOKEN>`**. Synchronous: publishes to
  the requested (or all enabled) platforms and returns per-platform results.

The server binds to `127.0.0.1` only.

## Run

```bash
bun install
cp .env.example .env   # fill in HUB_TOKEN + Twitter credentials
bun run dev            # or: npx tsx watch src/index.ts
```

## Posting as a different account than your developer account

The app (API Key/Secret) can live under one account (e.g. `@howlpack`) while posting as
another (e.g. `@lilgeckos`). The Access Token/Secret decide *who* it posts as.

One-time, in the app's **User authentication settings**: enable OAuth 1.0a, set permissions
to **Read and Write**, add a callback URL (`http://localhost/` is fine).

Then mint the target account's tokens with the PIN flow:

```bash
# with the app's consumer keys in .env (TWITTER_API_KEY / TWITTER_API_SECRET):
bun run auth:x
```

Open the printed URL **while logged in as the account you want to post as**, authorize, paste
the PIN. The script prints `TWITTER_ACCESS_TOKEN` / `TWITTER_ACCESS_SECRET` for that account —
put them in `.env`. Leave the API Key/Secret as the app's consumer keys.

## Level-2 subscriber (hands-free WhatsApp → post)

`src/subscriber/` is a standalone daemon that turns WhatsApp messages into posts
with no Claude Code session in the loop:

```
bridge WS → parse via `claude -p` (your subscription) → propose draft in WhatsApp → "go" → POST /publish
```

- **LLM parse** uses the `claude` CLI in headless mode, billed to your Claude
  subscription via `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Keep
  `ANTHROPIC_API_KEY` unset or it bills API credits instead.
- **Routing**: the LLM picks targets the message names; if none are named, it
  fans out to all enabled platforms.
- **Propose-then-confirm**: the subscriber replies with the parsed draft and
  publishes only after you reply `go` (`no` cancels).

Run it (hub must be running first):
```bash
claude setup-token                       # once: prints the OAuth token
# put CLAUDE_CODE_OAUTH_TOKEN + SUBSCRIBER_CHATS in .env (HUB_TOKEN already set)
bun run subscriber
```

## Media file lifecycle

Callers pass **absolute local file paths** for media. The hub reads but **never deletes** those
files — the caller owns their lifecycle.
