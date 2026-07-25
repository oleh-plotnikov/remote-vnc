#!/usr/bin/env bash
# Bring up a headless X display + minimal WM + a no-auth VNC server bound to
# 127.0.0.1:5900. Idempotent: postStartCommand runs this on every container
# start, so a second invocation is a no-op.
set -euo pipefail

export DISPLAY=:99

if pgrep -x x11vnc >/dev/null 2>&1; then
  echo "VNC already running on 127.0.0.1:5900"
  exit 0
fi

Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &

# Wait for the X socket before starting clients that need the display.
for _ in $(seq 1 50); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

fluxbox >/tmp/fluxbox.log 2>&1 &
xterm -geometry 100x30+40+40 -e "echo 'Remote VNC dev container — connected.'; bash" \
  >/tmp/xterm.log 2>&1 &

# -localhost keeps it on loopback; the extension host runs in this same
# container, so the bridge reaches it without exposing it on the network.
x11vnc -display :99 -nopw -forever -shared -localhost -rfbport 5900 \
  >/tmp/x11vnc.log 2>&1 &

echo "VNC server listening on 127.0.0.1:5900 (no auth)"
