#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/github/public-server-monitor}"
COMPOSE_FILE="docker-compose.server.yml"
ENV_FILE=".env"

cd "$REPO_DIR"

# Fail fast if local changes exist on the server checkout.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Server checkout has local changes; refusing to deploy."
  echo "Resolve changes in $REPO_DIR and re-run deploy."
  exit 1
fi

git fetch origin main
git checkout main
git pull --ff-only origin main

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --remove-orphans backend collector cloudflared

echo "Deployment finished successfully at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
