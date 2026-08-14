# EverFlo fjärrkontroll — firmware

Remote control for the flow knob on a Philips EverFlo oxygen concentrator,
built so my mother (limited mobility) can adjust her oxygen flow from her
phone. A camera streams the flow meter; the phone page shows the image and
+/− buttons; an ESP32 drives a stepper that turns the knob via a 3D-printed
friction cup. **The camera image is the source of truth — the human always
verifies visually. Manual override must always work: the motor is
de-energized except during an actual press.**

This is assistive/medical-adjacent equipment in real daily use. Correctness
and predictability beat cleverness. When in doubt: smaller change, bump
version, let the user flash and verify.

## Hardware

| Part | Details |
|---|---|
| MCU | Seeed XIAO ESP32-S3 **Sense** (OV3660 camera, PID 0x3660; OV2640 also supported by PID check) |
| Driver | TMC2209 clone breakout, standalone/legacy mode (no UART), unmarked — see pin map below |
| Motor | NEMA 17 pancake (17HE08-1004S), 0.9°... driven 1/8 microstep? — see STEG_PER_TRYCK in code; 15°/press |
| Motor PSU | MB102 breadboard supply, jumper 5V, barrel input **needs 7–12 V** (1117 regulators, ~1 V dropout) |
| Cup | 3D-printed conical cup on the D-shaft (Ø5.18 bore / flat 4.71), M3 set screw against the flat |

### Power architecture (post-mortem law — a XIAO died to teach us this)
- **Logic**: XIAO powered by its own USB-C. XIAO 3V3 → TMC VDD (logic only).
- **Motor power**: MB102 5V rail → TMC VM. **NEVER wire VM from the XIAO 5V pin.**
- **Common ground is mandatory**: XIAO GND + TMC GND + MB102 GND on one rail.
- Breadboard rails are **split in segments** — module, VM jumper and ground
  bridge must share the same segment.

### Pin map
XIAO (USB-C up): left edge top-down D0–D6; right edge top-down 5V, GND, 3V3, D10, D9, D8, D7.

| XIAO | Signal | TMC clone position |
|---|---|---|
| D0 | STEP | red row pos 2 |
| D1 | DIR | red row pos 1 |
| D2 | EN (active LOW) | red row pos 8 |
| 3V3 | VDD | black row pos 2 |
| GND | GND | black row pos 1 or 7 |
| GPIO21 | onboard LED, **active LOW** (heartbeat 1 s on / 4 s off) | — |

TMC clone rows, position 1 = the "TMC2209 V2.0" text/big-capacitor end,
position 8 = the potentiometer/gold-hole end:
- **Black row (power) 1→8:** GND, VDD, 1B, 1A, 2A, 2B, GND, VM
- **Red row (logic) 1→8:** DIR, STEP, CLK, UART, UART, MS2, MS1, EN
- Motor coils: black+blue = coil A → 1A/1B; green+red = coil B → 2A/2B.
- VREF ≈ 0.6 V (pot center vs GND, measured with VM powered, motor unplugged).

### Iron rules (never violate, never "optimize away")
1. VM never from the XIAO. 2. Beep-test the EN wire (D2 ↔ red pos 8) after any
   rewiring, before power. 3. Never plug/unplug motor or any wire under power.
4. EN idles HIGH (motor free) — that IS the manual override; never hold the
   motor energized outside an actual movement.

## Firmware architecture (v1.7.0)

Single sketch `everflo_fjarrkontroll.ino`. Key pieces:
- **WiFiManager**: portal SSID "Syrgas-setup", 15 s × 3 connect attempts,
  120 s portal timeout, restart on failure. `wifiVakt()` in `loop()` heals
  runtime drops (3 × 15 s reconnects → `ESP.restart()`).
