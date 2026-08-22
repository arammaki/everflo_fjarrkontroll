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
| Motor | NEMA 17 pancake (17HE08-1004S), 0.9°... driven 1/8 microstep? — see stepsPerPress() in code; default 39°/press, adjustable via /api/steg |
| Motor PSU | MB102 breadboard supply, jumper 5V, barrel input **needs 7–12 V** (1117 regulators, ~1 V dropout) |
| Cup | 3D-printed conical cup on the D-shaft (Ø5.18 bore / flat 4.71), M3 set screw against the flat |
| Light | WS2812D-F5, **one** pixel, colour order **RGB** (not GRB). VCC→XIAO 5V, GND→GND, Din→D3. ~22 mA at the level used. Datasheet WS2812D-F5-1261: VIH 2.7 V, so 3.3 V data into a 5 V pixel is in spec |

### Wifi band (measured on site 2026-08-15)
The ESP32-S3 is **2.4 GHz only**. Put the viewing phone on **5 GHz**: when
both ends sit on 2.4 GHz every byte crosses the congested band twice
(phone → AP, AP → device), and the phone's radio is far worse than the
AP's. Symptom when they share the band: `/bild` trickles in like an old
modem, 6–7 s for a 30 kB frame, while a 5 GHz laptop stays fast at the
same moment. Moving the phone to 5 GHz fixed it outright.

Device-side RSSI is logged with every cloud upload, so the effect of
moving the unit or its antenna can be measured: press a button to force an
upload and compare. Seen so far: −55 to −68 dBm.

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
| D3 | WS2812 Din (the meter light) — see below | — |
| GPIO21 | onboard LED, **active LOW** (heartbeat 1 s on / 4 s off) | — |

TMC clone rows, position 1 = the "TMC2209 V2.0" text/big-capacitor end,
position 8 = the potentiometer/gold-hole end:
- **Black row (power) 1→8:** GND, VDD, 1B, 1A, 2A, 2B, GND, VM
- **Red row (logic) 1→8:** DIR, STEP, CLK, UART, UART, MS2, MS1, EN
- Motor coils: black+blue = coil A → 1A/1B; green+red = coil B → 2A/2B.
- VREF ≈ 0.6 V (pot center vs GND, measured with VM powered, motor unplugged).

### The meter light (v1.10.0)
One WS2812D-F5 pixel on **D3**, aimed at the flow meter. VCC→XIAO 5V,
GND→GND, Din→D3, ~22 mA at the level used. Dupont jumpers, like everything
else in the rig — nothing here is soldered — and the pixel's three are taped
down, so that end is the least likely in the build to work loose. That 5V pin is USB VBUS and 22 mA
is not what iron rule 1 is about — that rule is the motor rail, which is amps
and still comes from the MB102 alone.

**It replaces the desk lamp.** The unit stands in the kitchen (that is the
point of a remote control), and a small desk lamp has been burning on the
meter around the clock so the night picture is readable. So constant light is
already the accepted state of the room, and `LED_ALWAYS_ON 1` is the default
for the detector's sake, not for convenience: in daylight the ambient
dominates and the pixel is a small fixed addition, whereas a light that comes
and goes would put every frame in one of two lightings on top of an ambient
that already varies. One lighting is the only thing a calibration can be
bound to. Set `LED_ALWAYS_ON 0` if it turns out too bright for a kitchen at
night — the conditional path (lit 3 s after a capture, 60 s after a UI
heartbeat, `LED_SETTLE_MS` before a cold capture) is compiled in and tested.

- **One brightness, `LED_LEVEL 50`** (~20%, neutral white; 153 was the first
  guess, 50 was chosen on the rig 2026-08-22). A dim idle plus a
  bright flash per frame is the obvious design and the wrong one: the control
  panel polls `/bild` at 1 Hz, so it would strobe over the meter, and every
  analysed frame has to be lit identically anyway.
- **Colour order is RGB, not GRB** for this part (`LED_ORDER`). It is only
  observable through `/api/led-test` — the working light is white, where
  R=G=B. If the test shows green where the code says red, switch
  `LED_ORDER` to `LED_COLOR_ORDER_GRB`.
- **No library.** The ESP32 core 3.x ships `rgbLedWriteOrdered()`, which is
  the same RMT driver with the colour order as a parameter. Adafruit_NeoPixel
  would add a dependency the IDE and every build host has to have installed,
  for nothing. (`neopixelWrite()` also exists but is deprecated in core 3.3.11
  and logs a warning per call.)
- **The cloud upload is lit too**, not just `/bild`. `uploadFrame()` takes its
  own frame from `loop()`, with nobody watching. Leaving it dark would mean
  every periodic frame is captured in the wrong light and refused by the
  contrast gate — the archive going dark exactly where it is the only record.
