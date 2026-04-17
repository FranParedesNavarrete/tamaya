# Tamaya

> Publicador de mensajes a canales (newsletters) de WhatsApp. PoC en fase alfa.

Tamaya automatiza WhatsApp Web con Playwright para publicar texto y media (imagen, vídeo, audio, documento) en canales de WhatsApp, cubriendo un hueco que las APIs oficiales no resuelven.

El nombre es un guiño a *atalaya* (torre de vigía desde la que se lanzan señales).

## Estado

**Alpha / PoC.** Scaffolding inicial + documentación de diseño. La implementación real del motor de publicación se completa siguiendo las fases de `docs/POC-BACKLOG-whatsapp-channels-publisher.md`.

## ⚠️ Aviso importante

Tamaya automatiza WhatsApp Web. Esto **viola los Términos de Servicio de WhatsApp/Meta** y puede resultar en el ban de la cuenta asociada. Úsalo bajo tu propia responsabilidad y **nunca con tu número personal**. En esta fase alfa no hay todavía ToS del producto ni runbook de respuesta a incidentes: si buscas producir en entorno real, revisa antes `docs/VERIFICATION-REPORT-whatsapp-channels-publisher.md`.

## Requisitos

- Node.js ≥ 20
- macOS / Linux (probado en macOS 14)
- Un número de WhatsApp **desechable** con un canal de pruebas creado.

## Quickstart

```bash
# 1. Instalar dependencias
npm install
npm run install:browsers

# 2. Configurar
cp .env.example .env
# edita .env si quieres cambiar timezone, user agent, etc.

# 3. Login inicial (abre navegador, escanea QR)
npm run login

# 4. Publicar un texto (skeleton — aún no funcional, requiere completar Fase 2)
npm run publish -- --channel "Mi canal de prueba" --text "Hola desde Tamaya"

# 5. Publicar texto + imagen
npm run publish -- -c "Mi canal" -t "Mira esta foto" -m ./test-assets/test.jpg -k image

# 6. Ver estadísticas
npm run stats
```

## Estructura del repo

```
tamaya/
├── src/
│   ├── config.ts              # Carga y valida .env con zod
│   ├── logger.ts              # Pino
│   ├── browser/
│   │   ├── fingerprint.ts     # Huella consistente por tenant
│   │   ├── session.ts         # launchBrowser, openContext, saveSession
│   │   └── selectors.ts       # ← selectores WhatsApp Web centralizados (hotfix vive aquí)
│   ├── publisher/
│   │   ├── login.ts           # QR login flow
│   │   ├── publish-text.ts    # [Fase 2 PoC]
│   │   ├── publish-media.ts   # [Fase 3 PoC]
│   │   └── verify.ts          # Verificación post-envío [Fase 4 PoC]
│   ├── cli/
│   │   ├── login.ts
│   │   ├── publish.ts
│   │   └── stats.ts
│   └── db/
│       ├── schema.sql         # SQLite schema
│       └── client.ts          # Cliente + audit()
├── docs/                      # ADR, System Design, PoC Backlog, Verification Report
├── sessions/                  # storageState de WhatsApp (gitignored — ¡NO commitear!)
├── test-assets/               # Media de prueba (gitignored)
├── scripts/                   # Utilidades ad-hoc (vacío por ahora)
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Documentación de diseño

Todo el razonamiento técnico del proyecto vive en `docs/`:

- `ADR-001-whatsapp-channels-publisher.md` — decisión de arquitectura.
- `SYSTEM-DESIGN-whatsapp-channels-publisher.md` — diseño completo del sistema (v1 SaaS).
- `POC-BACKLOG-whatsapp-channels-publisher.md` — las 6 fases para llevar el PoC a verde.
- `VERIFICATION-REPORT-whatsapp-channels-publisher.md` — revisión crítica y riesgos abiertos.

Si vas a contribuir, empieza por el PoC Backlog: las tareas están ordenadas por dependencia y cada una tiene criterios de aceptación.

## Hotfix cuando WhatsApp Web cambie

Cuando un envío empiece a fallar consistentemente por cambios en el DOM:

1. Abre `src/browser/selectors.ts` — es el único sitio con selectores.
2. Lanza `npm run login` en modo inspección (headless=false) y actualiza los selectores afectados.
3. Sube el `SELECTORS_VERSION` (semver).
4. Corre el canary (cuando exista) para validar.

## Seguridad (estado actual vs. objetivo)

| Aspecto | PoC (hoy) | v1 (objetivo) |
|---------|-----------|----------------|
| Cifrado de sesiones | **No** (plaintext en `sessions/`) | AES-256-GCM con KMS |
| Multi-tenant | No (1 tenant) | Sí |
| ToS del producto | No | Sí |
| Incident runbook | No | Sí |

Nunca commites `sessions/*.json` ni `.env`. El `.gitignore` los excluye — mantenlo así.

## Licencia

TBD — proyecto privado mientras esté en alpha.
