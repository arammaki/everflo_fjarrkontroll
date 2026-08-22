# EverFlo remote control

Remote control and monitor for the flow knob on a Philips EverFlo oxygen
concentrator, so my mother can adjust her oxygen flow from her phone. A XIAO
ESP32-S3 Sense films the flow meter and drives a stepper that turns the knob.

**The camera image is the truth.** Every reading the software produces is a
convenience on top of a picture a human can check — and the software says
"no reading" rather than guess. The motor is de-energized except during an
actual press, so the knob can always be turned by hand.

Design rules and rationale live in [CLAUDE.md](CLAUDE.md). This file is the
map: where things are and what to open.

## On the home network

Reachable from any phone or laptop on the same wifi as the device. Put the
phone on **5 GHz** — the ESP32 is 2.4 GHz only, and sharing that band makes
images crawl.

| URL | What it is |
|---|---|
| `http://syrgas.local` | **The page she uses.** Picture, the reading, MINDRE / MER |
| `http://syrgas.local/log` | Last 40 log lines — the first place to look when something is wrong |
| `http://syrgas.local/bild` | One JPEG, 640×480. What the companion pages poll |
| `http://syrgas.local/motor.js` | The detection engine, served from flash so the page can read the ball |
| `http://syrgas.local/api/status` | `{"ok":true,"lage":N}` |
| `http://syrgas.local/api/steg` | Degrees per press; `?v=N` sets it, clamped, RAM only |
| `http://syrgas.local/api/plus` · `/api/minus` | One press |
| `http://syrgas.local/api/nollstall` | Zero the press counter |
| `http://syrgas.local/api/omstart` | Reboot the device — the remote recovery path |
| `http://syrgas.local:81/stream` | MJPEG. Legacy: nothing uses it, Safari + mDNS is flaky there |

If `syrgas.local` does not resolve, use the IP from the `Connected! IP:` line
in `/log`.

## In the cloud

| URL | What it is |
|---|---|
| `https://everflo-admin.maccer83.workers.dev` | **Uploaded pictures and history.** Behind Cloudflare Access — sign in with the Cloudflare account |
| `https://everflo-ingest.maccer83.workers.dev/health` | Liveness of the ingest Worker (says nothing about the device) |
| `https://everflo-ingest.maccer83.workers.dev/ingest` | Where the device POSTs. Bearer token, device only |
| `https://healthchecks.io/` | The dead man's switch. Alerts ~20 min after the device goes quiet |
| `https://dash.cloudflare.com/` | D1 database `everflo`, R2 bucket `everflo-images`, both EU jurisdiction |

The device uploads a frame at boot, every 15 minutes, and five seconds after
a press series ends. A gap in the history is itself the record that the
device or the network was down — nothing is buffered and resent.

## Pages you open from this folder

Not served by the device: open them straight from the filesystem. They are
self-contained single files on purpose, so they work when AirDropped to a
phone.

- **`everflo_control_panel.html`** — the calibration and diagnosis tool.
  Polls the device, shows the reading with all quality numbers, drives the
  motor, sets the step size, and saves labelled images with **Spara bild**.
  The quality row is also the alignment aid: nudge the camera until `skift`
  is near 0 and `passning` is above 0.95.
- **`everflo_image_diagnostics.html`** — drop in a saved image and get the
  reading with per-gate diagnostics. Offline, no device needed.

## Commands

```sh
# Flash over her wifi. This is the normal way now — you must be on the same
# network. Two steps on purpose: the first is inert and shows you the version,
# size, md5 and target, the second replaces the firmware and reboots the unit.
./tools/ota_flash.sh                 # build, then show what would be sent
./tools/ota_flash.sh -y              # ... and send it
./tools/ota_flash.sh 192.168.1.21 -y # by address; default is syrgas.local

# First flash of a new board, and recovery when a build will not boot.
# There is no bootloader rollback, so this is the only way back.
"/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" \
  --config-file ~/.arduinoIDE/arduino-cli.yaml compile --upload \
  -p /dev/cu.usbmodem2101 --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi .

# Update from anywhere. Publishing is inert; arming is what lets a unit at a
# patient's home replace its own firmware, so it costs its own command. Only
# ever arm a build already seen to boot — recovery is a trip with a cable.
node tools/publish_firmware.mjs publish build/ota/everflo_remote_control.ino.bin 1.10.4
node tools/publish_firmware.mjs arm 1.10.4
node tools/publish_firmware.mjs status | disarm

node build_webui.mjs              # after ANY edit to balldetector.js
node build_webui.mjs --check      # run before committing
node tools/validate_engine.mjs <dir>   # engine vs labelled bild_*.jpg
node tools/score_uploads.mjs <dir>     # engine vs real uploaded frames

cd cloud && npx wrangler deploy   # ingest Worker
cd cloud/admin && npx wrangler deploy
```

## Secrets

`secrets.h` holds the healthchecks ping URL and the ingest token. It is
gitignored; copy `secrets.h.example` and fill it in. Without the file the
sketch still builds, with those features compiled out.

Nothing else in this repo contains a credential. The admin page has no
password — Cloudflare Access guards it.
