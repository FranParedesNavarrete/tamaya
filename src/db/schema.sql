-- Tamaya PoC — SQLite schema
-- Refleja una versión reducida del modelo de datos descrito en SYSTEM-DESIGN.
-- NO incluye cifrado ni KMS (fuera de alcance del PoC).

CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,            -- UUID v4 generado en cliente
  tenant_id     TEXT NOT NULL,
  invite_link   TEXT,                         -- primario, si está disponible
  whatsapp_id   TEXT,                         -- secundario (extraído del link)
  name          TEXT NOT NULL,                -- terciario, para fallback y UI
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channels_tenant ON channels(tenant_id);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  channel_id        TEXT NOT NULL REFERENCES channels(id),
  body              TEXT NOT NULL,            -- en PoC va en claro
  status            TEXT NOT NULL,            -- queued | in_progress | sent | failed | verified_failed
  scheduled_at      TEXT,
  attempted_count   INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  duration_ms       INTEGER,                  -- medido por el worker
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_media (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  local_path    TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  kind          TEXT NOT NULL                 -- image | video | audio | document
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  metadata    TEXT,                            -- JSON serializado
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at DESC);
