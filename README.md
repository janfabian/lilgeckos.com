# lilgeckos.com — Social Broadcast Hub

A backend HTTP service that takes one post (text + optional media + optional link) and
broadcasts it across social platforms behind a uniform `Publisher` interface. Built one
platform at a time.

A separate process (e.g. a Claude Code session handling WhatsApp) calls this hub's API; the
hub does not connect to WhatsApp itself.

## Status

Increment 1 (in progress): hub skeleton + Twitter/X adapter for **text, text+image, and links**.
Video, then Facebook / Instagram / YouTube, land in later increments.

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

## Media file lifecycle

Callers pass **absolute local file paths** for media. The hub reads but **never deletes** those
files — the caller owns their lifecycle.
