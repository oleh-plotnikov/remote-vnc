import * as net from 'net';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * A loopback bridge that lets the browser-based noVNC client (which can only
 * speak WebSocket) reach a raw TCP VNC server speaking the RFB protocol.
 *
 * The bridge listens on `127.0.0.1` on an ephemeral port. The first authorised
 * WebSocket client gets a fresh TCP connection to the target VNC server, and
 * bytes are piped verbatim in both directions with flow control.
 */
export interface VncBridge {
  /** WebSocket URL (including auth token) the webview should connect to. */
  readonly url: string;
  /** Fires once when the bridge closes, with a reason on abnormal closure. */
  onClosed(listener: (reason?: string) => void): void;
  /** Tear down the bridge and any active sockets immediately. */
  dispose(): void;
}

export interface BridgeTarget {
  host: string;
  port: number;
}

export interface BridgeOptions {
  /**
   * Port for the local WebSocket bridge to listen on. Defaults to 0 (ephemeral).
   * Set a fixed port when the webview reaches the bridge through a statically
   * forwarded port (e.g. a local Dev Container, where asExternalUri does not
   * auto-forward). A fixed port allows only one session at a time.
   */
  listenPort?: number;
}

/** Pause the source once this many bytes are queued; resume once it drains. */
const HIGH_WATER_MARK = 1 << 20; // 1 MiB
/** Grace period for a clean WebSocket close frame to flush before a hard kill. */
const CLOSE_GRACE_MS = 3000;

/**
 * Ports of closed ephemeral bridges, reused LIFO by the next createBridge.
 *
 * In a remote window every distinct bridge port that goes through
 * asExternalUri leaves a "User Forwarded" row in the Ports panel that VS Code
 * never cleans up (there is no stable unforward API — tunnels is a proposed
 * API) — so a reconnect loop on fresh ephemeral ports accumulates dead rows
 * without bound. Recycling caps the set of ports ever seen at roughly the max
 * number of concurrent sessions. A recycled port can be snatched by another
 * process while free; createBridge then falls back to a fresh ephemeral port.
 */
const recycledPorts: number[] = [];
const MAX_RECYCLED = 8;

export async function createBridge(
  target: BridgeTarget,
  options: BridgeOptions = {}
): Promise<VncBridge> {
  if (options.listenPort !== undefined) {
    return createBridgeOn(target, options.listenPort, /*recycle=*/ false);
  }
  const recycled = recycledPorts.pop();
  if (recycled !== undefined) {
    try {
      return await createBridgeOn(target, recycled, /*recycle=*/ true);
    } catch {
      // The port was taken while free — fall back to a fresh ephemeral one.
    }
  }
  return createBridgeOn(target, 0, /*recycle=*/ true);
}

function createBridgeOn(
  target: BridgeTarget,
  listenPort: number,
  recycle: boolean
): Promise<VncBridge> {
  return new Promise((resolve, reject) => {
    // A single-use token prevents other local processes from hijacking the
    // bridge before the intended webview connects.
    const token = crypto.randomBytes(24).toString('hex');
    const closeListeners: Array<(reason?: string) => void> = [];
    let tcp: net.Socket | undefined;
    let ws: WebSocket | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let closing = false;
    let disposed = false;
    let resolved = false;
    let boundPort: number | undefined;

    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: listenPort,
      // noVNC historically negotiates the legacy "binary" subprotocol.
      handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
    });

    const notifyClosed = (reason?: string) => {
      for (const listener of closeListeners.splice(0)) {
        listener(reason);
      }
    };

    /** Hard stop: free every resource right away. Safe to call repeatedly. */
    const finalize = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      try {
        ws?.terminate();
      } catch {
        /* ignore */
      }
      try {
        tcp?.destroy();
      } catch {
        /* ignore */
      }
      wss.close(() => {
        // The port is actually free only once the server has closed — recycle
        // it then, so the next (re)connect reuses it instead of minting a new
        // ephemeral port (and a new forwarded-port row in remote windows).
        if (recycle && boundPort !== undefined && recycledPorts.length < MAX_RECYCLED) {
          recycledPorts.push(boundPort);
        }
      });
    };

    /**
     * Begin an orderly shutdown: flush a WebSocket close frame (so noVNC reports
     * a clean disconnect) and end the TCP side, then finalize after a grace
     * period. `reason` is set only for abnormal closures.
     */
    const gracefulClose = (reason?: string) => {
      if (closing || disposed) {
        return;
      }
      closing = true;
      notifyClosed(reason);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(reason ? 1011 : 1000, (reason ?? 'Remote closed').slice(0, 120));
        }
      } catch {
        /* ignore */
      }
      try {
        tcp?.end();
      } catch {
        /* ignore */
      }
      closeTimer = setTimeout(finalize, CLOSE_GRACE_MS);
    };

    wss.on('error', (err) => {
      if (!resolved) {
        reject(err);
        finalize();
      } else {
        // Server-level error after the bridge was handed out: route through the
        // normal close path so onClosed listeners are notified with a reason.
        gracefulClose(err.message);
      }
    });

    wss.on('connection', (socket, request) => {
      const requestUrl = new URL(request.url ?? '/', 'ws://127.0.0.1');
      if (!tokensMatch(requestUrl.searchParams.get('token'), token)) {
        socket.close(1008, 'Invalid token');
        return;
      }
      // Only the first client is served; reject any extras.
      if (ws) {
        socket.close(1013, 'Bridge already in use');
        return;
      }
      socket.binaryType = 'nodebuffer';
      ws = socket;

      const sock = net.connect({ host: target.host, port: target.port });
      tcp = sock;
      sock.setNoDelay(true);

      // --- TCP → WebSocket (the high-volume direction: framebuffer updates) ---
      sock.on('data', (chunk) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(chunk, { binary: true }, () => {
          // Resume reading once the WebSocket send buffer has drained.
          if (sock.isPaused() && socket.bufferedAmount < HIGH_WATER_MARK) {
            sock.resume();
          }
        });
        if (socket.bufferedAmount >= HIGH_WATER_MARK) {
          sock.pause();
        }
      });
      sock.on('error', (err) => gracefulClose(err.message));
      sock.on('close', () => gracefulClose());
      // The WebSocket socket drained — let the TCP source flow again.
      sock.on('drain', () => socket.resume());

      // --- WebSocket → TCP (low-volume: keyboard/mouse/clipboard input) ---
      socket.on('message', (data) => {
        if (sock.destroyed) {
          return;
        }
        // `ws` may hand us a Buffer or an array of Buffers for fragmented frames.
        const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
        if (!sock.write(buf)) {
          socket.pause();
        }
      });
      socket.on('close', () => {
        // The WebSocket close handshake has completed: if we already started an
        // orderly shutdown the close frame has flushed, so free everything now
        // instead of holding the port for the full grace period.
        if (closing) {
          finalize();
        } else {
          gracefulClose();
        }
      });
      socket.on('error', () => gracefulClose('WebSocket error'));
    });

    wss.on('listening', () => {
      const address = wss.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('Failed to bind VNC bridge to a local port.'));
        finalize();
        return;
      }
      resolved = true;
      boundPort = address.port;
      resolve({
        url: `ws://127.0.0.1:${address.port}/?token=${token}`,
        onClosed: (listener) => closeListeners.push(listener),
        dispose: finalize,
      });
    });
  });
}

/** Constant-time comparison of the bridge token (credential-equivalent value). */
function tokensMatch(provided: string | null, expected: string): boolean {
  if (provided === null) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
