# Verification Report: WhatsApp Channels Publisher

**Fecha:** 2026-04-17
**Documentos revisados:** ADR-001, SYSTEM-DESIGN, POC-BACKLOG
**Método:** revisión crítica independiente + síntesis propia

Este documento es el cierre honesto de la fase de diseño: enumera contradicciones, gaps y riesgos no cubiertos por los tres entregables anteriores, para que no se nos cuelen a producción.

---

## Resumen

| Severidad | Cantidad | Acción |
|-----------|----------|--------|
| Bloqueante | 3 | Resolver antes de iniciar PoC con números reales |
| Alto | 3 | Resolver antes de GA (v1) |
| Medio | 4 | Incluir en backlog v1/v2 |
| Bajo | 2 | Aceptable por ahora, documentar |

**Veredicto:** el diseño es coherente y accionable, pero tiene **tres bloqueantes legales/de seguridad** que deben cerrarse antes de tocar código con un número real de WhatsApp o aceptar al primer cliente.

---

## Bloqueantes (resolver antes del PoC)

### B1. ToS del producto y responsabilidad ante bans — no existen

**Dónde falta:** ADR-001 acción 3 menciona "redactar ToS" pero no hay plantilla ni calendario. SYSTEM-DESIGN no cubre responsabilidad legal.

**Por qué importa:** sin ToS aceptado explícitamente por el cliente:
- Si su número es baneado, puede reclamarte daños (lucro cesante, reputación).
- Si un cliente usa tu plataforma para spam, Meta puede perseguir al operador (tú).
- Sin prohibición explícita de spam en ToS, no puedes expulsar a un cliente tóxico sin riesgo.

**Mitigación:**
1. Antes del PoC, bloquear 1-2 días para redactar ToS preliminar con abogado. Puntos no negociables: riesgo de ban asumido por el cliente, no indemnización, prohibición explícita de spam/contenido ilegal, terminación inmediata ante abuso.
2. Añadir al onboarding (aunque sea manual) la aceptación firmada.
3. Revisar con asesoría en GDPR por la parte de custodia de sesiones.

### B2. Procedimiento de respuesta a breach — incompleto

**Dónde falta:** SYSTEM-DESIGN sec. 3.5 diseña cifrado y runbook de descifrado, pero **no cubre**: notificación a afectados (GDPR Art. 33, 72 horas), rotación masiva de credenciales tras incidente, preservación forense, RBAC con 2FA humano para operaciones KMS, ni proceso de expulsión rápida de sesiones comprometidas.

**Por qué importa:** breach = atacante publica en canales de clientes → daño reputacional masivo + sanción GDPR (hasta 20M€).

**Mitigación:**
1. Documentar un **Incident Response Runbook** con pasos concretos y responsables antes de aceptar primer cliente.
2. RBAC con 2FA para operaciones KMS desde día 1 (no es caro).
3. Plantilla de notificación a cliente prearmada.
4. Testear el runbook con un ejercicio sintético cada 6 meses.

### B3. Plan de mantenimiento frente a cambios de DOM — insuficiente

**Dónde falta:** ADR-001 lo nombra como consecuencia; SYSTEM-DESIGN 3.7 menciona canary; POC-BACKLOG T6.2 planea un playbook. Pero **no hay**: canary automatizado en v1, visual diffing periódico, rollback rápido a versión anterior del script, ni proceso de hotfix medido.

**Por qué importa:** si WhatsApp Web cambia un viernes noche y nadie detecta hasta el lunes, 50 tenants están sin servicio 60h → churn inmediato.

**Mitigación:**
1. Meter en el backlog de v1 (no esperar a v2): canary interno que publica 1 msg/día y alerta si falla, con visual regression (comparar screenshot del compositor contra referencia).
2. Versionar los scripts de selectores (semver) y tener rollback a la última versión verde en 1 comando.
3. SLA interno: detectar cambio en < 2h (alertas 24/7), hotfix desplegado en < 8h laborables.

---

## Altos (resolver antes de GA)

### A1. SLO de 97% éxito no está validado

El PoC prueba 50 envíos, no simula carga sostenida ni presión de Meta. Antes de GA conviene una corrida sintética de 2-3k envíos en una semana para calibrar el SLO por tier (ej. Free 95%, Pro 97%, Business 99%).

### A2. Coste de LLM fallback no acotado ni transparente

SYSTEM-DESIGN 3.9 dice "0,30-1,50 €/invocación" y sec. 3.6 lo incluye "con límite" en Pro sin definir el límite. Si un cambio de DOM fuerza 50 fallbacks a un tenant Pro, se funde el tier y la cuenta PnL de ese cliente. Acciones:

