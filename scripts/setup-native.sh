#!/usr/bin/env bash
#
# setup-native.sh — prepara y arranca los procesos NATIVOS de Tamaya
# (worker-publish + control-server) bajo PM2, listos para sobrevivir al boot.
#
# NO mete nada en Docker. NO publica jobs. NO pide sudo (solo IMPRIME la
# instrucción de `pm2 startup`, que sí requiere sudo y la ejecutas tú).
#
# Uso:
#   bash scripts/setup-native.sh
#
set -euo pipefail

# Ir a la raíz del repo (este script vive en scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }

# 1. Node / npm
say "Comprobando Node y npm"
if ! command -v node >/dev/null 2>&1; then
  warn "Node no encontrado. Instala Node 20+ y vuelve a ejecutar."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  warn "npm no encontrado."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
ok "node $(node -v) / npm $(npm -v)"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  warn "Se recomienda Node 20+. Detectado: $(node -v)."
fi

# 2. PM2
say "Comprobando PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  warn "PM2 no está instalado globalmente. Instálalo con:"
  echo "    npm install -g pm2"
  exit 1
fi
ok "pm2 $(pm2 -v)"

# 3. Navegador de Playwright (Chromium)
say "Comprobando Chromium de Playwright"
if npx --no-install playwright install --dry-run chromium >/dev/null 2>&1; then
  ok "Chromium parece instalado"
else
  warn "Puede que Chromium no esté instalado. Ejecuta:"
  echo "    npx playwright install chromium"
  echo "    sudo npx playwright install-deps chromium   # dependencias de sistema (Ubuntu)"
fi

# 4. Build del monorepo (los procesos nativos corren desde dist/)
say "Compilando (npm run build)"
npm run build
ok "build completado"

# 5. Arrancar bajo PM2 (publisher + control server)
say "Arrancando procesos nativos bajo PM2"
npm run native:start
pm2 status || true

# 6. Autoarranque al boot
say "Autoarranque al boot"
echo "Para que PM2 resucite estos procesos tras reiniciar el servidor:"
echo
echo "    1) Genera el servicio de systemd (requiere sudo, cópialo y ejecútalo):"
echo "         pm2 startup"
echo "    2) Guarda la lista actual de procesos:"
echo "         pm2 save"
echo
ok "Listo. Revisa el estado del pipeline en la UI → Ajustes → Diagnóstico, o GET /ops/publisher."
