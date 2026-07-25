FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm

# A self-contained VNC target lives inside the container so the extension has
# something to connect to from the *container's* network — the same topology as
# attaching VS Code to a remote and connecting to a host only that remote can
# reach. Xvfb is a headless X display, fluxbox a minimal window manager, and
# x11vnc exposes the display over RFB (no auth) on loopback:5900.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        fluxbox \
        xterm \
        procps \
        netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

COPY start-vnc.sh /usr/local/bin/start-vnc.sh
RUN chmod +x /usr/local/bin/start-vnc.sh