- **The pixel is written from two FreeRTOS tasks** (the port-80 httpd task and
  `loop()`), so every write holds `ledMutex` — including the compare in
  `ledApply()`, which both tasks run. The pixel is also rewritten every
  `LED_REFRESH_MS`: a WS2812 latches what it was last sent with no readback,
  so a frame corrupted by the stepper switching a few centimetres away would
  otherwise stay wrong until a reboot while the firmware believed the meter
  was lit.
- **The colour test advances on loop time, not on the clock.** `loop()` blocks
  for seconds inside `uploadFrame()`'s TLS POST and up to a minute inside
  `checkFirmware()`, so a step derived from `millis() - start` skips colours —
  or finds the test already over on its first pass and logs "done" having
  shown nothing. Tapping the button five seconds after a press, while the
  press upload is going out, is the way to hit it. Running long is harmless;
  a skipped green reads as "the batch is GRB" and costs a reflash and a drive.
- **`LED_ALWAYS_ON 0` does not light the port-81 stream.** `h_stream` captures
  without stamping `lastCaptureAt`, so a direct viewer of `:81/stream` sees a
  dark meter unless something else is lighting it. No shipped UI uses the
  stream, so this is left alone rather than given the LED a third writing
  task — but know it before debugging over that port with the flag flipped.
- **`/api/led-test` does not block.** All port-80 handlers share one task, so
  a four-second colour cycle inside the handler would freeze the +/− buttons
  with it. It sets a flag, answers `{"ok":true}` at once, and `ledTestUpdate()`
  in `loop()` runs the sequence.
- Endpoints, all CORS: `GET /api/ui-pulse` → `{"ok":true}`, no PIN (passive,
  and the cross-origin control panel cannot know a PIN — same reasoning as
  `/api/status`); `GET /api/led-test` → `{"ok":true}`, PIN-checked;
  `GET /api/light` → `{"on":,"level":,"rgb":,"standard":,"always":}`,
  PIN-checked. Both UIs call `/api/ui-pulse` every 20 s while visible.
- **`/api/light` is RAM only, same contract as `/api/steg`** — `?on=0|1`,
  `?level=0..255`, `?rgb=RRGGBB`, and every restart puts `LED_LEVEL` and white
  back. That revert is the whole safety model: a level is picked by watching
  contrast and ambiguity move on the control panel, not by taste, so the
  slider has to be free — but the calibration is bound to one lighting, so a
  unit left in a half-finished experiment reads wrong. Here the way out is a
  power blip rather than a trip. The panel says "AVVIKER från det
  inkompilerade ljuset" in red whenever the values differ, and every change is
  written to `/log`, because a non-default light is what explains a week of
  odd readings. **What a session finds gets baked into `LED_LEVEL` and
  reflashed** — it is not left living in RAM.

**The light invalidates the calibration.** A new labelled sweep is required,
and it must be taken in exactly the lighting the system will then run in — so
if the desk lamp is going away, the sweep happens with the lamp off and the
pixel on. Sweeping with both and running with one bakes in a lamp that is not
there any more.

### Iron rules (never violate, never "optimize away")
1. VM never from the XIAO. 2. Beep-test the EN wire (D2 ↔ red pos 8) after any
   rewiring, before power. 3. Never plug/unplug motor or any wire under power.
4. EN idles HIGH (motor free) — that IS the manual override; never hold the
   motor energized outside an actual movement.

## Firmware architecture (v1.9.0)

Single sketch `everflo_remote_control.ino`. Key pieces:
- **WiFiManager**: portal SSID "Syrgas-setup", 15 s × 3 connect attempts,
  120 s portal timeout, restart on failure. `wifiWatchdog()` in `loop()`
  heals runtime drops (3 × 15 s reconnects → `ESP.restart()`).
- **mDNS**: `syrgas.local`.
- **Device page** (v1.8.4): the only technician link left is "Starta om
  enheten", the documented remote-recovery path. Zeroing the counter moved
  to the control panel: the patient never needs it, it sat behind a confirm
  dialog on the page she uses daily, and the counter it resets is
  informational — the cloud log now carries the actual signed turn of every
  press, which is a better record than a count of presses of unknown size.
- **Device page** (v1.8.0): picture, the reading, then MINDRE and MER side
  by side. The reading is computed **in the phone**: the device serves the
  detection engine at `/motor.js` straight from flash, and the page draws
  `/bild` into a canvas, orients it the same way the control panel does,
  and runs `analyze()`/`judge()` once a second. Nothing to transfer to a
  phone — she just opens `syrgas.local`. The engine is a separate asset on
  purpose: `h_index` copies the page into a String per request, and ~90 kB
  of engine would not fit in heap, and it is requested as
  `/motor.js?v=<FW_VERSION>` so a version bump busts its year-long immutable
  cache. When the engine refuses, the page shows
  its Swedish reason instead of a number, and a stale frame clears the
  number as well as dimming the picture — a number that outlives the frame
  it came from is the one thing this page must never show.
