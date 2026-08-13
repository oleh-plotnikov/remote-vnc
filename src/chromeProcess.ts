import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

import { readCdpFrames } from './cdp';
import { CdpConnection, type CdpSocket } from './cdpClient';
import { logger } from './log';
import { groupKiller, type GroupKillOptions } from './processGroup';

/**
 * How long a launch may take to answer on its pipe; give up rather than hang
 * forever. 15s was a plan-time guess, not a measurement, and it does not
 * hold up: a cold headless launch on a machine whose swap is exhausted (this
 * one runs a 24 GB build container alongside the editor) missed it on an
 * ordinary open, not a rare one. 45s is not a measurement either, but it is a
 * three-times margin over the guess that failed, which is enough to absorb
 * swap contention without leaving a genuinely wedged Chrome hanging the tab
 * for minutes. Overridable per launch — see `clampLaunchTimeoutMs` — because
 * "how slow is too slow" depends on the machine, not the extension.
 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 45_000;
/**
 * Bounds for `remoteVnc.mirrorLaunchTimeout` (declared in seconds in
 * package.json). Floor high enough that a value near it still describes a
 * genuine wait rather than a launch nobody could ever complete in time;
 * ceiling low enough that a Chrome which will never answer does not hold a tab
 * in "Starting the mirrored browser…" for the rest of the session.
 */
export const MIN_LAUNCH_TIMEOUT_MS = 5_000;
export const MAX_LAUNCH_TIMEOUT_MS = 120_000;

/**
 * Clamp a configured `remoteVnc.mirrorLaunchTimeout` (seconds) to milliseconds
 * within [MIN_LAUNCH_TIMEOUT_MS, MAX_LAUNCH_TIMEOUT_MS]. Mirrors `clampFps`
 * (src/recording.ts): a non-finite or missing setting falls back to the
 * default rather than producing a NaN timer that fires immediately.
 */
export function clampLaunchTimeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return DEFAULT_LAUNCH_TIMEOUT_MS;
  }
  return Math.min(MAX_LAUNCH_TIMEOUT_MS, Math.max(MIN_LAUNCH_TIMEOUT_MS, Math.round(seconds * 1000)));
}

/**
 * How Chrome is spawned. `detached` is the load-bearing one, and it is here —
 * exported, named — because nothing else can observe it and killer() below is
 * incorrect without it.
 *
 * A Chrome is not one process: the browser process forks a zygote, a GPU
 * process, a network/storage service and one renderer per site. Measured on a
 * single mirrored tab: eleven processes, of which SIGTERM to the browser
 * process left ten alive three seconds later. Signalling the whole process
 * group is what actually reaps them.
 *
 * `detached: true` is what makes a group there to signal. Without it the child
 * inherits the extension host's process group, and `process.kill(-pid)` would
 * then be asking the OS to signal a group whose members include VS Code
 * itself. So this is a prerequisite for the group kill, not a companion
 * tidiness: the two must land together or not at all.
 */
export const CHROME_SPAWN_OPTIONS: SpawnOptions = {
  // fd 3 and 4 are the CDP pipe pair `--remote-debugging-pipe` asks for: Chrome
  // reads requests from 3 and writes responses and events to 4. stderr stays
  // piped for launch diagnostics — and stays READ (see drainStderr), because an
  // unread pipe fills and blocks the browser that is writing into it.
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  detached: true,
};

/**
 * The command line, as a value so a test can assert on it.
 *
 * `--remote-debugging-pipe`, never `--remote-debugging-port`. A port opens an
 * HTTP/WebSocket server on loopback that has no credential of any kind: the
 * ephemeral port is obscurity rather than authentication, and Chrome
 * republishes it in `DevToolsActivePort` inside the profile directory anyway.
 * Any local process — including one under a different uid on a shared build
 * machine — could read `/json/version` and then drive this browser through
 * `Runtime.evaluate`, `Page.navigate` to `file://`, or the profile's cookies.
 *
 * CDP has no authentication to switch on, so the fix is to not have a socket.
 * The pipe is reachable only through file descriptors this process handed the
 * child, which no unrelated process can open.
 */
export function chromeArgs(userDataDir: string): string[] {
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
  ];
}

