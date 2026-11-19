#!/usr/bin/env bash
# Ejecuta pm2 como el usuario sin privilegios que corre worker-publish y el
# control server. Úsalo en lugar de `pm2 …` / `npm run native:*` desde root, p. ej.
# en down_github.sh:
#   ./scripts/pm2-publisher.sh restart tamaya-worker-publish tamaya-worker-control
#   ./scripts/pm2-publisher.sh save
#   ./scripts/pm2-publisher.sh start apps/worker-publish/ecosystem.config.cjs   (primer arranque)
set -euo pipefail
USER_NAME="${TAMAYA_PUBLISHER_USER:-tamaya}"
ENV_FILE="${TAMAYA_ENV_FILE:-/etc/tamaya/worker-publish.env}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || { echo "No existe el usuario $USER_NAME" >&2; exit 1; }

# Si ya somos ese usuario no hace falta cambiar.
if [ "$(id -un)" = "$USER_NAME" ]; then RUN=(env); else RUN=(runuser -u "$USER_NAME" -- env); fi
cd "$ROOT/apps/worker-publish"
exec "${RUN[@]}" HOME="$HOME_DIR" PM2_HOME="$HOME_DIR/.pm2" TAMAYA_ENV_FILE="$ENV_FILE" \
  "$ROOT/node_modules/.bin/pm2" "$@"