- **Device page** (v1.7.4): picture, then MINDRE and MER side by side
  (minus left, plus right). No position counter — it is informational only,
  drifts as soon as the knob is turned by hand, and a number that looks
  authoritative next to the picture invites trusting it over the picture.
  The page therefore no longer polls `/api/status` at all.
- **Web server port 80**: `/` (UI), `/api/plus`, `/api/minus`,
  `/api/nollstall`, `/api/omstart`, `/api/status`, `/api/steg`,
  `/api/ui-pulse`, `/api/led-test`, `/api/light`, `/log`,
  `/bild`. All JSON APIs and `/bild` send `Access-Control-Allow-Origin: *`
  (since v1.7.1) — the companion `everflo_control_panel.html` runs from a
  different origin and depends on it. See the Web UI section.
- **`/api/steg`**: GET returns `{"steg":N,"min":4,"max":180,"standard":39}`
  (degrees per press); `?v=N` sets it, clamped to compiled 4..180, RAM only
  (reboot = compiled default `DEG_PER_PRESS`). Invalid/negative/empty `v`
  is ignored.
- **Stream server port 81**: `/stream` MJPEG, viewer-kickout via
  `stream_gen` (newest viewer wins), `lru_purge_enable`, 5 s send/recv
  timeouts. The main page does NOT use it — it polls `/bild` (relative URL)
  ~4 Hz, chained via `onload` with 1 s error backoff. Keep it that way:
  Safari+mDNS on port 81 is flaky and a wedged stream must never take down
  the UI.
- **Stale-image warning** (v1.7.1): the device page dims the picture and
  covers it with a red banner after 5 s without a fresh frame. The +/−
  buttons stay enabled on purpose (decided 2026-08-15): locking them would
  remove the remote control exactly when something is wrong, and the
  physical knob is at the patient's home, not the operator's. Warn hard,
  do not lock.
- **Camera**: `CAMERA_GRAB_WHEN_EMPTY`; `KAMERA_VFLIP`/`KAMERA_HMIRROR`
  defines exist; display rotation is done in the page CSS
  (`rotate(90deg) scaleX(-1)`), not in the sensor.
- **Position counter** `position` persisted via Preferences; survives power
  loss (verified). Informational only since v1.7.0 — MIN_LAGE/MAX_LAGE
  removed (manual knob turns / cup slip made them unreliable; the camera
  is the source of truth).
- **`DIRECTION -1`** (verified on-site): flips motor direction for both
  buttons; never "fix" direction by swapping button handlers — that inverts
  counter semantics.
- `FB-OVF` log lines from cam_hal are harmless (frame buffer overflow when
  frames outpace the viewer).

## Conventions

- **Language split** (since 2026-08-15, was all-Swedish before):
  - **English**: identifiers, comments, serial/`/log` messages, commit
    messages (the last of these since 2026-08-17).
  - **Swedish**: every string the operator or patient reads — the device
    page, the control panel UI, the `judge()` reason texts. She does not
    read English. Never translate these.
  - **English**: file names, the sketch directory, and cloud resource
    names (D1 `everflo`, R2 `everflo-images`). Arduino constraint: the
    sketch folder and the `.ino` must share a name, so renaming one means
    renaming both — and IntelliJ then has to reopen the project.
  - **Unchanged, in either language**: wire formats. URL paths
    (`/bild`, `/api/nollstall`, `/api/omstart`, `/api/steg`), JSON field
    names (`lage`, `steg`), the NVS key `"lage"`, and the localStorage
    keys (`ev_logg`, `ev_host`, `ev_rot`, `ev_spegel`). Renaming the NVS
    key loses the stored position; renaming the rest breaks the control
    panel or the user's saved settings.
  - **Still Swedish, deliberately**: the saved calibration image prefix
    `bild_<flow>L_<timestamp>.jpg`. The existing labelled dataset and the
    (external) test suite parse it. Change it only together with a fresh
    labelled sweep, and say so out loud when you do.
- **Bump `FW_VERSION` on every behavioral change, including engine-only
  changes** — the page footer shows it, it is how the user verifies a flash
  actually took, and it is also the cache key for the engine: the page loads
  `/motor.js?v=<FW_VERSION>`, which is served immutable for a year. Forget the
  bump after an engine change and a phone that cached the old engine keeps
  running it after a correct flash. That happened on 2026-08-16 — three
  recalibrations landed while the version stayed 1.8.9.
- **Minor vs patch** (rule adopted 2026-08-22, because there had not been
  one): **minor** when flashing is not the whole job — new hardware, a new
  library, or a recalibration is required. **Patch** when flashing is all
  there is to do. 1.7.0 and 1.8.0 fit it in hindsight (new API contract; the
  page began computing a reading); 1.9.0 did not — it was a bug fix, and the
  only thing pushing it over was habit, since 1.8.10 was available. These
  fields are numbers, not digits, which is also what makes 1.10.0 a step up
  from 1.9.7 rather than a step back. Nothing sorts them anyway: the
  firmware, the Worker and `publish_firmware.mjs` all compare for equality
  only — so the rule is for humans reading the log, and its only real duty is
  to say "this one needs more than a flash".
