# server-monitor

Public-facing, portfolio-friendly server monitoring stack.

This project exposes a **sanitized FastAPI endpoint** in front of Glances so the public frontend never talks directly to the raw collector API.

## Stack

- Collector: Glances (`/api/4/all`)
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
  - Docker container `name`, `status`, `cpu_percent`, `memory_mb`, `memory_percent`
  - Optional Minecraft status (`online`, player count, latency) when configured
- Everything else from raw Glances payload is discarded.

  ## Zero-trust hardening defaults

  - Backend runs as a non-root user in the container image.
  - Compose services use:
    - `read_only: true`
    - `cap_drop: [ALL]`
    - `security_opt: [no-new-privileges:true]`
    - `tmpfs: [/tmp]`
  - Collector does not mount Docker socket directly. It connects to a locked-down socket proxy (`tecnativa/docker-socket-proxy`) with read-only API permissions.
  - Output sanitization strips private IPv4 addresses, UUID-like values, and absolute paths from exposed string fields before JSON is sent to frontend.

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
    { "name": "frontend", "status": "running", "cpu_percent": 0.1, "memory_mb": 142, "memory_percent": 0.9 },
    { "name": "backend", "status": "running", "cpu_percent": 0.4, "memory_mb": 96, "memory_percent": 0.6 }
  ],
  "minecraft": { "online": true, "players_online": 3, "players_max": 20, "latency_ms": 34 },
  "system_health": "All Systems Nominal",
  "last_updated": "2026-03-24T18:17:31.800000Z"
}
```

## Environment variables

Root `.env`:

- `GLANCES_BASE_URL` default `http://collector:61208`
- `GLANCES_ENDPOINT` default `/api/4/all`
- `REQUEST_TIMEOUT_SECONDS` default `3`
- `CACHE_TTL_SECONDS` default `5`
- `ALLOWED_ORIGINS` default `http://localhost:3000`
- `MINECRAFT_HOST` optional Minecraft host/IP
- `MINECRAFT_PORT` default `25565`
- `MINECRAFT_TIMEOUT_SECONDS` default `2.5`
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
docker exec -it server-monitor-backend python -c "import urllib.request; print(urllib.request.urlopen('http://collector:61208/api/4/all', timeout=3).status)"
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

## Auto deploy on push (secure SSH)

Workflow file: `.github/workflows/deploy-server.yml`

This workflow runs when backend/server deployment files change on `main`, then SSHes into your server and executes `scripts/deploy-server.sh`.

1. Create a dedicated deploy keypair on your local machine:

```bash
ssh-keygen -t ed25519 -f ./deploy_key -C "github-actions-deploy"
```

2. Add `deploy_key.pub` to your server user:

```bash
mkdir -p ~/.ssh
cat deploy_key.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

3. Capture your server host key for pinning:

```bash
ssh-keyscan -H your.server.host
```

4. In GitHub repository secrets, add:

- `DEPLOY_SSH_PRIVATE_KEY`: contents of `deploy_key`
- `DEPLOY_SSH_KNOWN_HOSTS`: one line output from `ssh-keyscan -H your.server.host`
- `DEPLOY_USER`: SSH username on server
- `DEPLOY_HOST`: server hostname or IP
- `DEPLOY_PORT`: SSH port (optional, defaults to `22`)
- `DEPLOY_PATH`: absolute path to repo on server, for example `/home/evan/github/public-server-monitor`

5. Push to `main` and watch Actions tab for `Deploy Server Stack`.

Security notes:

- Use a dedicated, least-privilege deploy user.
- Keep deploy key unique to this repo and rotate if exposed.
- Do not disable host key checking; use `DEPLOY_SSH_KNOWN_HOSTS` pinning.
- Protect `main` with required pull request reviews so untrusted code cannot trigger production deploy.
- Restrict who can approve and merge to `main`.

### Public repo safety with on-push deploy

Keeping this repository public is safe if write access is tightly controlled.

- Public users can read and fork, but cannot push to your `main` branch unless explicitly granted write access.
- The deploy workflow only runs on push to `main` (not on pull_request), so forked PRs cannot access deploy secrets.
- Use GitHub environment protection rules for `production-server` (required reviewers) to gate deployments.
