# PoC Backlog: WhatsApp Channels Publisher

**Fecha:** 2026-04-17
**Objetivo:** Validar *en 2 semanas* y con el mínimo código posible que un worker Playwright puede publicar texto + media (imagen, vídeo, audio, documento) en un canal real de WhatsApp, de forma reproducible y auditable. Todo lo demás (SaaS, tiers, facturación, extensión Chrome, multi-tenant) viene después.

**Criterio de éxito del PoC:**

- [ ] Se publican mensajes de los 4 tipos de media + texto en un canal de prueba propio.
- [ ] Tasa de éxito ≥ 95% en 50 envíos consecutivos (espaciados 5 min).
- [ ] Verificación post-envío automatizada (hash de media coincide).
- [ ] Sesión persiste entre reinicios del worker.
- [ ] Tiempo p95 por envío < 30s.
- [ ] Se documenta el proceso de hotfix cuando WhatsApp Web cambie el DOM.

**No entra en el PoC:** UI, tenants, cifrado KMS, tiers, créditos, programación, LLM fallback, extensión Chrome, multi-canal.

---

## Stack del PoC

- Node 20 + TypeScript
- Playwright 1.44+ con Chromium
- SQLite local como store
- Docker para ejecutar el worker reproducible
- 1 número de WhatsApp de pruebas + 1 canal de pruebas (desechable)

---

## Historias / tareas ordenadas

### Fase 0 — Preparación (día 1)

- [ ] **T0.1** Crear repo `whatsapp-publisher-poc` con TS + ESLint + Playwright.
- [ ] **T0.2** Conseguir un número de pruebas (no usar número personal bajo ningún concepto).
- [ ] **T0.3** Crear canal de WhatsApp de prueba desde la app móvil con ese número.
- [ ] **T0.4** Preparar 4 ficheros de media de prueba: `test.jpg` (1MB), `test.mp4` (5MB), `test.mp3` (2MB), `test.pdf` (500KB). Guardar SHA-256 de cada uno.

### Fase 1 — Autenticación persistente (días 2-3)

- [ ] **T1.1** Script `login.ts` que abre Chromium con `headless=false`, navega a `web.whatsapp.com`, espera al QR, permite escanear manualmente.
- [ ] **T1.2** Al detectar login (p. ej. selector de la barra lateral de chats), captura `storageState` y lo guarda en `sessions/default.json`.
- [ ] **T1.3** Script `whoami.ts` que abre Chromium con el `storageState` cargado y verifica que la sesión sigue viva (lee el perfil).
- [ ] **T1.4** Reiniciar el worker 24h después y validar que la sesión persiste sin re-escaneo.

**Entregable:** sesión de WhatsApp Web estable en disco + documentación de cómo renovarla.

### Fase 2 — Publicación de texto en canal (días 4-5)

- [ ] **T2.1** Script `publish-text.ts` que, dada una sesión cargada, navega al canal por **nombre exacto** en la barra lateral.
- [ ] **T2.2** Manejar el caso de que el canal esté en la pestaña "Actualizaciones" / "Channels" (requiere click previo).
- [ ] **T2.3** Tipear el mensaje en el compositor (cuidado con contenteditable, no un input clásico).
- [ ] **T2.4** Pulsar enviar y esperar a que el mensaje aparezca en el hilo.
- [ ] **T2.5** Verificación: leer último mensaje del hilo y comparar texto.

**Criterio de aceptación:** 10 mensajes de texto seguidos, 100% éxito. Tiempo p95 < 15s.

### Fase 3 — Publicación con media (días 6-9)

- [ ] **T3.1** Detectar el botón de adjuntar (clip/paperclip) y el tipo de upload (foto/vídeo vs. documento vs. audio).
- [ ] **T3.2** Subir fichero vía `page.setInputFiles(selector, path)` directamente al `<input type="file">` (más robusto que simular clicks).
- [ ] **T3.3** Esperar al preview de la media; verificar que aparece.
- [ ] **T3.4** Añadir caption (texto) al preview.
- [ ] **T3.5** Enviar y verificar post-envío: la media aparece en el hilo, su SHA-256 descargado desde WhatsApp coincide con el original.
- [ ] **T3.6** Probar con los 4 tipos: imagen, vídeo, audio, documento. Cada tipo puede requerir un flujo distinto (p. ej. audio podría ir por "documento" si WhatsApp no muestra previsualización).