- One focused change per commit; commit message style for firmware changes:
  `v1.7.x: short description`. No wholesale refactors.
  **Commit messages are English** (since 2026-08-17; earlier history is
  Swedish and stays that way). They sit with the code, not with the patient.
- `loop()` must stay non-blocking (heartbeat + wifiWatchdog + button debounce
  live there). No `delay()` in handlers beyond the existing brief ones.
  Two deliberate exceptions, both updates: `ArduinoOTA.handle()` blocks for the
  whole transfer once one starts, and `checkFirmware()` blocks for the whole
  download. The heartbeat freezes and the watchdog pauses for that minute. It
  is accepted because an update is a bounded, human-initiated act and the
  device has nothing better to do — see the OTA sections. Do not copy the
  pattern for anything periodic.
- Backward compatibility: `/bild`, `/api/plus`, `/api/minus` are consumed
  by the companion `everflo_control_panel.html` (fire-and-forget no-cors)
  — do not rename or change semantics.
- Safety in code: never move the motor without an explicit user action;
  never leave EN low after a movement.

## Build & flash

Arduino IDE (or arduino-cli): board **XIAO_ESP32S3**, **PSRAM: OPI PSRAM**
(camera requires it). Libraries: WiFiManager (tzapu), ESP32 core (camera,
Preferences, Ticker, ESPmDNS bundled).

Post-flash checklist (serial 115200):
`=== EverFlo remote control v1.7.x starting ===` → `Camera OK` (PID logged) →
`Connected! IP: ...` → `Stream server: port 81 OK` → `=== Ready ===`;
LED heartbeat 1 s/4 s; page loads, footer shows the new version; `/bild`
returns a JPEG; +/− move the motor and `Position:` logs tick.

Since v1.10.0 also: `Light: WS2812 on D3, constant` in the boot log and the
pixel actually lit, then `syrgas.local/api/led-test` from any browser — red,
green, blue, white, one second each. **Green where the code says red means
the batch is GRB**: switch `LED_ORDER` to `LED_COLOR_ORDER_GRB` and reflash.

Claude Code can compile-check, but **every change must be flashed and
verified by the user before it reaches the unit at my mother's** — it will
run unattended there. Remote recovery exists ("Starta om enheten" link /
`/api/omstart`), USB power-cycle is the manual fallback.

## Web UI (balldetector.js, build_webui.mjs, two HTML pages)

Architecture: the firmware serves its own minimal control page
(camera picture + buttons) at syrgas.local. The HTML files in this
repo are NOT served by the device — they are companion pages opened
directly in a phone/desktop browser, talking to the device cross-
origin. `everflo_control_panel.html` polls `http://<host>/bild`,
analyzes frames in JS, shows flow, drives the knob motor via
`/api/plus|minus`, logs data, and saves labeled calibration images
(`bild_<flow>L_<timestamp>.jpg`). `everflo_image_diagnostics.html`
analyzes saved images offline with per-gate diagnostics.

Two shell invariants (both are bug fixes — do not "simplify" them away):
`saveImage()` repaints the canvas from the last clean frame before
export, because the green detection marker is drawn inside the ball
band and would otherwise be burned into the calibration images. Any
path that fails to produce a fresh valid reading (lost contact, failed
analysis) must clear the big number and `lastFlow` — a stale value
left on screen reads as current and would also be logged with a fresh
timestamp.

CORS is load-bearing: because the pages run from a different origin,
`/bild` must keep sending CORS headers (Access-Control-Allow-Origin)
or canvas getImageData is blocked and all flow analysis silently
breaks. Any new endpoints the pages read need the same headers —
`/api/steg` already sends them (v1.7.0). Motor calls use no-cors and
are fire-and-forget by design.

### Calibration is baked in — do not regenerate casually
Both files embed a reference image (median of the 23 labelled frames of the
2026-08-22 sweep, 20:06-20:14, taken under the WS2812 at level 50 in a dark
kitchen, 8-bit grayscale — the engine converts to gray as its
first step, so color would only triple the file for data it discards) and
a quadratic y->flow calibration bound to the exact camera pose and 4:3
aspect ratio at calibration time. A physical camera move, refocus, or
aspect change invalidates it: a new labeled sweep ("Spara bild") and
regenerated constants are required. Rotation/mirror changes are
lossless and compensated by the UI rotation control instead — never
change firmware camera settings (resolution, hmirror, vflip, format).
The camera was moved and everything regenerated on 2026-08-16; the
earlier sweep and its `0.1L` mislabel no longer apply.

**A lighting change invalidates it too.** Done for the WS2812 on 2026-08-22:
new sweep, new reference, new bands, new curve. Take any future sweep in
exactly the lighting the unit will then run in — a reference that averages two
lightings bakes in one that is about to go away.