- **mDNS**: `syrgas.local`.
- **Web server port 80**: `/` (UI), `/api/plus`, `/api/minus`,
  `/api/nollstall`, `/api/omstart`, `/api/status`, `/api/steg`, `/log`,
  `/bild`. `/bild` and `/api/steg` send `Access-Control-Allow-Origin: *`
  (the external bolldetektor.html tool depends on this). Other JSON APIs
  currently do NOT send CORS headers (wishlist).
- **`/api/steg`**: GET returns `{"steg":N,"min":4,"max":45,"standard":15}`
  (degrees per press); `?v=N` sets it, clamped to compiled 4..45, RAM only
  (reboot = compiled default `DEG_PER_TRYCK`). Invalid/negative/empty `v`
  is ignored.
- **Stream server port 81**: `/stream` MJPEG, viewer-kickout via
  `stream_gen` (newest viewer wins), `lru_purge_enable`, 5 s send/recv
  timeouts. The main page does NOT use it — it polls `/bild` (relative URL)
  ~4 Hz, chained via `onload` with 1 s error backoff. Keep it that way:
  Safari+mDNS on port 81 is flaky and a wedged stream must never take down
  the UI.
- **Camera**: `CAMERA_GRAB_WHEN_EMPTY`; `KAMERA_VFLIP`/`KAMERA_HMIRROR`
  defines exist; display rotation is done in the page CSS
  (`rotate(90deg) scaleX(-1)`), not in the sensor.
- **Position counter** `lage` persisted via Preferences; survives power
  loss (verified). Informational only since v1.7.0 — MIN_LAGE/MAX_LAGE
  removed (manual knob turns / cup slip made them unreliable; the camera
  is the source of truth).
- **`RIKTNING -1`** (verified on-site): flips motor direction for both
  buttons; never "fix" direction by swapping button handlers — that inverts
  counter semantics.
- `FB-OVF` log lines from cam_hal are harmless (frame buffer overflow when
  frames outpace the viewer).

## Conventions

- **All Swedish**: identifiers, comments, log messages, UI text. Keep it.
- **Bump `FW_VERSION` on every behavioral change** — the page footer shows
  it, and it is how the user verifies a flash actually took (cache traps).
- One focused change per commit; commit message style:
  `v1.6.x: kort beskrivning`. No wholesale refactors.
- `loop()` must stay non-blocking (heartbeat + wifiVakt + button debounce
  live there). No `delay()` in handlers beyond the existing brief ones.
- Backward compatibility: `/bild`, `/api/plus`, `/api/minus` are consumed
  by the external `bolldetektor.html` (fire-and-forget no-cors) — do not
  rename or change semantics.
- Safety in code: never move the motor without an explicit user action;
  never leave EN low after a movement.

## Build & flash

Arduino IDE (or arduino-cli): board **XIAO_ESP32S3**, **PSRAM: OPI PSRAM**
(camera requires it). Libraries: WiFiManager (tzapu), ESP32 core (camera,
Preferences, Ticker, ESPmDNS bundled).

Post-flash checklist (serial 115200):
`=== EverFlo fjarrkontroll v1.6.x startar ===` → `Kamera OK` (PID logged) →
`Ansluten! IP: ...` → `Streamserver: port 81 OK` → `=== Redo ===`;
LED heartbeat 1 s/4 s; page loads, footer shows the new version; `/bild`
returns a JPEG; +/− move the motor and `Lage:` logs tick.

Claude Code can compile-check, but **every change must be flashed and
verified by the user before it reaches the unit at my mother's** — it runs
unattended there. Remote recovery exists ("Starta om enheten" link /
`/api/omstart`), USB power-cycle is the manual fallback.

## Wishlist / backlog
- CORS header on JSON APIs (gives bolldetektor.html readable responses)
- `/api/glomwifi` (force portal without physical access)
- ArduinoOTA (flash over wifi — unit lives at my mother's)
- DEG_PER_TRYCK calibration against the ball position
- Integrate improved ball detection (separate track: labeled image dataset
  exists; detection currently in browser-side bolldetektor.html)
