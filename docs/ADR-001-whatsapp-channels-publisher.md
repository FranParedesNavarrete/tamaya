# ADR-001: Arquitectura del publicador SaaS para canales (newsletters) de WhatsApp

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** Fran Paredes (product owner / tech lead)

---

## Context

Se quiere construir y distribuir como SaaS una herramienta que permite publicar mensajes (texto + media: imagen, vídeo, audio, documento) en **canales (newsletters) de WhatsApp** en nombre del usuario, con capacidad de programación de envíos y registro persistente de cada publicación.

Restricciones y hechos ya validados por el equipo antes de tomar la decisión:

- La **WhatsApp Business Cloud API** oficial de Meta **no soporta publicar en canales** a día de abril 2026. Verificado por Fran.
- **Evolution API** self-hosted, virtualizando un navegador con WhatsApp Web, solo consigue enviar **texto** a canales; **no envía imagen, vídeo ni archivo**. Verificado por Fran.
- El único enfoque que ha funcionado extremo-a-extremo con media es la **automatización de un navegador real** sobre WhatsApp Web, ya sea mediante un agente LLM (p. ej. Claude Code) o mediante scripts deterministas (Puppeteer/Playwright).
- Volumen esperado por tenant: **2-3 mensajes por hora**, no ráfagas.
- Infraestructura disponible: AWS existente + servidor físico propio.
- Se quiere distribuir como SaaS (ambición de producto comercial, no herramienta interna).
- Automatizar WhatsApp Web va contra los ToS de WhatsApp y conlleva **riesgo de ban** de la cuenta del cliente; el diseño debe minimizar ese riesgo y gestionarlo de forma explícita como parte del producto (tiers, límites, auditoría).

Fuerzas en juego:

- **Robustez del envío** (media debe llegar siempre).
- **Coste por envío** (un SaaS con 2-3 msg/h × N clientes no puede costar euros por mensaje).
- **Riesgo de ban de cuenta** del cliente final (producto inservible si sus cuentas son baneadas).
- **Responsabilidad legal y de seguridad** sobre las sesiones y mensajes de los clientes (asumimos custodia → GDPR, cifrado, auditoría).
- **UX de producto**: programación de envíos, ausencia del cliente, posibilidad de operar desatendido.

---

## Decision

Construimos el sistema como un **SaaS centralizado** con los siguientes componentes clave:

1. **Pool de navegadores headless en servidor** (Playwright + Chromium) con una sesión persistente y cifrada por tenant. Cada tenant mantiene su propia sesión de WhatsApp Web autenticada vía QR inicial, reanclada periódicamente.
2. **Motor de automatización determinista** (scripts Playwright) para el 95% de envíos, con **fallback a un agente LLM** (Claude Code u otro) cuando el script determinista falla por cambios en el DOM o popups inesperados. El fallback LLM es además una **feature de tier premium** (cobrada con créditos).
3. **Sistema de tiers/créditos** que controla el rate-limit de envíos por tenant. Tiers más altos permiten más envíos/hora, pero también suben el coste de créditos consumidos (se compensa riesgo de ban con margen económico).
4. **Cifrado en reposo de mensajes y sesiones**, con clave maestra custodiada (HSM/KMS) y procedimiento documentado de descifrado en caso de urgencia legal u operativa.
5. **Frontend en extensión de Chrome** que consume una API REST del backend centralizado: formulario con texto + dropzone de ficheros + selector de canal. La extensión NO ejecuta el envío en el navegador del cliente; solo es UI.

---

## Options Considered

### Dimensión 1 — ¿Dónde se ejecuta la automatización del navegador?

#### Opción A: Extensión de Chrome en el navegador del usuario

| Dimensión | Assessment |
|-----------|------------|
| Complejidad | Baja |
| Coste infra | Mínimo (no hay servidores de navegador) |
| Escalabilidad | Excelente (escala con los clientes, gratis) |
| Riesgo de ban | Bajo (indistinguible de uso manual) |
| UX (programación) | Pobre: requiere navegador abierto |
| Responsabilidad legal | Baja (no custodiamos sesiones) |

**Pros:** Usa la sesión real del usuario, impronta de comportamiento = humano real, coste marginal cero por envío, riesgo legal bajísimo.
**Cons:** No permite envíos programados/desatendidos, depende de que el cliente tenga Chrome + WhatsApp Web abiertos, menos control sobre calidad de servicio, limita el modelo de negocio (poco "SaaS-ificable").