Measured over that sweep: mean error 0.030 L/min, worst 0.110 — and that worst
is a single frame whose label disagrees with its own neighbours by 0.1
(y=316.8 interpolates to 2.40 between its 2.0 and 2.5 neighbours; the engine
says 2.41 and the label says 2.3), so worst against the rest is 0.059.
Margins: contrast 0.173 (gate 0.10), ambiguity 15.9x (3.0), registration
**0.982** (0.75), spread 38 (75). Registration is the one to note — the
previous calibration's worst frame sat at 0.783 against a 0.75 gate, i.e. on
the edge, and CLAUDE.md said so as "where this will break next". The new
camera pose with its own light is nowhere near it, and every frame reports
zero tilt deviation and under a pixel of dx/dy.

The bands moved with the camera: ball 246..278 -> **253..285**, anchor
222..250 -> **233..261**, window 120..455 -> **125..466**, BASE_TILT
-0.0209 -> **+0.066** (3.78 degrees, confirmed against a line drawn along the
tube by hand: 3.7). Each was measured over the sweep, not carried over — see
the comments at each constant for what was tried and what it cost.

### The engine has one source: `balldetector.js`
Edit the detection engine **only** in `balldetector.js`, then run
`node build_webui.mjs`. The script inlines it verbatim into both HTML
pages between the `ENGINE:BEGIN`/`ENGINE:END` markers, generates
`balldetector_js.h` for the sketch to serve at `/motor.js`, and verifies
the two page copies came out byte-identical. The header is generated too,
so an engine change reaches the device page only after a reflash. `node build_webui.mjs --check` exits
non-zero when a page is out of date — run it before committing.

Everything between the markers is generated and will be overwritten
without warning. Do not hand-edit it.

The pages remain self-contained single files on purpose (the engine and
the ~100 kB `REF_PNG` are inlined, not linked): they are opened straight
from the filesystem on a phone, where a relative `<script src>` does not
load reliably. Duplication is therefore deliberate — but generated.

Why this matters: when the engine was hand-maintained in two places, a
partial rename left `judge()` reading `T.kontrast` while `T` defined
`contrast`. The comparison became `value < undefined` — always false —
and that quality gate silently stopped rejecting anything (2026-08-15).

### Engine invariants
Grayscale -> flatfield (3-pass box blur ~ sigma 41) -> horizontal
registration (column profile of rows 100-460) -> vertical registration
against scale ticks (anchor band x 296-320, sampled at the shifted x) -> clipped
difference vs reference in ball band (x 252-292) -> smoothed profile ->
peak + centroid -> quadratic calibration. Never remove the quality
gates (registration >=0.75, contrast >=0.10, ambiguity >=3.0x,
|dx| and |dy| <=20 px, extent <=75 rows): the engine must say "no reading"
rather than output a plausible wrong number — it reads oxygen flow for
a patient. States: y<132 -> "Max", a sanity guard only —
the sweep labels the whole physical range, min (y=434, reads 0.25) up to
6 L/min (y=139), so nothing the knob can reach is extrapolated any more.
y>439 (Y_CAL_MAX+12) -> "Under 0.3".

**The peak search window is the ball's physical range, not the picture's.**
`YTOP=120, YBOT=455` (reference rows; dy is already removed when the difference
profile is built, so the window does not move with the camera). The ball cannot
leave y 139 (6 L/min) .. 435 (its resting stop) and its blob is about 20 rows
wide, so everything outside is by construction not the ball. Letting it compete
cost two whole afternoons: from 2026-08-16 13:09 and 2026-08-17 12:51 UTC low
sun put a bright edge just under the old `YTOP=60`, and its clipped tail beat
the real ball. 40 of 164 uploaded frames were refused as "two equally strong
candidates" while the ball sat in plain sight, correctly found, at the right y.
The mirror image of that is the chrome nut below the tube (y 465-495), whose
specular highlight is blown out in the reference and dull in flat light — it was
`min`'s nearest rival in the sweep all along (ambiguity 17.2x -> 36.6x once
excluded). Measured: YTOP 100..125 and YBOT 445..460 are one flat plateau, all
164 uploads read, worst ambiguity 4.1x. Outside it the failure is immediate —
YBOT 470 loses 8 frames, YTOP 90 loses 3, YTOP 130 clips the 6 L/min frame.
YTOP must stay under Y_MAX_STATE (132) and YBOT over Y_CAL_MAX+12 (439) or
those two states become unreachable.

**Registration is where this will break next.** Once the window stopped
manufacturing false ambiguity, `reg` became the tightest gate: 0.783 on the
worst afternoon frame against a 0.75 threshold. All ten frames at the bottom of
that list are glare frames, and on ten of them the tilt search sits pinned at
the -3 degree edge of its range — it is absorbing a lighting gradient, not
measuring a camera tip. The readings there are still right (1.91-1.96 where the
same knob position reads 1.965), so nothing is broken; but a brighter afternoon
takes `reg` under the gate and the frames go back to being refused, this time
for a different reason. Widening `TILTS` is NOT the obvious fix — see the
warning above about what a wider tilt search buys. Re-measure before touching.

