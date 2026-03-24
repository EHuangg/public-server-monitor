# server-monitor

Public-facing, portfolio-friendly server monitoring stack.

This project exposes a **sanitized FastAPI endpoint** in front of Glances so the public frontend never talks directly to the raw collector API.

## Stack

- Collector: Glances (`/api/3/all`)
- Middleware: FastAPI (sanitization + 5 second cache)
- Frontend: Next.js + Tailwind CSS
- Orchestration: Docker Compose
- Public exposure: Cloudflare Tunnel (no router port forwarding)

## Security model

- Glances is only reachable on the internal Docker network.
- Frontend only calls `GET /api/metrics` from middleware via its own Next.js API route.
- Middleware extracts only:
  - `cpu.percent`
  - `mem.percent`
  - `uptime_seconds`
  - Docker container `name` and `status`
- Everything else from raw Glances payload is discarded.

## Quick start

1. Copy environment variables:
```bash
cp .env.example .env
cp frontend/.env.local.example frontend/.env.local
```

2. Start the stack:
```bash
docker compose up --build
```

3. Open dashboard:
- http://localhost:3000

4. Test sanitized backend response (from backend container network path):
```bash
curl http://localhost:3000/api/metrics
```

## API contract

`GET /api/metrics`

```json
{
  "cpu": { "percent": 13.4 },
  "mem": { "percent": 46.2 },
  "uptime_seconds": 123456,
  "docker": [
    { "name": "frontend", "status": "running" },
    { "name": "backend", "status": "running" }
  ],
  "system_health": "All Systems Nominal",
  "last_updated": "2026-03-24T18:17:31.800000Z"
}
```

## Environment variables

Root `.env`:

- `GLANCES_BASE_URL` default `http://collector:61208`
- `GLANCES_ENDPOINT` default `/api/3/all`
- `REQUEST_TIMEOUT_SECONDS` default `3`
- `CACHE_TTL_SECONDS` default `5`
- `ALLOWED_ORIGINS` default `http://localhost:3000`
- `BACKEND_URL` default `http://backend:8000`
- `NEXT_PUBLIC_POLL_INTERVAL_MS` default `5000`

## GitHub repo creation from SSH server

GitHub CLI is ideal:

```bash
git init
git branch -M main
gh repo create server-monitor --public --source . --remote origin --push
```

If `gh` is not installed:

1. Create a new public repo at `https://github.com/new` named `server-monitor`.
2. Run:
```bash
git remote add origin https://github.com/<your-username>/server-monitor.git
git add .
git commit -m "Initial server monitor stack"
git push -u origin main
```

## Vercel + Cloudflare Tunnel deployment pattern

- Deploy Next.js frontend to Vercel subdomain.
- Run `collector` + `backend` on home server via Docker Compose.
- Expose backend through Cloudflare Tunnel on an API subdomain.
- Set frontend environment:
  - `BACKEND_URL` on server-side route handler to your tunnel URL, or
  - Keep `/api/metrics` as route proxy and rewrite destination accordingly.

## Headless server deployment over SSH

Use this when your server has no monitor/desktop.

1. SSH into your server and install Docker + Compose plugin if needed.
2. Clone this repository and enter it.
3. Create server env file:

```bash
cp .env.server.example .env
```

4. Edit `.env` with real values:

- `ALLOWED_ORIGINS` set to your Vercel domain
- `CLOUDFLARE_TUNNEL_TOKEN` set from Cloudflare Zero Trust

5. Start server stack:

```bash
docker compose -f docker-compose.server.yml --env-file .env up -d --build
```

6. Verify services from SSH:

```bash
docker compose -f docker-compose.server.yml ps
docker compose -f docker-compose.server.yml logs -f backend
docker compose -f docker-compose.server.yml logs -f cloudflared
```

7. Test backend and collector from container network:

```bash
docker exec -it server-monitor-backend python -c "import urllib.request; print(urllib.request.urlopen('http://collector:61208/api/3/all', timeout=3).status)"
docker exec -it server-monitor-backend python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).read().decode())"
```

8. In Vercel project settings, set:

- `BACKEND_URL=https://api.your-domain.com`

Then redeploy your frontend.

9. Validate public path from your laptop:

```bash
curl https://api.your-domain.com/api/metrics
```

Only sanitized fields should be present.

## Optional GitHub Action status monitor

Workflow file: `.github/workflows/status-check.yml`

- Add `STATUS_API_URL` repository secret (public tunnel endpoint like `https://status.example.com/api/metrics`).
- Scheduled check runs every 10 minutes and fails when API is unavailable.
