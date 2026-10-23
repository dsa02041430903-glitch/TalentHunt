# Deploying TalentHunt

A single Node process with no database and no build step. It serves the page and the API on one port (default 4100).

## What you need

| Variable | Required | Purpose |
|---|---|---|
| `SERPER_API_KEY` | yes | Search and profile photos (serper.dev) |
| `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` | at least one | JD analysis, match scoring, finding more candidates |
| `APP_PASSWORD` | **yes in production** | Everyone opening the site is asked for it. The server refuses to start in production without it, because every search spends paid credits |
| `TRUST_PROXY=true` | behind a proxy | Use the real client address for rate limits |
| `PORT` | no | Default 4100 (hosts like Render set it for you) |

Node 20.12 or newer (22 recommended). Copy `.env.example` to `.env` for local or server use.

## Option A: Docker

```bash
docker build -t talenthunt .
docker run -d --name talenthunt -p 4100:4100 --restart unless-stopped \
  -e SERPER_API_KEY=... -e GEMINI_API_KEY=... -e APP_PASSWORD=... talenthunt
```

## Option B: a Linux server with pm2 and nginx

```bash
git clone <repo> talenthunt && cd talenthunt
cp .env.example .env        # fill in the keys and APP_PASSWORD
npm ci --omit=dev
pm2 start ecosystem.config.cjs && pm2 save
```

Put `deploy/nginx.conf` inside your TLS server block. Keep `proxy_buffering off`, because search progress is streamed.

## Option C: Render

1. New > Blueprint, pick this repo (it reads `render.yaml`).
2. Enter `SERPER_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` when asked. `APP_PASSWORD` is generated for you (Environment tab).
3. The free plan sleeps when idle and wakes slowly. Use a paid plan for daily use.

## After deploying

- Open `/health`: it should answer `{"status":"ok"}` without asking for the password.
- Open the site: the browser asks for the password.
- Run one search and check that the progress line updates while it runs (streaming works through your proxy).

## Things to know

- **No data lives on the server.** Results, reviewed marks, removed people and settings are saved in each recruiter's own browser, so they are not shared between people or devices. Restarting or redeploying loses nothing.
- **Credits.** A hard search can use up to about 10 search calls plus several AI calls, and each profile photo is 1 search call. Set spend limits in the Serper and AI provider dashboards.
- **Rate limit.** 120 API calls per client per minute by default (`RATE_LIMIT_PER_MIN`).
- **Rotate keys** that were ever pasted into chat or email.
- Several instances can run side by side. The only per-instance memory is a small photo cache.