**`BASE_TILT` is negative, and the sign is the whole trap.** The tube leans
about 1.2 degrees anticlockwise in the upright picture, but analysis runs on
a MIRRORED canvas — the control panel applies `scale(-1,1)` before handing
pixels over — and a mirror flips the sign of a tilt. So the constant carries
the opposite sign to the angle anyone measures on screen. Entering the
measured sign directly tilts the bands the wrong way and doubles the
misalignment: that was done on 2026-08-16, and the mistake read as "tilt does
not help" because a sweep that only tried the positive side saw the whole
range fall away from the optimum.

Measured with the real engine over the labelled sweep at 0.1-degree steps,
-1.2 degrees against 0: worst error 0.082 -> 0.078, lowest contrast
0.193 -> 0.198, lowest ambiguity 9.7x -> 14.1x. Accuracy hardly moves; the
margin to the quality gates is what improves, which is the point.

**The optimum is narrow — do not nudge this constant by eye.** Past it the
ambiguity margin falls off a cliff: 14.1x at -1.2, 6.5x at -1.5, 3.9x at -1.8,
against a gate that rejects below 3.0. Re-measure across the sweep instead.
The apparent lean also varies across the tube (0.6 degrees at its left, 1.7 at
its right — perspective on a round glass cylinder), so no single number is
"correct" by measurement alone; the sweep picks it.

Tilt is still searched per frame over roughly +/-3 degrees AROUND that base,
so the search finds how far the camera has tipped SINCE calibration. `analyze()`
reports that deviation, not the absolute angle, and `opts.tilt` overrides the
deviation too — 0 means "as calibrated" everywhere a tilt is shown or entered.
The objective is
registration quality — not peak cleanliness. An objective the ball detector
influences could be optimised into a confident wrong answer. Measured
2026-08-16: with the camera tipped 1 degree, compensating raised ambiguity
from 2.2x to 3.6x and dropped extent from 73 to 33.

**The magnitude gates stay even when every quality gate passes.** After a
34 px slide the engine finds the ball confidently — all gates green — and
still reads 1.73 where the truth is 2.0. The gates measure how well the
ball is *found*; the y->flow curve is bound to the camera pose and degrades
with it in a way no gate can see. Confidence is not accuracy.

**Order matters**: dx is computed first, because the camera slides sideways
and every band below is at a fixed x — measured 34 px on 2026-08-16. Sample
the anchor band at its old x after a sideways slip and dy is meaningless.
The search runs to +/-40 px while the gate rejects beyond 20: a big shift
should be measured and named in the Swedish reason, not silently saturate
at the edge of the search and look like noise.

`buildRef()` is the one place that knows what REF contains — `loadRef()`
uses it in the browser, `validate_engine.mjs` in Node. Add a field there,
never in the callers.

All of those numbers come from the sweep, not from taste: the bands were
measured as the columns where the ball actually moves and where the
printed scale actually is, and each threshold sits well below the worst
value the 27 labelled frames produced.

### Testing
Validated headless (Playwright) against the FIRST sweep: 20 labeled
images (LOO MAE 0.05), a negative suite (garbage frames, occlusions,
large shifts, wrong rotation must be REJECTED), and a tolerance suite
(15 px shift, blur, thin occluder must still read ~correctly). That
suite has NOT been rerun against the 2026-08-16 calibration — the
negative and tolerance cases are the part `validate_engine.mjs` does not
cover, and `reg >= 0.75` in particular was chosen by that negative
suite, not by the sweep.

**In this repo**: `node tools/validate_engine.mjs <dir with bild_*.jpg>`
runs the real `balldetector.js` against the labelled images and fails
(non-zero) on any rejection or a reading more than 0.2 L/min off its
label. No npm packages, no browser — it decodes with macOS `sips`. Run it
after every engine change. Measured 2026-08-16 against the second
sweep: mean 0.031 L/min, worst 0.078, 24 read, 0 rejected. The first sweep
now fails three frames against it, which is correct — it is a different
camera pose.

The sips decoder and the browser's now have a much stronger result behind
them than "lands on the labels": run over the same 124 uploaded frames the
admin page had already analysed in Chrome, the offline harness reproduced
every reading to 0.000 L/min with no state disagreement. So an engine change
can be scored offline against real traffic and the answer is what the phone
will show. That is not proof the decoders agree on every possible JPEG, but
it does mean a server-side reading is a decoding question already answered
for this camera.

**The uploaded frames are a second, unlabelled test set — and the device
labels them for free.** Between two `press` rows the knob has not moved, so
every frame in that span shows the same flow (the user's observation,
2026-08-17). That gives three checks no sweep can give: a rejected frame
whose neighbours in the same span DID read has a known truth; every accepted
frame in a span must agree with the others; and a span where the value jumps
without a press means someone turned the knob by hand. All three were used to
choose YTOP/YBOT. Tolerance is about 0.05 L/min, not zero — the ball floats
and genuinely bobs that much (seen as 4.95 / 5.00 / 4.97 in one still span).