#### Opción B (elegida): Navegadores headless en servidor

| Dimensión | Assessment |
|-----------|------------|
| Complejidad | Media-Alta |
| Coste infra | Medio (un Chromium por tenant activo) |
| Escalabilidad | Controlada por nosotros |
| Riesgo de ban | Medio (huella más detectable) |
| UX (programación) | Excelente |
| Responsabilidad legal | Alta (custodiamos sesiones y mensajes) |

**Pros:** Permite la feature que más van a valorar los clientes (programación de envíos), cubre casos desatendidos, abre claramente el modelo SaaS con tiers, control total sobre el stack, simplifica auditoría y facturación.
**Cons:** Asumimos la custodia de sesiones WhatsApp de terceros (riesgo legal y de seguridad), coste de infra lineal con clientes activos, mayor riesgo de detección por Meta → el producto se juega a los patrones anti-ban que diseñemos.

#### Opción C: Híbrido (extensión para envíos en vivo + servidor para programados)

| Dimensión | Assessment |
|-----------|------------|
| Complejidad | Alta |
| Coste infra | Medio |
| Escalabilidad | Buena |
| Riesgo de ban | Medio |
| UX | Muy buena |
| Responsabilidad legal | Alta |

**Pros:** Cubre todos los casos de uso.
**Cons:** Doble base de código, doble modelo de sesión, UX confusa (¿por qué unos envíos sí y otros no?). Mucho esfuerzo para un beneficio incremental pequeño.

**Decisión:** **Opción B** — navegadores headless en servidor. Razones:

- La programación de envíos es la funcionalidad *killer* del producto según el criterio de producto del owner.
- Los tiers con límites de rate permiten amortiguar el mayor riesgo de ban.
- El cifrado de mensajes y sesiones con clave custodiada acota la responsabilidad legal.
- Con 2-3 msg/hora por tenant, el coste de infra es asumible (un Chromium puede servir a varios tenants si se diseña con pool y suspensión).

### Dimensión 2 — Motor de automatización

#### Opción A (elegida): Script determinista Playwright/Puppeteer

**Pros:** Rápido (segundos), barato (céntimos), reproducible, debuggable con trazas estándar, idempotente.
**Cons:** Frágil frente a cambios del DOM de WhatsApp Web (ocurre 2-4 veces al año). Requiere observabilidad y un proceso de "hotfix del selector".

#### Opción B: Agente LLM (Claude Code u otro) en cada envío

**Pros:** Robusto ante cambios del DOM, resuelve popups y estados inesperados de forma autónoma.
**Cons:** Caro por envío (céntimos-a-euros), lento (decenas de segundos a minutos), no determinista, difícil de debuggear en producción, difícil de auditar.

#### Opción C (complementaria): Determinista + LLM fallback

**Decisión:** Se combina A como motor por defecto y B como **fallback automático** cuando el script determinista falla y **como feature de tier premium**. Esto da coste bajo en el caso común, robustez cuando el DOM cambia, y un valor añadido vendible.

### Dimensión 3 — Modelo multi-tenant

#### Opción A: BYO (Bring Your Own) — cliente conecta su AWS/DB

**Pros:** Menos responsabilidad legal sobre datos del cliente.
**Cons:** Onboarding friccionado, UX compleja, difícil de dar SLAs, no es un SaaS "de verdad".

#### Opción B (elegida): Centralizado

**Pros:** UX limpia, SLAs viables, facturación directa, telemetría unificada, posibilidad de mejorar el producto con datos agregados (opt-in).
**Cons:** Somos responsables de GDPR, de la seguridad de las sesiones y de los mensajes. Requiere disciplina de cifrado, auditoría, respuesta a incidentes.

#### Opción C: Ambos

Descartada por ahora — doble producto multiplica esfuerzo. Revisitable en ~12 meses si hay demanda enterprise clara.

---

## Trade-off Analysis

El eje de decisión fundamental es **"riesgo de ban del cliente vs. potencia del producto"**. La Opción A de la dimensión 1 minimizaba el riesgo de ban casi por completo, pero a cambio dejaba el producto como una simple macro de navegador — no es un SaaS. La Opción B abre el producto pero obliga a diseñar explícitamente el sistema anti-ban.

