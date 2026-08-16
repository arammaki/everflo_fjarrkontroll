-- EverFlo monitor — D1 schema.
--
--   npx wrangler d1 execute everflo --file schema.sql --local     (dev)
--   npx wrangler d1 execute everflo --file schema.sql --remote    (live)
--
-- The timestamp is set by the server on receipt. The device has no clock,
-- and a few seconds of uncertainty does not matter here.

CREATE TABLE IF NOT EXISTS readings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  TEXT    NOT NULL,   -- ISO8601, server clock
  reason       TEXT    NOT NULL,   -- 'periodic' | 'press' | 'boot'
  image_key    TEXT,               -- R2 object key, NULL when no image was sent

  -- Reading. Stays NULL until an analysis path exists that is validated
  -- against the labelled set — the engine is calibrated on browser-decoded
  -- pixels, and a second decoder must be proven equivalent before its
  -- numbers are trusted. See CLAUDE.md, "Engine invariants".
  flow         REAL,               -- L/min
  state        TEXT,               -- 'ok' | 'max' | 'below' | 'no-reading'

  -- Device-reported context. Informational: the camera image is the truth.
  position      INTEGER,           -- press counter, may drift from reality
  step_degrees  INTEGER,           -- the standing default at the time
  press_degrees INTEGER,           -- signed turn that caused this frame, NULL
                                   -- unless reason='press'
  uptime_s     INTEGER,
  rssi         INTEGER,
  fw           TEXT
);

CREATE INDEX IF NOT EXISTS readings_received_at ON readings (received_at);
CREATE INDEX IF NOT EXISTS readings_reason      ON readings (reason, received_at);

-- Added 2026-08-16 for existing databases:
--   ALTER TABLE readings ADD COLUMN press_degrees INTEGER;