Beware the third check when using the second: id 218 (2026-08-16 13:09 UTC)
looks like a confidently wrong reading of 4.37 against a "truth" of 2.63 from
its span, and is nothing of the sort — the ball really had moved to 4.3 and
the picture shows it. An anchor from a span is a hypothesis. Look at the
frame before believing it over the engine.

The labelled images themselves are not in the repo (they are the user's);
the Playwright suite that does leave-one-out lives outside it too.

### The control panel is two columns on a laptop
`#cols` wraps `#view` (rotation/mirror, the picture, the reading, the quality
line) and `#panel` (everything else). One column below 920 px — the phone
layout is untouched — and side by side above it, with `#view` sticky so the
picture stays put while the controls scroll. Anything added to the page now
goes inside one of those two wrappers.

The breakpoint is deliberately high: two columns narrower than what the phone
layout gives would make the desktop worse than the phone. And `canvas` is
capped at `calc(100vh - 290px)` in the wide layout rather than left free —
the reading and the quality line still sit under the picture, and a picture
free to fill the viewport pushes the number this page exists to show below
the fold.

### The control panel's light section (v1.10.0)
`<details id="light">` on `everflo_control_panel.html` only — never on the
device page. On/off, a 0-255 brightness slider and a colour swatch, all
talking to `/api/light`, plus a "Färgtest" button for `/api/led-test`. It
loads the current state on "Starta" with a plain GET, which changes nothing.
Purpose: the light level for a detector is chosen by watching entydighet and
kontrast respond, and those numbers are already on this page.

### Deployment safety
The system will run live at a patient's home (not yet deployed).
**Never automatic.** An update happens only because a human pushed one; the
device must never look for a build and install it on its own. That rule is
older than OTA and survives it — see "Over-the-air update" below for how each
mechanism keeps it. Keep the previous firmware as a fallback: there is no
bootloader rollback, so a bad image is recovered over USB. Current UI needs
only `/bild` +
`/api/plus|minus` (stable since v1.6.6). `/api/steg?v=N` (implemented
in v1.7.0) adds adjustable step size: clamped in firmware to compiled
4–180°/press, RAM only, reverts to default 39°/press on reboot. The
control panel exposes it as a free number field and shows the value the
firmware actually applied after clamping.

### Over-the-air update (v1.9.2)
ArduinoOTA on port 3232, hostname `syrgas`, so the unit shows up as a network
port in the Arduino IDE. Password-required: `OTA_PASSWORD` in `secrets.h`, and
with no password compiled in OTA stays **off** rather than open. This port can
replace the firmware driving a motor bolted to an oxygen concentrator, so
"whoever is on her wifi" is not an access policy. Same caveat as the other
secrets — esptool can read the password back out of the image, so it defends
against the network, not against someone holding the device.

Two interlocks, and both halves are needed because `move()` runs on the web
server's task while `ArduinoOTA.handle()` runs in `loop()`: `loop()` withholds
`handle()` while `busy`, and `move()` refuses while `otaActive`. Without the
second, a button pressed mid-update turns the knob while the app partition is
being rewritten.

`ArduinoOTA.setMdnsEnabled(false)` is deliberate. mDNS is already up from
`setup()`, and `ArduinoOTA.begin()` would call `MDNS.begin()` a second time,
which fails with "already initialized" and logs what looks like a fault. The
`_arduino._tcp` record is registered by hand instead — that record is what puts
the device in the IDE's port list.

**The update gets the whole machine** (v1.9.6). Both paths stop the camera and
both HTTP servers before anything touches flash, and the receive timeout is
raised from the library's 1000 ms to 5000 ms. The first real attempt died at 9%
with "receive failed": a flash write on an ESP32 disables the cache and stalls
every other task, and this device also grabs frames without ever idling and
answers on two ports, so nothing was left to service the incoming stream.
Order inside `otaQuiesce()` is load-bearing — servers first, camera last,
because `httpd_stop()` blocks until a running handler returns and the reverse
would free frame buffers under a request still being served. `otaResume()`
tears down before bringing up so a double call is harmless, which matters
because ArduinoOTA's connect-failure branch calls the error callback twice; and
if the camera will not come back it restarts the device rather than sit blind.

**LAN only.** espota talks to the device directly, so this removes the cable
from a visit, not the visit. No bootloader rollback either: the Arduino core
does not enable it, so a firmware that boots badly still needs USB. What makes
that acceptable is that the concentrator does not depend on the ESP32 at all —
the driver idles disabled, the knob turns by hand, and a bricked unit costs the
remote control, not the oxygen.

### Cloud-pull OTA (v1.9.3, certificate pinned in v1.9.4) — update from anywhere
The device asks the ingest Worker every 15 minutes whether a human has left a
build waiting. It never pushes, and the device never chooses. Two verbs keep
the old rule intact:

```sh
node tools/publish_firmware.mjs publish build/…/everflo_remote_control.ino.bin 1.9.3
node tools/publish_firmware.mjs arm 1.9.3        # the separate, deliberate act
node tools/publish_firmware.mjs status | disarm
```

Publishing is inert — the build sits in R2 and the device is told nothing.
Arming is what lets a unit at a patient's home replace its own firmware, so it
costs its own command. A single `deploy` verb would make the dangerous thing
the easy thing. `firmware.armed_at` carries this, and a partial unique index
(`firmware_one_armed`) makes "at most one armed build" a property of the
database rather than of the tool that writes it.

`arm` **is a production action**: the unit installs within 15 minutes and
reboots. Only ever arm a build that has already been seen to boot over cable or
ArduinoOTA — there is no rollback, and recovery is a trip with a USB cable.

The loop closes on the device's own report: the ingest handler clears
`armed_at` when a reading arrives carrying that version. So "armed" means
"waiting to land", and a build that bricks the unit stays armed — correctly,
because it never landed. `lastFwCheck` is seeded to `millis()` rather than 0 so
a unit in a boot loop cannot ask for the build that is crashing it seconds
after every boot.

Endpoints (both bearer-token, same token as ingest): `GET /firmware?fw=<current>`
answers 204 for "nothing armed" *and* for "what is armed is what you already
run"; `GET /firmware.bin?v=<version>` streams it with `x-MD5`, which is the
header HTTPUpdate verifies against, and 404s if that version is no longer the
armed one. Content-length comes from the R2 object, never the D1 row — a
disagreement between them would truncate the transfer before the MD5 was ever
checked, so the Worker refuses with 500 instead.

MD5 catches a corrupted download, not a hostile one. Whoever can write the R2
object or the D1 row owns this device. Note the asymmetry that limits the
damage from the device's own credential: the token can only *read* firmware —
arming needs Cloudflare credentials, so a leaked device token cannot install
anything.

**The firmware endpoints are the one place TLS is verified** (`cloud_roots.h`,
added v1.9.4). Everywhere else in the sketch uses `setInsecure()`, which was a
fair trade when a man-in-the-middle could at worst read a picture of a flow
meter or collect a write-only token. It stops being fair when the same
connection can hand the device its next firmware: unverified TLS plus OTA is
remote code execution with extra steps, on hardware bolted to an oxygen
concentrator. Both firmware requests therefore pin the roots the Worker's
certificate actually chains to — GTS Root R4 (what Cloudflare issues from
today) and ISRG Root X1 (because they rotate CAs and a rotation must not brick
the update path). Verified against the live chain 2026-08-17. A move to a third
CA makes verification fail and the update simply not happen, which is the safe
direction, and ArduinoOTA over the LAN is still there to fix it.
`cloud_roots.h` is generated from the macOS system trust store; the roots
expire 2035 and 2036.

Verified end to end 2026-08-17 without the device: publish-does-not-offer,
arm-offers, never-offer-what-it-runs, 1.37 MB downloaded byte-identical to the
local build with a matching `x-MD5`, 403 without a token, 404 on a stale
version, and disarm-on-report. The synthetic reading used for the last one was
deleted afterwards.

## Wishlist / backlog
- Share one frame between simultaneous `/bild` viewers. Today every request
  calls `esp_camera_fb_get()`, so N viewers cost N captures and each sees a
  different frame. The port 80 httpd runs in a single task and handles
  requests sequentially, so a cache touched only by `h_snapshot` needs no
  mutex: a PSRAM buffer plus a timestamp, serving the stored JPEG when it
  is younger than ~200 ms. Do NOT share that cache with `loop()` or the
  port 81 stream server — that would need synchronisation across three
  tasks. Saves capture and JPEG encoding, not bandwidth. Deferred from
  2026-08-15: nothing is broken, it could not be tested before the visit,
  and a cache is a deliberately stale frame in a system whose whole point
  is that the image is current.
- **Rename the Swedish URL paths to English** (`/bild`, `/api/nollstall`,
  `/api/omstart`, `/api/steg`). Agreed 2026-08-22: they are wire format, none
  of it is text the patient reads, and the language split says English there.
  New paths are already being named in English (`/api/ui-pulse`,
  `/api/led-test`). Its own commit, not folded into a feature, and the hazard
  to design around is that **the control panel is deployed by copying a file
  to a phone** — there is no guarantee the copy on her phone matches the repo,
  so a rename can silently kill a panel that has been sitting there since
  summer. Serve both names for a release, then drop the old ones once the
  copies in the wild have been replaced. The NVS key `"lage"` and the
  `localStorage` keys are NOT part of this: renaming those loses stored state.
- `/api/glomwifi` (force portal without physical access)
- ArduinoOTA and cloud-pull OTA both done (v1.9.2, v1.9.3) — see above
