#!/usr/bin/env bash
# Genera el fichero de variables MÍNIMO de worker-publish (/etc/tamaya/worker-publish.env)
# a partir del .env del repo, para que el publicador corra con un usuario sin
# acceso al .env completo (claves de AWS, TAMAYA_API_TOKEN, alertas…).
#
# Copia solo las variables que usa el publicador y NUNCA imprime sus valores.
# Ejecutar como root:  sudo ./scripts/publisher-env.sh [usuario] [destino]
set -euo pipefail

USER_NAME="${1:-tamaya}"
DST="${2:-/etc/tamaya/worker-publish.env}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${TAMAYA_SRC_ENV:-$ROOT/.env}"
PM2_BIN="$ROOT/node_modules/.bin/pm2"

[ "$(id -u)" -eq 0 ] || { echo "Ejecuta como root." >&2; exit 1; }
[ -f "$SRC" ] || { echo "No existe $SRC" >&2; exit 1; }
id "$USER_NAME" >/dev/null 2>&1 || { echo "No existe el usuario $USER_NAME (créalo antes)." >&2; exit 1; }
[ -x "$PM2_BIN" ] || { echo "No existe $PM2_BIN (npm install)." >&2; exit 1; }

# Lista cerrada: lo que lee apps/worker-publish + packages/core + packages/db.
ALLOW='^(DATABASE_URL|DATABASE_SSL|REDIS_URL|LOG_LEVEL|TAMAYA_(TENANT_ID|USER_DATA_DIR|USER_AGENT|VIEWPORT_WIDTH|VIEWPORT_HEIGHT|TIMEZONE|LOCALE|HEADLESS|SLOWMO_MS|MIN_DELAY_MS|MAX_DELAY_MS|SEND_WINDOW_START|SEND_WINDOW_END|TMP_DIR|CONTROL_HOST|CONTROL_PORT|CONTROL_TOKEN|PM2_PUBLISH_NAME))='

install -d -m 750 -o root -g "$USER_NAME" "$(dirname "$DST")"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
grep -E "$ALLOW" "$SRC" > "$TMP" || true
# El control server se reinicia a sí mismo con pm2: ruta absoluta, el usuario no tiene el pm2 global de root.
echo "TAMAYA_PM2_BIN=$PM2_BIN" >> "$TMP"
install -m 640 -o root -g "$USER_NAME" "$TMP" "$DST"

echo "Escrito $DST ($(wc -l < "$DST") variables, modo 640 root:$USER_NAME). Claves incluidas:"
cut -d= -f1 "$DST" | sort | sed 's/^/  - /'
for need in DATABASE_URL REDIS_URL; do
  grep -q "^$need=" "$DST" || echo "AVISO: falta $need en $SRC; el publicador no podrá arrancar." >&2
done