- Convertir créditos ↔ euros explícitamente y publicarlo.
- Límite duro diario de LLM fallback por tier (ej. Pro: 5/día). Si se supera, se pausa envío y se avisa al cliente.
- **Reintentos fallidos no cuentan créditos** (UX y riesgo legal).
- Aviso proactivo ("tu envío va a requerir LLM fallback, consume X créditos extra, ¿continuar?").

### A3. GDPR Art. 17 operativamente débil

El data model usa `deleted_at` (soft delete). Para cumplir Art. 17 con rigor:

- En producción, el borrado debe ser **hard delete** sobre DB activa + purga en backups tras ventana de retención + eliminar objetos S3 + revocar DEKs del tenant.
- Documentar un **DSAR runbook** con SLA de 30 días.
- Diseñar retención explícita por tipo de dato (mensajes: X días, audit: Y años, sesiones: mientras activas).

---

## Medios (backlog v1/v2)

### M1. Límites de tier vs. uso real de newsletters

Los tiers definen 5/20/60 msg/día, pero un newsletter real (p. ej. un medio) puede querer ráfagas mayores en picos. Validar con 3-5 clientes potenciales antes de fijar pricing; considerar **tier Enterprise** con límites negociables.

### M2. Protección anti-spam del propio cliente

Si un cliente legítimo tiene su cuenta comprometida y el atacante usa tu SaaS para spam masivo, acaba tu IP/plataforma quemada. Implementar:

- Rate limiting duro en API (`429` si excede tier).
- Detección de patrones sospechosos (mismo contenido a N canales en X min).
- Alerta al tenant ante actividad anómala (intento de login desde nueva IP, cambio de volumen de 0 a muchos).

### M3. Identificación del canal — nombre exacto es frágil

Guardar **nombre + invite link + channel ID** cuando sea extraíble. El script prefiere ID > link > nombre. Validar antes de publicar que al menos dos coinciden. Si el cliente renombra, detectar y pedir confirmación.

### M4. Pool distribuido para > 100 tenants

SYSTEM-DESIGN 4.1 remite a Kubernetes para v2 pero sin diseño. Esbozar ahora (no implementar): *consistent hashing* de `tenant_id` a worker, replicación de sesión cifrada entre hosts (o serialización bajo demanda desde DB), leader election para reanimación.

---

## Bajos (documentar y seguir)

### L1. Durabilidad S3 vs. disaster regional

Aclarar que "99.99%" es intra-región. Activar cross-region replication desde día 1 tiene coste marginal bajo y quita el asterisco.

### L2. Verificación post-envío para media pesada

Para vídeos, WhatsApp puede tardar en transcodificar. El PoC debe capturar estos tiempos y ajustar timeouts. Añadir en fase 4 del PoC: vídeo de 10-15 MB y medir.

---

## Cambios concretos a aplicar en los documentos existentes

Marcados como TODO para cuando incorporemos las mitigaciones:

- [ ] ADR-001 / Action Item 3: añadir fecha límite ("antes del PoC") y responsable.
- [ ] ADR-001 / Consequences: añadir "asumimos procesado de datos personales de los suscriptores de los canales de terceros = rol de encargado del tratamiento conforme a GDPR Art. 28".
- [ ] SYSTEM-DESIGN 1.1 / borrado: cambiar "soft delete (GDPR: purge job)" por "hard delete tras retención definida + purga de backups".
- [ ] SYSTEM-DESIGN 3.5: añadir sub-sección de Incident Response y RBAC/2FA para KMS.
- [ ] SYSTEM-DESIGN 3.6: fijar precio de crédito en euros y límites duros de LLM por tier.
- [ ] SYSTEM-DESIGN 3.7: subir el canary de "día 1 de v1" de "opcional" a obligatorio, con visual diffing.
- [ ] SYSTEM-DESIGN Open Questions 1: cerrar como "triple identificador (ID + link + nombre)".
- [ ] POC-BACKLOG Fase 2 T2.1: usar invite link como primario, nombre como verificación secundaria.
- [ ] POC-BACKLOG añadir Fase 7: redacción de ToS preliminar y revisión con asesoría legal.

---

## Siguiente paso recomendado

1. **Esta semana**: redactar ToS preliminar y revisar con asesoría (B1).
2. **Esta semana**: escribir Incident Response Runbook (B2).
3. **Semana que viene**: aplicar los cambios marcados arriba en los documentos.
4. **Semana que viene**: arrancar el PoC (Fase 0 + Fase 1), con número de pruebas completamente desechable.
5. **Al terminar Fase 5 del PoC**: revisitar este informe y re-evaluar antes de empezar v1.

El diseño es sólido. Los bloqueantes son gestionables si se tratan ya; si se ignoran, son el tipo de cosas que hacen que el proyecto explote en producción o en los tribunales.
