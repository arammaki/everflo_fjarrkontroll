#!/usr/bin/env bash
# ============================================================
#  Flash the sketch to the unit over the LAN (ArduinoOTA).
#
#      tools/ota_flash.sh                 # build + show what would be sent
#      tools/ota_flash.sh -y              # ... and actually send it
#      tools/ota_flash.sh 192.168.1.21    # an explicit address, default syrgas.local
#
#  Two commands rather than one with a prompt: the first is inert and tells
#  you the version, size and target, the second replaces the firmware.
#
#  You must be on the same wifi as the device. This replaces the
#  firmware driving a motor bolted to an oxygen concentrator, so it
#  builds first, checks what it is about to send, and says out loud what
#  is going where before it sends it.
#
#  Why a script and not the one-liner it replaces: the one-liner was long
#  enough to wrap, and a wrapped paste is what put the OTA password in
#  the terminal in plain text on 2026-08-17 — it had to be rotated. Here
#  the password is read from secrets.h into espota's argument and is
#  never printed. (It is still visible in `ps` for the duration of the
#  transfer; espota.py has no way to take it from a file or the
#  environment. On a personal laptop that is the residual risk.)
#
#  It ALWAYS rebuilds. The stale-binary trap is real: on 2026-08-22 the
#  binary sitting in build/ was five days old and still said 1.9.7, so
#  flashing it would have been a no-op that looked like a failed change.
#
#  There is no rollback. If a build boots badly, recovery is USB — which
#  is why this is the path for a first boot: you are standing next to it.
# ============================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
FQBN="esp32:esp32:XIAO_ESP32S3:PSRAM=opi"
OUT="$REPO/build/ota"
BIN="$OUT/everflo_remote_control.ino.bin"
ESPOTA="$HOME/Library/Arduino15/packages/esp32/hardware/esp32/3.3.11/tools/espota.py"

HOST="syrgas.local"
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -*)       echo "Unknown option: $arg" >&2; exit 2 ;;
    *)        HOST="$arg" ;;
  esac
done

die() { echo "ota_flash: $*" >&2; exit 1; }

[ -x "$CLI" ]      || die "arduino-cli not found at $CLI"
[ -f "$ESPOTA" ]   || die "espota.py not found at $ESPOTA (esp32 core version changed?)"
[ -f "$REPO/secrets.h" ] || die "secrets.h is missing — OTA needs OTA_PASSWORD"

