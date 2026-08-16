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

  -- No reading here. A frame does not have one value, it has one value PER
  -- ENGINE — see the analyses table below. Keeping a `flow` column on the
  -- frame would force a choice between "what it read at the time" and "what
  -- it reads now", and both are wanted.
  flow         REAL,               -- unused, kept so old rows still parse
  state        TEXT,               -- unused, ditto

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

-- One reading per frame per engine version.
--
-- The point of the compound key: a frame analysed by the engine that was
-- current when it arrived keeps that reading forever, and re-analysing it
-- later with a recalibrated engine adds a row rather than overwriting one.
-- That makes "what did it say then" and "what would it say now" both
-- answerable, which is the whole reason the table exists.
--
-- `engine` is the content hash of balldetector.js, computed at build time by
-- build_webui.mjs. A hash rather than a version string because it cannot drift
-- from the code the way a constant someone has to remember to bump can.
CREATE TABLE IF NOT EXISTS analyses (
  reading_id   INTEGER NOT NULL REFERENCES readings(id),
  engine       TEXT    NOT NULL,
  flow         REAL,               -- L/min, NULL unless state='ok'
  state        TEXT    NOT NULL,   -- 'ok'|'max'|'below'|'uncertain'|'no-reading'
  quality      TEXT,               -- JSON: reg, peak, margin, dx, dy, spread —
                                   -- what answers "why did it stop reading"
                                   -- months later without refetching images
  analysed_at  TEXT    NOT NULL,   -- ISO8601
  PRIMARY KEY (reading_id, engine)
);
CREATE INDEX IF NOT EXISTS analyses_engine ON analyses (engine);

-- Added 2026-08-16 for existing databases:
--   ALTER TABLE readings ADD COLUMN press_degrees INTEGER;
--   (the analyses table below is created by running this file again)