/**
 * The `CdpSocket` CdpConnection wants, over the fd pair.
 *
 * A pipe is a byte stream: chunk boundaries fall wherever the OS put them, so
 * the framing a WebSocket used to provide has to be done here — see
 * readCdpFrames, which is where the buffering and the "decode only whole
 * frames" rule live.
 */
export function pipeSocket(child: ChildProcess): CdpSocket {
  const toChrome = child.stdio[3] as NodeJS.WritableStream;
  const fromChrome = child.stdio[4] as NodeJS.ReadableStream;
  let rest: Buffer = Buffer.alloc(0);
  const onClosed: Array<() => void> = [];
  let closed = false;
  // One close, from whichever source noticed first. The browser exiting counts:
  // without it CdpConnection never learns the connection is gone and every
  // in-flight request sits out its full 30s timeout instead of failing at once.
  const fireClose = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const cb of onClosed) {
      cb();
    }
  };
  fromChrome.on('close', fireClose);
  child.on('exit', fireClose);

  return {
    send: (data) => {
      toChrome.write(`${data}\0`);
    },
    close: () => {
      try {
        toChrome.end();
      } catch {
        // Already torn down — closing a dead pipe is not a failure worth raising.
      }
    },
    onMessage: (cb) => {
      fromChrome.on('data', (chunk: Buffer) => {
        const read = readCdpFrames(rest, chunk);
        rest = read.rest;
        for (const frame of read.frames) {
          cb(frame);
        }
      });
    },
    onClose: (cb) => {
      onClosed.push(cb);
    },
  };
}

/**
 * Wait until the browser is actually able to answer, or fails.
 *
 * With a port, the "DevTools listening on …" line on stderr was the readiness
 * signal. A pipe has no such announcement — the fds exist the moment the
 * process is spawned, whether or not anything is listening on the other end —
 * so readiness is established by asking a question Chrome can only answer once
 * it is up. `Browser.getVersion` is that question: no side effects, no target
 * needed, and it fails the same way any other call would if the browser is
 * wedged.
 *
 * The three losing races are all kept, because each produces a different and
 * more useful message than the timeout: an exit code, a spawn error (ENOENT
 * for a bad binary path — and Node treats an 'error' event with no listener as
 * an uncaught exception, so this listener also keeps a launch failure from
 * taking down the extension host), or the timeout itself.
 */
export function waitForChrome(
  child: ChildProcess,
  cdp: Pick<CdpConnection, 'send'>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const once = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    child.once('exit', (code) =>
      once(() => reject(new Error(`Chrome exited with code ${code} before answering on its CDP pipe`)))
    );
    child.once('error', (err) => once(() => reject(err)));
    cdp.send('Browser.getVersion', undefined, undefined, timeoutMs).then(
      () => once(resolve),
      (err: Error) => once(() => reject(new Error(`Chrome did not answer on its CDP pipe: ${err.message}`)))
    );
  });
}

/**
 * Keep stderr flowing and keep its tail.
 *
 * Nothing consumes stderr now that the endpoint is not announced there, and a
 * piped stream nobody reads fills its buffer and then blocks the writer — the
 * browser. Only the tail is retained: a crashing Chrome is chatty, and what a
 * launch failure needs is the last thing it said.
 */
function drainStderr(child: ChildProcess): () => string {
  let tail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-4096);
  });
  return () => tail.trim();
}

export interface ChromeHandle {
  cdp: CdpConnection;
  kill(): void;
}