**Criterio de aceptación:** 10 envíos por tipo × 4 tipos = 40 envíos. Éxito ≥ 95%.

### Fase 4 — Verificación anti-silent-fail (día 10)

- [ ] **T4.1** Implementar `verify.ts` que tras cada envío:
  - Espera hasta 30s a ver el mensaje con tick de envío.
  - Lee el texto del mensaje y compara con el esperado.
  - Si hay media, descarga el fichero desde el mensaje y compara SHA-256.
- [ ] **T4.2** Si la verificación falla, marca el envío como `verified_failed` y guarda screenshot.

**Criterio de aceptación:** Detección fiable de silent-fails inducidos artificialmente (p. ej. cortando la red tras el click).

### Fase 5 — Harness de carga y observabilidad ligera (días 11-12)

- [ ] **T5.1** Script `harness.ts` que lanza N envíos con jitter aleatorio 30-180s.
- [ ] **T5.2** Registra cada envío en SQLite con: timestamp, tipo, tamaño, duración, estado, error si hubo.
- [ ] **T5.3** Dashboard CLI simple (`stats.ts`): tasa de éxito, p50/p95, errores agrupados.
- [ ] **T5.4** Corrida piloto: 50 envíos a lo largo de un día completo con ventanas humanas (09-22h).

**Criterio de aceptación:** Todas las métricas del "Criterio de éxito del PoC" cumplidas.

### Fase 6 — Documentación y lecciones (día 13)

- [ ] **T6.1** Documento `FINDINGS.md` con:
  - Selectores frágiles detectados.
  - Quirks por tipo de media.
  - Tiempos medidos por tipo.
  - Errores observados y su causa.
- [ ] **T6.2** Documento `HOTFIX-PLAYBOOK.md` con el procedimiento a seguir cuando WhatsApp Web cambie el DOM (cómo grabar un flujo nuevo, cómo actualizar selectores sin romper sesiones).
- [ ] **T6.3** Demo en vídeo (5 min) de un envío end-to-end.

---

## Riesgos del PoC

| Riesgo | Mitigación |
|--------|-----------|
| El número de pruebas es baneado en medio del PoC | Usar número completamente desechable; nunca conectar con datos reales. Si baneo: repetir con otro y documentar patrones que lo provocaron. |
| WhatsApp Web cambia selectores durante el PoC | Construir con selectores resilientes (aria-labels, roles), no con CSS específico. Documentar todos los selectores en un solo fichero `selectors.ts`. |
| La API de canales de WhatsApp cambia comportamiento (p. ej. media no soportada en alguna modalidad) | Aceptable: el PoC precisamente descubre estas limitaciones. Documentar y adaptar scope. |
| Overhead de 1 navegador por envío inviable para el modelo final | No es objetivo del PoC resolverlo; sí lo es medirlo (tiempo de startup, RAM, CPU). Input para el diseño del pool en v1. |
| Detección automatizada en el login (captcha, verificación extra) | Documentar y evaluar; si ocurre persistentemente, es una señal roja que afecta al proyecto entero y obliga a replantear. |

---

## Qué aprendemos (decision points tras el PoC)

El PoC responde tres preguntas que definen si el proyecto tiene sentido:

1. **¿Podemos publicar media de los 4 tipos de forma fiable?** — Si no, el producto no existe tal como está concebido.
2. **¿Cuál es el coste real (tiempo + RAM) por envío?** — Define el modelo de pricing y la capacidad por host.
3. **¿Cuánto cambia WhatsApp Web en un mes?** — Si cambia más de una vez por mes, el coste de mantenimiento explota y quizás hay que subir de día 1 al fallback LLM.

Con esas tres respuestas podemos decidir si arrancar la v1 SaaS completa o si el plan necesita ajuste.