# Into a variable, never onto the screen.
PW="$(sed -n 's/.*OTA_PASSWORD "\([^"]*\)".*/\1/p' "$REPO/secrets.h")"
[ -n "$PW" ] || die "no OTA_PASSWORD in secrets.h — the device compiles OTA off without one"

VERSION="$(sed -n 's/^#define FW_VERSION "\([^"]*\)".*/\1/p' "$REPO/everflo_remote_control.ino")"
[ -n "$VERSION" ] || die "could not read FW_VERSION from the sketch"

echo "Building v$VERSION ..."
"$CLI" --config-file "$HOME/.arduinoIDE/arduino-cli.yaml" \
       compile --fqbn "$FQBN" --output-dir "$OUT" "$REPO" | tail -2

# The sketch says one thing and the image must agree. Cheap, and it is the
# check that catches a build that silently did not happen.
#
# -F and the whole boot string, not just the number: the dots in a version
# are regex wildcards, and the image is full of build timestamps, so a bare
# grep for 1.10.0 also matches "1:10:0" inside one. The guard only ever runs
# on the unlikely path where the compile failed without saying so, which is
# exactly the path where it must not lie.
grep -qaF "remote control v$VERSION starting" "$BIN" \
  || die "the built image does not carry \"v$VERSION\" — refusing to send it"

SIZE="$(wc -c < "$BIN" | tr -d ' ')"

# -4, and resolve the name once.
#
# curl's --max-time includes name resolution, and resolving syrgas.local took
# a flat 5.0 s here while the same request to 192.168.1.21 took 0.02 s. With
# a 3 s budget every probe died before the name came back, so on 2026-08-22
# this script announced a device that was not answering and sent someone
# after a USB cable — for a flash that had landed perfectly. espota never
# noticed, because Python's socket has no such deadline.
#
# The 5 s is not a misconfiguration and there is nothing to fix on the Mac or
# the router: the ESP32 publishes an A record only, macOS asks for A and AAAA,
# and mDNS has no way to answer "that record does not exist" — a responder
# without one simply stays silent. So the AAAA query waits out its full
# timeout before the resolver falls back to the address it already had.
# Measured: -4 resolves in 0.005 s, -6 in 5.01 s. Browsers do not trip over
# this because Happy Eyeballs proceeds on the A record.
boot_version() { sed -n 's/.*control v\([0-9.]*\) starting.*/\1/p' | tail -1; }
probe() { curl -4 -s --max-time 5 "http://$ADDR/log" 2>/dev/null || true; }

ADDR="$(curl -4 -s -o /dev/null -w '%{remote_ip}' --max-time 10 "http://$HOST/log" 2>/dev/null || true)"
[ -n "$ADDR" ] || ADDR="$HOST"      # unreachable now; try the name later anyway
WAS="$(probe | boot_version)"

echo
echo "  version   v$VERSION"
if [ -n "$WAS" ]; then
  echo "  running   v$WAS"
else
  echo "  running   not answering (or its log ring has rotated)"
fi
echo "  image     $BIN"
echo "  size      $SIZE bytes, md5 $(md5 -q "$BIN")"
if [ "$ADDR" = "$HOST" ]; then echo "  target    $HOST:3232"; else echo "  target    $HOST:3232 ($ADDR)"; fi
echo
echo "  This replaces the running firmware and reboots the unit."
echo "  There is no rollback; recovery is a USB cable."
if [ -n "$WAS" ] && [ "$WAS" = "$VERSION" ]; then
  echo
  echo "  NOTE: the unit already reports v$VERSION. Nothing after the transfer"
  echo "  can then prove the new image landed — bump FW_VERSION, or check by"
  echo "  hand afterwards."
fi
echo

# Two commands rather than a prompt, and not only because `read` has no
# stdin when this is run from Claude Code's `!` line. It is the idiom the
# repo already uses: publish_firmware.mjs keeps `publish` and `arm` apart so
# that replacing firmware on a live unit costs its own deliberate act. The
# first run shows you exactly what would go where; the second sends it.
if [ "$ASSUME_YES" -ne 1 ]; then
  echo "  Nothing sent. Check the above, then run again with -y:"
  echo
  echo "      tools/ota_flash.sh $HOST -y"
  exit 0
fi

python3 "$ESPOTA" -i "$HOST" -p 3232 -a "$PW" -f "$BIN" -r

# espota reports the transfer, and not even that honestly: 3.3.11 ends with
# `return 0  # Consider it successful if we got any response and upload
# completed`, so a unit that takes the whole image and then rejects it still
# exits 0. Ask the device what it is running instead of believing the tool.
echo
echo "Waiting for it to come back up ..."
log=""
for i in $(seq 1 30); do
  sleep 2
  log="$(probe)"
  [ -n "$log" ] || continue                 # not answering yet: still rebooting

  # The firmware says so itself when it refuses an image, and that line is
  # worth more than any inference from an exit code.
  if printf '%s' "$log" | grep -q "OTA: FAILED"; then
    echo "The unit refused the update and kept the firmware it had:" >&2
    printf '%s\n' "$log" | grep "OTA:" >&2
    exit 1
  fi

  got="$(printf '%s' "$log" | boot_version)"
  # Answering, but the 40-line ring has no boot line — so this is the OLD
  # firmware still up with a full ring, not a fresh boot. Keep waiting.
  [ -n "$got" ] || continue

  if [ "$got" = "$VERSION" ]; then
    echo "Up on v$got."
    printf '%s\n' "$log" | tail -12 || true
    if [ -n "$WAS" ] && [ "$WAS" = "$VERSION" ]; then
      echo
      echo "  It reported v$VERSION before the flash too, so this does not prove"
      echo "  the new image landed. Check the page footer by hand."
    fi
    exit 0
  fi
  echo "It answered, but reports v$got and not v$VERSION." >&2
  exit 1
done

# Two different failures, and saying the wrong one sends you after the wrong
# thing: a silent unit means USB, a talking one means read its log.
if [ -n "$log" ]; then
  echo "The unit is answering but never logged a boot on v$VERSION." >&2
  printf '%s\n' "$log" | tail -10 >&2
else
  echo "No answer within about two minutes. Check the serial log over USB." >&2
fi
exit 1