export async function launchChrome(opts: {
  binary: string;
  userDataDir: string;
  /** How long to wait for the DevTools endpoint before giving up. Defaults to
   *  DEFAULT_LAUNCH_TIMEOUT_MS; callers pass `remoteVnc.mirrorLaunchTimeout`
   *  (clamped via clampLaunchTimeoutMs) so the wait can be raised on a machine
   *  where the default still is not enough. */
  launchTimeoutMs?: number;
}): Promise<ChromeHandle> {
  const launchTimeoutMs = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const child = spawn(opts.binary, chromeArgs(opts.userDataDir), CHROME_SPAWN_OPTIONS);
  // The browser must not be what keeps the extension host's event loop alive:
  // a detached child is referenced by default, and a window closing while a
  // mirror is up would then wait on a process we are in the middle of killing.
  // Unreferencing the handle does not detach the CDP pipe or the stderr drain,
  // and it does not weaken the kill — the pid stays valid either way.
  child.unref();
  const kill = killer(child);
  const stderrTail = drainStderr(child);

  // Anything that fails once the process has actually spawned must take it
  // down before rethrowing — otherwise a browser that came up but never
  // answered (crash, wedged renderer, a profile it cannot lock) orphans a
  // running Chrome for the rest of the window's life instead of surfacing as a
  // clean launch failure. kill() is idempotent, so calling it here is free even
  // on the paths that already killed the process.
  try {
    const cdp = new CdpConnection(pipeSocket(child));
    await waitForChrome(child, cdp, launchTimeoutMs);
    return { cdp, kill };
  } catch (err) {
    kill();
    const said = stderrTail();
    // The tail is the diagnostic the endpoint line used to be: with no port
    // there is no handshake error to read, so what Chrome complained about on
    // its way down is all there is.
    throw said
      ? new Error(`${(err as Error).message} — Chrome's last output: ${said.slice(-400)}`)
      : err;
  }
}

/**
 * SIGTERM to Chrome's whole process group, then SIGKILL to the same group if
 * anything is still there after KILL_GRACE_MS.
 *
 * This is a long-lived editor, not a script that's about to exit anyway: a
 * mirror session is launched and disposed once per Web Page tab, for as long
 * as the window stays open. A Chrome that ignores or is slow to handle
 * SIGTERM would stay resident for the rest of that lifetime — one leaked
 * process per session — which on a memory-constrained machine is the failure
 * mode most likely to actually bite, not a tidiness nit.
 *
 * The group, not the process, and that distinction is the whole fix: signalling
 * only the browser process was measured to leave ten of eleven Chrome processes
 * running three seconds later, holding 1.7 GB between them. `exited` still
 * tracks the browser process — it is the only one we have a handle on, and it
 * is the one whose departure means the group is done — so the escalation and
 * the idempotency below are unchanged. Only the target widened.
 *
 * Safe to call more than once (the caller's dispose path may run twice) and
 * safe to call after the process has already exited on its own.
 *
 * The mechanics live in src/processGroup.ts, shared with the pre/post-use
 * command runner, which has the identical "a shell that spawned a build"
 * problem. What stays here is why Chrome needs it, which is measurement rather
 * than mechanism.
 *
 * `opts` is a seam for test/chromeProcess.test.mjs and nothing else: the group
 * form has no observable effect on a fake child (that is precisely why it
 * could regress unnoticed), and the escalation is unobservable without either
 * a shorter grace or a two-and-a-half-second wait in the suite.
 */
export function killer(child: ChildProcess, opts: GroupKillOptions = {}): () => void {
  return groupKiller(child, { label: 'mirror', ...opts });
}

/** A tab we opened: the session that addresses it, and the id that closes it. */
export interface TargetHandle {
  sessionId: string;
  targetId: string;
}

/**
 * Create a tab for `url` and attach to it. `flatten: true` gives one socket for
 * every session, addressed by sessionId — without it each target needs its own
 * connection.
 *
 * Both ids come back, and the targetId is the reason: it exists from the
 * moment createTarget returns, so a caller that fails anywhere after this can
 * still close the tab it opened. Asking for it again later (Target.getTargetInfo)
 * leaves a window in which a tab exists whose id nobody knows — an orphan
 * running the page's timers until the browser dies.
 */
export async function openTarget(cdp: CdpConnection, url: string): Promise<TargetHandle> {
  const { targetId } = (await cdp.send('Target.createTarget', { url })) as { targetId: string };
  let sessionId: string;
  try {
    ({ sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string });
  } catch (err) {
    // The same orphan the return shape exists to prevent, one step earlier:
    // the tab is open and only this frame knows its id. Closing it must not
    // mask why the attach failed.
    void cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    throw err;
  }
  logger().info(`mirror: attached to ${url} (session ${sessionId})`);
  return { sessionId, targetId };
}
