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
  fw           TEXT,

  -- Content hash of the detection engine this firmware served at /motor.js,
  -- reported by the device since v1.9.7. `fw` cannot stand in for it: an
  -- engine is baked into a firmware build, but the two version numbers move
  -- independently, so knowing the firmware never told us which engine was
  -- live. With this, a row in `analyses` whose engine equals this one is
  -- genuinely "what it read at the time" rather than "the first time someone
  -- happened to click it". NULL for every frame uploaded before v1.9.7 —
  -- and that must stay visible rather than be guessed at.
  engine       TEXT
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

-- Firmware builds the device may install over the air, from anywhere.
--
-- `armed_at` is the whole safety model. A build sitting here is inert: the
-- device is told about it only once a human has armed it, with a second
-- deliberate command. That keeps the rule the project had before OTA existed
-- — an update happens because a person pushed one, never because the device
-- went looking. Publishing and arming are separate on purpose; a single
-- "deploy" verb would make the dangerous thing the easy thing.
--
-- The ingest handler clears armed_at as soon as a reading arrives reporting
-- that version, so "armed" means "waiting to land" and never lingers as a
-- standing invitation.
--
-- md5 is what the device verifies the download against, and is the header
-- name HTTPUpdate looks for (x-MD5). Not a signature: it catches a corrupted
-- transfer, not a malicious one. Anyone who can write this table or the R2
-- object owns the device.
CREATE TABLE IF NOT EXISTS firmware (
  version     TEXT PRIMARY KEY,   -- must equal the FW_VERSION compiled in
  r2_key      TEXT NOT NULL,
  md5         TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL,
  armed_at    TEXT                -- NULL = inert. Exactly one row may be armed.
);
CREATE UNIQUE INDEX IF NOT EXISTS firmware_one_armed
  ON firmware ((1)) WHERE armed_at IS NOT NULL;

-- Added 2026-08-17 for existing databases:
--   ALTER TABLE readings ADD COLUMN engine TEXT;
--
-- Added 2026-08-16 for existing databases:
--   ALTER TABLE readings ADD COLUMN press_degrees INTEGER;
--   (the analyses table below is created by running this file again)