La elección del owner es correcta siempre que:

1. Los **tiers** sean conservadores por defecto (p. ej., tier gratuito: máx. 5 envíos/día; tier pro: 20/día; tier business: 50/día, con jitter aleatorio y horario humano configurable por el cliente).
2. Cada sesión de WhatsApp tenga su propia **huella de navegador consistente** (mismo user-agent, mismo tamaño de viewport, mismo timezone que el cliente), para que Meta no detecte patrones de "granja de bots".
3. Se prohíba explícitamente en ToS el uso del producto para spam masivo (protege a la plataforma y al modelo de negocio).

El trade-off secundario es **"determinismo vs. robustez"**. La combinación elegida (A + B como fallback) resuelve casi todos los casos, pero introduce complejidad operativa: necesitamos detectar cuándo el script determinista "ha fallado pero no lo sabe" (p. ej., envía pero la media no se adjunta). Esto requiere verificación post-envío (leer el propio canal, verificar que el mensaje aparece con la media correcta) — no es opcional.

El trade-off de responsabilidad legal se gestiona con: cifrado de mensajes en reposo con clave KMS separada del DB, rotación de claves, borrado bajo demanda (GDPR Art. 17), logs de acceso a sesiones, y un **runbook de descifrado de urgencia** que requiera doble autorización humana.

---

## Consequences

**Se vuelve más fácil:**

- Vender el producto como SaaS "gestionado" con tiers y facturación clara.
- Ofrecer programación de envíos, que es la feature diferenciadora.
- Mantener el motor (un solo stack: Playwright + worker pool).
- Escalar el número de clientes sin requerir intervención técnica por cliente.
- Auditar qué se ha publicado cuándo y por quién (GDPR y uso interno).

**Se vuelve más difícil:**

- Diseño de seguridad: custodia de sesiones de WhatsApp de terceros = objetivo atractivo para atacantes. Requiere aislamiento estricto por tenant, cifrado, rotación, monitorización.
- Respuesta a bans: si un cliente es baneado, debemos tener protocolo claro (¿indemnización? ¿créditos? ¿soporte para recuperar cuenta?).
- Coste de infra crece con clientes activos; necesitamos un planificador que **suspenda navegadores ociosos** y los reanime cuando hay que enviar.
- Mantenimiento del script determinista: WhatsApp Web cambia cada 2-4 meses; hay que tener monitorización de fallos y proceso de hotfix.
- Cumplimiento GDPR al operar como responsable del tratamiento.

**Se revisitará cuando:**

- Meta abra oficialmente la API de canales con soporte a media → migrar parte del tráfico a la API oficial (menos riesgo, más estable). Elimina o reduce la necesidad de navegadores.
- El volumen supere los 50 tenants activos simultáneos → rediseñar el pool de navegadores (posible migración a un orquestador tipo Kubernetes con Horizontal Pod Autoscaler sobre pods con Chromium).
- Aparezca demanda enterprise clara → evaluar Opción C del modelo multi-tenant (ofrecer también self-hosted).

---

## Action Items

1. [ ] Producir el **System Design** completo (siguiente entregable): componentes, modelo de datos, flujo de sesión, sistema de tiers/créditos, cifrado, anti-ban, observabilidad.
2. [ ] Definir los **tiers iniciales** y los límites por tier (envíos/hora, envíos/día, prioridad en cola, acceso a LLM fallback).
3. [ ] Redactar los **ToS del producto** con prohibición explícita de spam y condiciones frente a bans de cuenta. Consultar con asesoría legal.
4. [ ] Definir el **runbook de descifrado de urgencia** (quién puede autorizar, qué se registra, qué reporta al cliente).
5. [ ] Montar un **PoC mínimo**: un worker Playwright que, dada una sesión autenticada, publica texto + imagen en un canal de prueba. Validar también audio, vídeo y documento.
6. [ ] Establecer **observabilidad y alerting** desde el día 1: tasa de éxito de envíos, tiempo por envío, tasa de fallback a LLM, bans detectados, cambios en el DOM de WhatsApp Web.
7. [ ] Diseñar el **protocolo de huella de navegador consistente por tenant** (UA, viewport, timezone, locale).
