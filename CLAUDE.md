# EverFlo fjärrkontroll — firmware

Remote control for the flow knob on a Philips EverFlo oxygen concentrator,
built so my mother (limited mobility) can adjust her oxygen flow from her
phone. A camera streams the flow meter; the phone page shows the image and
+/− buttons; an ESP32 drives a stepper that turns the knob via a 3D-printed
friction cup. **The camera image is the source of truth — the human always
verifies visually. Manual override must always work: the motor is
de-energized except during an actual press.**

This is assistive/medical-adjacent equipment intended for real daily use —
not yet deployed (as of Aug 2026). Correctness and predictability beat
cleverness. When in doubt: smaller change, bump version, let the user flash
and verify.

## Hardware

| Part | Details |
|---|---|
| MCU | Seeed XIAO ESP32-S3 **Sense** (OV3660 camera, PID 0x3660; OV2640 also supported by PID check) |
| Driver | TMC2209 clone breakout, standalone/legacy mode (no UART), unmarked — see pin map below |
| Motor | NEMA 17 pancake (17HE08-1004S), 0.9°... driven 1/8 microstep? — see stegPerTryck() in code; default 15°/press, adjustable via /api/steg |
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
  (the companion `everflo_kontrollpanel.html` depends on this — see Web
  UI section). Other JSON APIs currently do NOT send CORS headers
  (wishlist).
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
- One focused change per commit; commit message style for firmware changes:
  `v1.7.x: kort beskrivning`. No wholesale refactors.
- `loop()` must stay non-blocking (heartbeat + wifiVakt + button debounce
  live there). No `delay()` in handlers beyond the existing brief ones.
- Backward compatibility: `/bild`, `/api/plus`, `/api/minus` are consumed
  by the companion `everflo_kontrollpanel.html` (fire-and-forget no-cors)
  — do not rename or change semantics.
- Safety in code: never move the motor without an explicit user action;
  never leave EN low after a movement.

## Build & flash

Arduino IDE (or arduino-cli): board **XIAO_ESP32S3**, **PSRAM: OPI PSRAM**
(camera requires it). Libraries: WiFiManager (tzapu), ESP32 core (camera,
Preferences, Ticker, ESPmDNS bundled).

Post-flash checklist (serial 115200):
`=== EverFlo fjarrkontroll v1.7.x startar ===` → `Kamera OK` (PID logged) →
`Ansluten! IP: ...` → `Streamserver: port 81 OK` → `=== Redo ===`;
LED heartbeat 1 s/4 s; page loads, footer shows the new version; `/bild`
returns a JPEG; +/− move the motor and `Lage:` logs tick.

Claude Code can compile-check, but **every change must be flashed and
verified by the user before it reaches the unit at my mother's** — it will
run unattended there. Remote recovery exists ("Starta om enheten" link /
`/api/omstart`), USB power-cycle is the manual fallback.

## Web UI (everflo_kontrollpanel.html, everflo_bilddiagnostik.html)

Architecture: the firmware serves its own minimal control page
(camera picture + buttons) at syrgas.local. The HTML files in this
repo are NOT served by the device — they are companion pages opened
directly in a phone/desktop browser, talking to the device cross-
origin. `everflo_kontrollpanel.html` polls `http://<host>/bild`,
analyzes frames in JS, shows flow, drives the knob motor via
`/api/plus|minus`, logs data, and saves labeled calibration images
(`bild_<flow>L_<timestamp>.jpg`). `everflo_bilddiagnostik.html`
analyzes saved images offline with per-gate diagnostics.

CORS is load-bearing: because the pages run from a different origin,
`/bild` must keep sending CORS headers (Access-Control-Allow-Origin)
or canvas getImageData is blocked and all flow analysis silently
breaks. Any new endpoints the pages read need the same headers —
`/api/steg` already sends them (v1.7.0). Motor calls use no-cors and
are fire-and-forget by design.

### Calibration is baked in — do not regenerate casually
Both files embed a reference image (median of 21 labeled frames) and a
quadratic y->flow calibration bound to the exact camera pose and 4:3
aspect ratio at calibration time. A physical camera move, refocus, or
aspect change invalidates it: a new labeled sweep ("Spara bild") and
regenerated constants are required. Rotation/mirror changes are
lossless and compensated by the UI rotation control instead — never
change firmware camera settings (resolution, hmirror, vflip, format).
Data note: the calibration image labeled `0.1L` is actually 1.0 L/min
(confirmed mislabel).

### Engine invariants
Grayscale -> flatfield (3-pass box blur ~ sigma 41) -> 1D vertical
registration against scale ticks (anchor band x 415-470) -> clipped
difference vs reference in ball band (x 295-415) -> smoothed profile ->
peak + centroid -> quadratic calibration. Never remove the quality
gates (registration >=0.75, contrast >=0.045, ambiguity >=1.35x,
|shift| <=20 px, extent <=135 rows): the engine must say "no reading"
rather than output a plausible wrong number — it reads oxygen flow for
a patient. States: y<118 -> "Max" (top thick mark, ~5.7 extrapolated);
y>579 -> "Under 0.5" (ball at rest / flow off).

### Testing
Validated headless (Playwright): 20 labeled images (LOO MAE 0.05, 100%
within +/-0.2 L/min), a negative suite (garbage frames, occlusions,
large shifts, wrong rotation must be REJECTED), and a tolerance suite
(15 px shift, blur, thin occluder must still read ~correctly). Any
engine change requires rerunning equivalent tests before deployment.

### Deployment safety
The system will run live at a patient's home (not yet deployed).
Never auto-flash or trigger OTA; flash manually on-site, keeping the
previous firmware as fallback. Current UI needs only `/bild` +
`/api/plus|minus` (stable since v1.6.6). `/api/steg?v=N` (implemented
in v1.7.0) adds adjustable step size: clamped in firmware to compiled
4–45°/press, RAM only, reverts to default 15°/press on reboot. The
control panel does not call it yet.

## Wishlist / backlog
- CORS headers on the remaining JSON APIs (`/api/plus|minus|status|nollstall`)
  — would give `everflo_kontrollpanel.html` readable responses; `/api/steg`
  already has them (v1.7.0)
- Step size control in `everflo_kontrollpanel.html` via `/api/steg`
- `/api/glomwifi` (force portal without physical access)
- ArduinoOTA (flash over wifi — unit will live at my mother's)
- DEG_PER_TRYCK calibration against the ball position