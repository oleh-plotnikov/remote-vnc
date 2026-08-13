import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { brandIconPath } from './brandIcon';
import type { CdpConnection } from './cdpClient';
import { chromeCandidates, pickChrome } from './chromeLocator';
import { clampLaunchTimeoutMs, launchChrome, openTarget, type ChromeHandle } from './chromeProcess';
import { interactiveSaveCapture } from './interactiveCapture';
import { logger, logSafeUrl } from './log';
import {
  MAX_INFLIGHT_INPUT,
  mayForwardInput,
  mirrorViewport,
  parseMirrorRequest,
  type MirrorSize,
} from './mirrorInput';
import { ACTIVE_WINDOW_MS, deriveIdleFps, selectMirrorFps } from './mirrorRate';
import { registerPanel, unregisterPanel, setFocusedPanel, getFocusedPanel } from './panelRegistry';
import {
  RecordingFormat,
  RecordingStopReason,
  recordingBytes,
  recordingFilters,
  clampFps,
} from './recording';
import { captureFilename, expandHome } from './screenshot';
import type { UseCommands } from './useCommands';
import {
  holdPostUseCommand,
  releasePostUseCommandAfter,
  runPreUseCommand,
} from './useCommandRunner';

// Re-exported for test/pageCapture.test.mjs only: that module reaches
// registerPageEntry's PanelEntry back out through the very Map it was
// registered into, and a fresh `load()` of panelRegistry.ts on its own would
// bundle a second, disconnected instance of that Map — this file's own
// bundle is the only place the two can share state.
export { getPanel } from './panelRegistry';

/**
 * Web-page tabs — a saved URL rendered full-bleed in a webview iframe, so
 * design mockups and other local dev pages open as clean editor tabs next to
 * the VNC sessions, without browser chrome.
 *
 * One panel per URL: re-opening reveals (and re-titles) the existing tab AND
 * reloads its iframe — these are live dev pages, so "open" must mean "show me
 * the current state", not a memo of whatever was loaded an hour ago.
 *
 * A page saved with `mirror: true` renders differently: the host drives a
 * headless Chrome tab over CDP and streams its frames into a canvas (see
 * `startMirror` below). Same tab, same registry entry — but the pixels are
 * ours, which is what makes capture possible at all. The mode is fixed when
 * the tab opens; flipping the setting takes effect on the next open.
 */
interface OpenPage {
  panel: vscode.WebviewPanel;
  external: string;
  frameOrigin: string;
  canvas?: PageCanvas;
  /** Whether this tab renders as a mirror. False the moment mirroring is
   *  wanted but unavailable — that path falls back to the iframe. */
  mirrored: boolean;
  /** Set alongside `mirrored = false`, but only on the launch-failure path in
   *  `startMirror`'s catch — never on a page that simply did not ask to
   *  mirror. `mirrored: false` alone cannot tell those two apart once the
   *  moment has passed, and `registerPageEntry` needs to: a capture attempt
   *  on a page that never asked gets the reserved 'page is not mirrored',
   *  while one whose Chrome failed needs a message that says what to do
   *  about it. Carried here because this is the only place the distinction
   *  still exists. */
  mirrorFailed: boolean;
  /** The live CDP session, once Chrome is up. Absent while launching. */
  mirror?: MirrorSession;
  /** The panel's own size, as last measured by the webview. */
  viewport: MirrorSize;
  /** Kept so a mirrored tab's webview can be rebuilt after it is open. */
  extensionUri: vscode.Uri;
  /** Kept so a capture (control-server registry call, interactive hotkey,
   *  tree command) can pick a save destination without a
   *  `vscode.ExtensionContext` in hand — the same reasoning that has
   *  VncSession carry it as `globalStorageUri`. */
  globalStorageUri: vscode.Uri;
  /** Whether a webview is loaded and listening. A frame posted to one that is
   *  still starting up is dropped by VS Code, and a dropped frame is never
   *  acknowledged — which stops the stream for good after a few of them. So
   *  nothing streams until the webview has said something first. */
  webviewLive: boolean;
  /** Recording state for the canvas the mirror paints into (media/recorder.ts
   *  via media/pageMirror.ts) — mirrors VncSession's own `recording` field and
   *  the same reasoning: a chord cannot ask "start or stop?" without it. */
  recording: 'idle' | 'starting' | 'recording';
  /** Waiters for the registry's own `record()` — see `startPageRecording`.
   *  The interactive start (`startPageRecordingInteractive`) never pushes one
   *  of these: it is fire-and-forget, exactly like `VncSession.startRecording`,
   *  and relies on `handleRecordMessage`'s own error toast instead. */
  recordStartWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  /** Waiters for the registry's own `recordStop()` — see `stopPageRecording`.
   *  Whether this is empty is also the signal `handleRecordMessage` uses to
   *  tell a registry-driven stop from an interactive one (which never pushes
   *  a waiter here either): non-empty means "someone is polling this promise
   *  and cannot be shown a dialog", empty means "run the interactive save". */
  recordStopWaiters: Array<{ resolve: (path: string) => void; reject: (err: Error) => void }>;
  /**
   * Where this tab is in its `preUseCommand` (src/useCommands.ts).
   * 'none' for a page that has none, which is every page that existed before
   * the feature. `reopen` reads it: a tab whose command is still running must
   * not have its iframe rebuilt, because rebuilding it is exactly "load the
   * URL", and the URL is the thing that does not exist yet.
   */
  preUse: 'none' | 'running' | 'failed' | 'ready';
  /** This panel's claim on the entry's `postUseCommand`, if it has one. The
   *  token, not the command: releasing by token is what makes a stale dispose
   *  harmless — see PostUseTracker (src/useCommands.ts). */
  useToken?: string;
  /** The `preUseCommand` while it is still running, and undefined the moment it
   *  settles. Held because closing the tab must not release the claim UNDER a
   *  running start command — see releaseUseClaim below. `preUse: 'running'`
   *  cannot stand in for it: a state says the command is in flight, this is the
   *  thing that can be waited on. */
  preUsePending?: Promise<unknown>;
}
const openPanels = new Map<string, OpenPage>();

/**
 * The same entries, indexed by registry id rather than URL — the id a
 * human-facing caller actually holds: the focused-panel hotkey dispatcher and
 * the Web Pages tree commands (src/extension.ts) only ever see a panel id,
 * the same one `src/panelRegistry.ts` keys on, but they need the live
 * `OpenPage` itself (settings, the crop editor, a save dialog) rather than
 * the wire-facing `PanelEntry` the registry hands back. The same idea as
 * `VncSessionManager`'s own `sessions: Map<string, VncSession>`.
 *
 * Exported (only) for test/pageCapture.test.mjs, the same reason `getPanel`
 * is re-exported just above `registerPageEntry`: it lets a test register a
 * fake `OpenPage` directly and exercise `takePageScreenshot`/
 * `toggleRecordPage` without a real `WebviewPanel` or a spawned Chrome.
 */
export const openPanelsById = new Map<string, OpenPage>();

/**
 * Give up this panel's claim on the entry's `postUseCommand` — but never while
 * that entry's `preUseCommand` is still running.
 *
 * The tab can be closed at any point, including two seconds into a
 * `barto-mac up` that takes twenty. Releasing there would run `barto-mac stop`
 * first and let `up` finish afterwards, leaving the stack up with no holder and
 * no way to release it: the permanent orphan this feature exists to prevent,
 * reached by the one action a user takes when a tab is slow to open. So the
 * release waits for the start command — see `releasePostUseCommandAfter`
 * (src/useCommandRunner.ts), which is where the ordering itself is proved.
 *
 * The token is cleared first and unconditionally, so a second dispose cannot
 * schedule a second release; the tracker ignores an unknown token anyway, and
 * this keeps that from being the only thing that saves it.
 *
 * Exported for test/pageUseClaim.test.mjs: `openPagePanel` needs a real
 * `WebviewPanel` and cannot be driven from a test, so this is the seam at
 * which the wiring — that the dispose path consults `preUsePending` at all —
 * is observable.
 */
export function releaseUseClaim(entry: Pick<OpenPage, 'useToken' | 'preUsePending'>): void {
  const token = entry.useToken;
  if (!token) {
    return;
  }
  entry.useToken = undefined;
  releasePostUseCommandAfter(entry.preUsePending, token);
}

/** Mirrored panels by CDP session id, for routing screencast frames. */
const mirrors = new Map<string, OpenPage>();

/** One live Chrome tab behind one mirrored panel. */
interface MirrorSession {
  cdp: CdpConnection;
  sessionId: string;
  targetId: string;
  /** The entry's name and the URL the tab was opened at — what a navigation
   *  is compared against to decide whether the tab is still showing what the
   *  user asked for. Kept here rather than on OpenPage because mirroring is
   *  the only thing that can navigate out from under one. */
  savedName: string;
  savedUrl: string;
  /** Screencast frame ids Chrome has sent and we have not acknowledged yet,
   *  oldest first. See `Page.screencastFrameAck` handling below. */
  unacked: number[];
  /** The emulated viewport currently in force. */
  size: MirrorSize;
  running: boolean;
  /** The `everyNthFrame` divisor actually accepted by the last successful
   *  `Page.startScreencast` — 0 before any successful start. Compared
   *  against a freshly computed one in `applyMirrorRate` so a rate
   *  re-evaluation only restarts the stream when the chosen rate has
   *  actually changed; restarting on every input would thrash the ack
   *  queue for no gain. */
  everyNthFrame: number;
  /** The divisor most recently ASKED for, claimed synchronously by
   *  `startScreencast` before its CDP round trip — as opposed to
   *  `everyNthFrame` above, which records only what Chrome came back and
   *  accepted. `applyMirrorRate` compares against this one; see its own
   *  comment for the two ways the accepted value alone got it wrong. */
  pendingEveryNthFrame: number;
  /** `Input.dispatch*` calls sent to Chrome and not yet answered. The
   *  measurement the whole backpressure path is built on — see
   *  MAX_INFLIGHT_INPUT (src/mirrorInput.ts) for why an unanswered dispatch
   *  means "the renderer is behind" rather than "the message is in transit". */
  inFlightInput: number;
  /** The deepest `inFlightInput` ever reached on this session. Logged on
   *  recovery and at teardown: the previous investigation had to infer this
   *  number from a dump of unanswered CDP requests, because nothing ever
   *  wrote it down. */
  peakInFlightInput: number;
  /** `mouseMoved` events refused while over the cap, for the same log lines. */
  droppedMoves: number;
  /** Whether the mirror is currently marked degraded — the state the canvas
   *  banner reflects and the gate `mouseMoved` is dropped behind. Cleared
   *  once the queue drains back under RECOVER_INFLIGHT_INPUT. */
  degraded: boolean;
  /** Whether the one-per-session warning and toast have already been issued.
   *  Separate from `degraded` on purpose: the banner follows the state and
   *  may flip repeatedly, while the voice speaks once — a warning per event
   *  on a path that fires per keystroke is not a warning, it is noise. */
  warnedDegraded: boolean;
  /** `Date.now()` of the last input the webview forwarded (mouse, key,
   *  wheel) — undefined until the first one. Read via `selectMirrorFps`
   *  (src/mirrorRate.ts) to choose the active or idle rate. */
  lastInputAt?: number;
  /** The idle-transition timer armed by `noteMirrorInput`, so the next input
   *  can debounce it — replacing the pending timer rather than letting two
   *  race — instead of the window meaning "since the FIRST input" by
   *  accident. */
  rateTimer?: ReturnType<typeof setTimeout>;
}

/** Lossy on purpose: this is the live view, not the capture. Screenshots come
 *  from `Page.captureScreenshot` at full resolution instead. */
const SCREENCAST_QUALITY = 80;
/**
 * The composite rate `everyNthFrame` is assumed to divide. CDP offers no way
 * to ask what it actually is, so this is the constant that turns a frame rate
 * a human can reason about into the divisor Chrome accepts.
 *
 * Sixty because that is the synthetic vsync headless Chrome is nominally
 * driven by — and it is genuinely an assumption: measured on macOS
 * (Chrome 151, headless, one animated page) an uncapped screencast delivered
 * ~100 fps, so the same divisor yielded ~17 fps rather than the 10 asked for.
 * Assuming the higher rate instead would starve a host that really does
 * composite at 60, and a mirror that runs slower than asked is the worse
 * failure for a tab whose whole job is showing you a transition. Bounded and
 * slightly generous beats precise and occasionally choppy.
 */
const ASSUMED_COMPOSITE_HZ = 60;
/**
 * Frames per second a mirror aims for when nothing is configured.
 *
 * Was 10, on the assumption that these tabs are mostly reviewed — a layout, a
 * transition, a hover state. They are not only that: a mirror is a live,
 * clickable page, and one user's report was concrete — typing an email into
 * one at 10 fps put a visible 100ms+ gap between the keystroke and the
 * character landing, which read as the page glitching or hanging rather than
 * being merely slow. 30 is `clampFps`'s existing ceiling (src/recording.ts),
 * so this raises the default to the cap rather than past it.
 *
 * The ceiling itself stays at 30. Measured on this machine: capping already
 * helps less than it sounds like it should — 52% CPU uncapped fell to 34% at
 * the OLD 10-fps default, not lower, because most of that load is Chrome
 * compositing the page's own animation, which no frame-rate setting removes.
 * Raising the ceiling to push the divisor from 2 (at 30) to 1 (uncapped in
 * all but name) would spend a large chunk of that remaining headroom for a
 * latency gain past 30 fps that a human is unlikely to feel.
 *
 * Approximate in delivery, same as everywhere else this is used: everyNthFrame
 * divides whatever Chrome actually composites at, not the fps asked for (see
 * ASSUMED_COMPOSITE_HZ above). Asking for the old default of 10 measured out
 * to ~17 delivered frames on a machine compositing near 100 Hz against the
 * assumed 60 — so treat "30" here as "roughly double whatever 10 delivered on
 * this machine," not a number CDP will ever confirm.
 */
const DEFAULT_MIRROR_FPS = 30;
/** Chrome stops sending after a handful of unacknowledged frames, so the queue
 *  cannot grow far on its own — the cap only bounds a webview that stopped
 *  acking, which would otherwise leave ids here for the life of the tab. */
const MAX_UNACKED = 16;
/**
 * The in-flight depth an input dispatch has to fall back to before the mirror
 * stops calling itself degraded. Half the cap, not the cap itself: recovering
 * at `MAX_INFLIGHT_INPUT - 1` would flip the banner (and the log line) on and
 * off around a single event's worth of jitter. Hysteresis costs a handful of
 * extra dropped moves and buys a state that means something.
 */
const RECOVER_INFLIGHT_INPUT = Math.floor(MAX_INFLIGHT_INPUT / 2);
/**
 * The watchdog on one input dispatch, overriding cdpClient's far more
 * generous default (see CDP_REQUEST_TIMEOUT_MS for why that default cannot be
 * tightened globally).
 *
 * Ten seconds is not a latency budget — it is the point past which the answer
 * has stopped being worth waiting for. A keystroke the renderer has not
 * acknowledged in ten seconds will not feel like typing whenever it does
 * land, and holding the entry any longer only keeps `inFlightInput` pinned
 * above the cap, which would leave the mirror permanently degraded (dropping
 * every pointer move) long after the renderer recovered.
 */
const INPUT_DISPATCH_TIMEOUT_MS = 10_000;
/** How long an idle browser survives the last mirrored tab closing. */
const BROWSER_GRACE_MS = 30_000;
/** The viewport assumed between opening a tab and the webview measuring it. */
const DEFAULT_VIEWPORT: MirrorSize = { width: 1280, height: 800 };

export interface PageCanvas {
  width: number;
  height: number;
}

export async function openPagePanel(
  context: vscode.ExtensionContext,
  name: string,
  url: string,
  canvas?: PageCanvas,
  mirror?: boolean,
  /** Already trust-gated by collectPages (src/pages.ts) — never the raw
   *  settings fields, which a workspace could have written. */
  use?: UseCommands
): Promise<void> {
  const existing = openPanels.get(url);
  if (existing) {
    // Deliberately no re-run of the pre-use command: the stack it starts is
    // already up (or already coming up), and a second `barto-mac up` under a
    // live tab is at best wasted work. Reopening reveals what is there.
    reopen(url, existing, name, canvas);
    return;
  }

  let external: string;
  let frameOrigin: string;
  try {
    ({ external, frameOrigin } = await resolveExternal(url));
  } catch (err) {
    void vscode.window.showErrorMessage(`Remote VNC: cannot resolve "${url}" — ${String(err)}`);
    return;
  }

  // Re-check after the await: a double-click fires the command twice, and the
  // second call can pass the first check while the first is still inside
  // asExternalUri. From here to `set` there is no await, so the upsert is
  // atomic.
  const raced = openPanels.get(url);
  if (raced) {
    reopen(url, raced, name, canvas);
    return;
  }

  // A mirrored page needs a browser before it needs a tab. When there is none
  // to be found, say so once — naming the setting that fixes it — and open the
  // page as an ordinary iframe: a tab without capture beats a tab that can
  // never paint.
  const binary = mirror === true ? resolveChromeBinary() : undefined;
  if (mirror === true && !binary) {
    void vscode.window.showErrorMessage(
      `Remote VNC: no Chrome-family browser found for the mirrored page "${name}". ` +
        'Set "remoteVnc.chromePath" to a Chrome, Chromium or Edge binary. ' +
        'Opening it as a normal page instead.'
    );
  }
  const mirrored = binary !== undefined;

  // No retainContextWhenHidden: the mockup pages this targets run continuous
  // animations, so a retained hidden tab burns CPU; an iframe reload on
  // re-show is cheap for localhost pages. A mirrored tab has the same
  // arrangement from the other side — the screencast stops while hidden.
  const panel = vscode.window.createWebviewPanel(
    'remoteVnc.page',
    name,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // Only the mirror loads anything off disk (its bundle); the iframe path
      // keeps the default roots it has always had.
      ...(mirrored
        ? { localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
        : {}),
    }
  );
  panel.iconPath = brandIconPath(context.extensionUri);
  const entry: OpenPage = {
    panel,
    external,
    frameOrigin,
    canvas,
    mirrored,
    mirrorFailed: false,
    viewport: DEFAULT_VIEWPORT,
    extensionUri: context.extensionUri,
    globalStorageUri: context.globalStorageUri,
    webviewLive: false,
    recording: 'idle',
    recordStartWaiters: [],
    recordStopWaiters: [],
    preUse: use?.preUseCommand ? 'running' : 'none',
  };
  // The pre-use command runs BEFORE the URL is loaded, and the tab says so
  // while it does. Loading first would defeat the whole point: the page this
  // was written for is served by the very process the command starts, so
  // "load then start" is a guaranteed error page followed by a stale one.
  panel.webview.html =
    entry.preUse === 'running'
      ? renderUseStatusHtml(name, use?.preUseCommand ?? '')
      : mirrored
        ? renderMirrorHtml(panel.webview, context.extensionUri)
        : renderPageHtml(withCacheBust(external), frameOrigin, canvas);
  openPanels.set(url, entry);
  const id = pageId(url);
  openPanelsById.set(id, entry);
  registerPageEntry(url, entry, name);
  // A freshly opened tab is the active one before any onDidChangeViewState
  // fires (that event only reports subsequent changes) — the hotkey chords
  // must resolve to it immediately, not just after the user alt-tabs away
  // and back.
  setFocusedPanel(id);
  void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', true);
  // Installed before Chrome is even launched: the webview reports its size as
  // soon as it loads, and that measurement is what the first
  // setDeviceMetricsOverride uses.
  if (mirrored) {
    panel.webview.onDidReceiveMessage((raw) => void handleMirrorMessage(entry, raw));
  }
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) {
      setFocusedPanel(id);
      void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', true);
    } else if (getFocusedPanel()?.id === id) {
      // Only the panel that is actually focused may clear the key — a
      // background tab going inactive must not blow away the context a
      // different, now-focused tab just set.
      setFocusedPanel(undefined);
      void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', false);
    }
    if (entry.mirrored) {
      applyMirrorViewState(entry);
    }
  });
  panel.onDidDispose(() => {
    // Guard by identity — a stale dispose must not unregister a newer panel.
    // The same hazard applies to the registry entry: only the dispose of the
    // panel that is still current for this URL may remove it.
    if (openPanels.get(url)?.panel === panel) {
      openPanels.delete(url);
      openPanelsById.delete(id);
      const wasFocused = getFocusedPanel()?.id === id;
      unregisterPanel(id);
      // Closing a tab does not fire onDidChangeViewState first, so the
      // context key needs its own clear here — otherwise a stale "true"
      // would hijack the chords in whatever the user looks at next.
      if (wasFocused) {
        void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', false);
      }
    }
    // Unconditional: this panel's own Chrome tab is this panel's to close,
    // whether or not it is still the current one for the URL. The post-use
    // claim is unconditional for the same reason, and safe to be: it is
    // released by token, so a stale dispose gives up only its own claim and a
    // newer panel's keeps the command from running under it.
    closeMirror(entry);
    releaseUseClaim(entry);
  });
  // Taken before the pre-use command runs, not after it succeeds: a command
  // that fails halfway has still started something, and the stop command is
  // what cleans that up. Closing the failed tab is then the way to run it.
  if (use) {
    entry.useToken = holdPostUseCommand(name, use);
  }

  if (use?.preUseCommand) {
    const pending = runPreUseCommand(name, use);
    // Visible to the dispose handler for as long as the command runs: closing
    // the tab now must not release the claim under it (releaseUseClaim).
    entry.preUsePending = pending;
    let result: Awaited<typeof pending>;
    try {
      result = await pending;
    } finally {
      entry.preUsePending = undefined;
    }
    // The user can close the tab while the command runs, and a disposed
    // webview throws on assignment. Identity, not existence — the same guard
    // onDidDispose uses, because the URL may already belong to a newer panel.
    if (openPanels.get(url)?.panel !== panel) {
      return;
    }
    if (!result.ok) {
      // Not a blank tab and not a silent log line: the panel says what failed
      // and what to do next, and the notification repeats it for a user whose
      // attention was elsewhere. The full output is already in the channel.
      entry.preUse = 'failed';
      panel.webview.html = renderUseFailureHtml(name, result.message);
      void vscode.window.showErrorMessage(result.message);
      return;
    }
    entry.preUse = 'ready';
    panel.webview.html = mirrored
      ? renderMirrorHtml(panel.webview, context.extensionUri)
      : renderPageHtml(withCacheBust(external), frameOrigin, canvas);
  }
  logger().info(
    `page: opened "${name}" → ${logSafeUrl(external)}${canvas ? ` @${canvas.width}x${canvas.height}` : ''}` +
      `${mirrored ? ' (mirrored)' : ''}`
  );
  if (mirrored && binary) {
    void startMirror(context, entry, binary, url, name);
  }
}

/**
 * Re-open of an already-open page: re-title (same URL may be saved under a
 * renamed entry), rebuild the webview HTML — recreating the iframe forces a
 * full document reload — and reveal. The canvas is taken from the saved entry
 * being opened, so editing its size takes effect without closing the tab.
 *
 * A mirrored tab is pointedly NOT rebuilt. It already shows the current state,
 * and reloading would throw away the session the user clicked into — the one
 * thing mirroring exists to keep. Only its viewport is re-applied.
 *
 * It is also the escape hatch for a mirror that has stopped painting, which is
 * a thing users already try on anything that looks stuck — see `reopenMirror`,
 * which is what makes that attempt actually do something.
 */
function reopen(url: string, entry: OpenPage, name: string, canvas?: PageCanvas): void {
  entry.canvas = canvas ?? entry.canvas;
  entry.panel.title = name;
  // A tab still waiting on its pre-use command, or one whose command failed,
  // has no URL to reload — rebuilding the webview here would load the very
  // URL the command exists to bring into being, and would also wipe the
  // failure the user is meant to read. Reveal it and leave it alone.
  if (entry.preUse === 'running' || entry.preUse === 'failed') {
    entry.panel.reveal();
    registerPageEntry(url, entry, name);
    return;
  }
  if (entry.mirrored) {
    void reopenMirror(entry).catch(logMirrorFailure);
  } else {
    entry.panel.webview.html = renderPageHtml(
      withCacheBust(entry.external),
      entry.frameOrigin,
      entry.canvas
    );
  }
  entry.panel.reveal();
  // Re-register: registerPanel replaces by id, so a rename (same URL, saved
  // under a new name) keeps the registry's summary in sync.
  registerPageEntry(url, entry, name);
  logger().info(`page: reloaded "${name}" → ${logSafeUrl(entry.external)}`);
}

/**
 * A per-load cache-busting query param. The framed document would otherwise
 * be served from Chromium's heuristic cache (servers that send only
 * Last-Modified, like python http.server, get cached for 10% of the file's
 * age) — a "reload" that re-renders stale content. Inserted before the
 * fragment so #state-style hashes keep working.
 */
function withCacheBust(external: string): string {
  const hashIdx = external.indexOf('#');
  const base = hashIdx >= 0 ? external.slice(0, hashIdx) : external;
  const frag = hashIdx >= 0 ? external.slice(hashIdx) : '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}rvncReload=${Date.now()}${frag}`;
}

/**
 * Resolve a (possibly container-local) URL to one the webview client can
 * reach. Mirrors toWebviewWsUrl (vncPanel.ts): asExternalUri forwards by
 * authority and must not see the query — vscode.Uri stores components
 * percent-DECODED, so a round-tripped query would come back mangled
 * (`a%26b` → `a&b`). The original raw query/fragment is carried by hand;
 * a tunnel token appended by asExternalUri itself is merged back in.
 *
 * In a *local Dev Container*, asExternalUri does NOT auto-forward and returns
 * the loopback authority unchanged — fine when the port is statically
 * forwarded (forwardPorts / Ports panel), a dead black iframe otherwise, so
 * that case is logged.
 */
async function resolveExternal(url: string): Promise<{ external: string; frameOrigin: string }> {
  const parsed = vscode.Uri.parse(url);
  const tailIndex = url.search(/[?#]/);
  const rawTail = tailIndex >= 0 ? url.slice(tailIndex) : '';

  const ext = await vscode.env.asExternalUri(parsed.with({ query: '', fragment: '' }));
  if (vscode.env.remoteName && ext.authority === parsed.authority) {
    logger().warn(
      `page: asExternalUri left ${parsed.authority} unchanged in a remote window (${vscode.env.remoteName}). ` +
        'The iframe loads on the client — if the tab stays blank, forward the port ' +
        '(forwardPorts in devcontainer.json, or the Ports panel).'
    );
  }

  const path = ext.path && ext.path !== '/' ? ext.path : '/';
  const extQuery = ext.query; // tunnel auth token, if any (plain alphanumerics)
  let tail: string;
  if (rawTail.startsWith('?')) {
    tail = extQuery ? `?${extQuery}&${rawTail.slice(1)}` : rawTail;
  } else {
    tail = (extQuery ? `?${extQuery}` : '') + rawTail; // rawTail is '' or '#…'
  }
  return {
    external: `${ext.scheme}://${ext.authority}${path}${tail}`,
    frameOrigin: `${ext.scheme}://${ext.authority}`,
  };
}

/** Minimal attribute escaping for a URL placed in src="…". */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The two states a tab can be in because of a `preUseCommand`, as documents
 * rather than as an empty webview.
 *
 * Both fetch nothing at all, so the CSP is the narrowest in the file bar the
 * mirror's: no scripts (there is nothing to run), no frames, no images. That
 * matters more here than elsewhere, because the text placed into them includes
 * a command line and a command's own output — attacker-influenced by
 * construction — so it is escaped and the document could not execute it even
 * if the escaping were wrong.
 */
function renderUseShell(title: string, body: string): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%;
                 background: var(--vscode-editor-background, #1e1e1e);
                 color: var(--vscode-foreground, #ccc);
                 font: 13px var(--vscode-font-family, sans-serif); }
    .stage { box-sizing: border-box; width: 100%; height: 100%; padding: 2.5rem;
             display: flex; flex-direction: column; align-items: center;
             justify-content: center; gap: 0.9rem; text-align: center; }
    h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
    p { margin: 0; max-width: 46rem; color: var(--vscode-descriptionForeground, #999); }
    pre { margin: 0; max-width: 46rem; max-height: 40%; overflow: auto;
          white-space: pre-wrap; text-align: left; padding: 0.7rem 0.9rem;
          border-radius: 4px; font: 12px var(--vscode-editor-font-family, monospace);
          background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); }
    .bad { color: var(--vscode-errorForeground, #f48771); }
  </style>
</head>
<body><div class="stage"><h1>${title}</h1>${body}</div></body>
</html>`;
}

/** The waiting state: named, so it is obvious which entry is holding the tab. */
function renderUseStatusHtml(name: string, command: string): string {
  return renderUseShell(
    `Running ${escapeAttr(name)}’s preUseCommand…`,
    `<pre>${escapeAttr(command)}</pre>` +
      '<p>The page will load once the command exits successfully.</p>'
  );
}

/**
 * The failure state. It names the way out explicitly, because there is exactly
 * one and it is not obvious: the command is not re-run on reopen (that would
 * restart a stack under a live tab), so retrying means closing this tab first.
 */
function renderUseFailureHtml(name: string, message: string): string {
  return renderUseShell(
    `${escapeAttr(name)} was not opened`,
    `<pre class="bad">${escapeAttr(message)}</pre>` +
      '<p>Close this tab and open the entry again to retry. The full command output is ' +
      'in the “Remote VNC” output channel (View → Output).</p>'
  );
}

/**
 * The title a mirrored tab should carry, given where it was opened and where it
 * is now.
 *
 * A mirrored tab is a real browser tab with no URL bar, and the page can
 * navigate itself while every forwarded keystroke follows it. The tab said
 * nothing about that: the title was the saved entry's name from open to close.
 *
 * Origin, not URL, and that is the whole design. A path or query change is what
 * a page does — a title that rewrote itself on every route would be noise, and
 * noise is what makes the one change worth noticing invisible. It is also why
 * only the origin is printed: the path and query of a page we did not send the
 * user to are not ours to put on screen (they carry tokens often enough).
 *
 * Opaque and transient locations report nothing. `about:blank` is what a tab
 * shows mid-navigation, and flickering the title through it on every redirect
 * would train the user to ignore the signal.
 */
export function mirrorTabTitle(name: string, savedUrl: string, currentUrl?: string): string {
  const origin = originOrUndefined(currentUrl);
  const saved = originOrUndefined(savedUrl);
  return origin && saved && origin !== saved ? `${name} — ${origin}` : name;
}

/** An origin, or undefined for anything without a real one. */
function originOrUndefined(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const { origin } = new URL(url);
    // `about:blank` and `data:` URLs parse but have the opaque origin "null".
    return origin && origin !== 'null' ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function renderPageHtml(src: string, frameOrigin: string, canvas?: PageCanvas): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  // frame-src is pinned to the resolved page origin (same idiom as
  // vncPanel's exact-origin connect-src): the framed page can navigate
  // within its own origin, but a link/redirect cannot silently take the
  // full-bleed tab — which has no URL bar — to an arbitrary external site.
  // escapeAttr, exactly as the sibling src="…" gets: frameOrigin is
  // `${scheme}://${authority}` of a saved entry's URL, and vscode.Uri keeps an
  // authority's characters verbatim, so a quote in it would close this
  // attribute — and with it the very policy that governs the document.
  const csp = `default-src 'none'; frame-src ${escapeAttr(frameOrigin)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  // Fixed canvas (design mockups): render the page in a width×height viewport
  // and scale it to fit the tab, centered — the same look as the VNC viewer's
  // scaleViewport, letterboxed on the editor background instead of black.
  const body = canvas
    ? `<div class="stage"><iframe class="fixed" width="${canvas.width}" height="${canvas.height}"
         src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write"></iframe></div>
  <script nonce="${nonce}">
    (function () {
      const W = ${canvas.width}, H = ${canvas.height};
      const frame = document.querySelector('iframe');
      const fit = () => {
        const s = Math.min(window.innerWidth / W, window.innerHeight / H);
        frame.style.transform = 'scale(' + s + ')';
      };
      window.addEventListener('resize', fit);
      fit();
    })();
  </script>`
    : `<iframe class="fill" src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write"></iframe>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
                 background: var(--vscode-editor-background, #1e1e1e); }
    iframe { border: none; }
    iframe.fill { display: block; width: 100%; height: 100%; }
    .stage { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    iframe.fixed { flex: none; transform-origin: center center; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

/**
 * The mirrored tab: one canvas, one script, nothing else.
 *
 * The narrowest CSP in the extension, and it can be: frames arrive as
 * postMessage payloads and are decoded in memory, so this document fetches
 * nothing at all. No `frame-src` (there is no iframe), no `connect-src` (which
 * is exactly why media/pageMirror.ts decodes base64 by hand rather than
 * through a `data:` URL), and no `img-src` — `createImageBitmap(Blob)` is not
 * an image load, and the document has no `<img>` to govern.
 */
function renderMirrorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'pageMirror.js')
  );
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
                 background: var(--vscode-editor-background, #1e1e1e); }
    .stage { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    /* The canvas carries the mirrored page's own pixel size, so max-* alone
       letterboxes it into the tab with its aspect ratio intact — the same look
       the fixed-canvas iframe gets from its transform. */
    canvas { display: block; max-width: 100%; max-height: 100%; }
    /* Chrome's first launch creates a profile and can take seconds; an empty
       tab in the meantime reads as a broken one. Overlaid rather than in flow,
       so it does not shift the canvas it is standing in for. */
    .status { position: absolute; inset: 0; display: flex; align-items: center;
              justify-content: center; pointer-events: none;
              font: 12px var(--vscode-font-family, sans-serif);
              color: var(--vscode-descriptionForeground, #999); }
  </style>
</head>
<body>
  <div class="stage"><canvas id="screen" width="1" height="1"></canvas></div>
  <div class="status" id="status">Starting the mirrored browser…</div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * A stable registry id for a saved page: a short hash of its URL rather than
 * anything tied to the current `OpenPage`/panel object, so a page closed and
 * reopened later — a fresh panel, a fresh `OpenPage` — keeps the same id
 * across the control server and the hotkey dispatcher. Sixteen hex chars is
 * far more than the handful of saved pages any one user has, and short
 * enough to sit comfortably in a `/targets/:id/...` path segment.
 *
 * Exported so a caller that only has the saved URL — the Web Pages tree's
 * screenshot/record commands, which run from a `PageTreeItem` rather than a
 * live `OpenPage` — can resolve the same registry id without re-deriving the
 * hash by hand.
 */
export function pageId(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/**
 * Register (or re-register, on rename/reopen) a page tab with the shared
 * panel registry. An iframe page's pixels are not ours to read, so screenshot
 * and record reject with a clear reason instead of silently producing a blank
 * capture. `mirrored` is the flag clients filter on to tell the two apart, so
 * it has to describe this tab's actual rendering rather than the page's wish:
 * a page asking for a mirror on a machine with no Chrome is an iframe like any
 * other, and re-registering after the startMirror fallback (mirrored flips to
 * false) is what keeps a script's view of that tab honest.
 *
 * A mirrored tab's three registry methods are deliberately the no-dialog kind
 * (mirrors VncSession's own registry methods, `captureScreenshot`/
 * `captureStartRecording`/`captureStopRecording`): the control server calls
 * `screenshot()`/`record()`/`recordStop()` directly with no one able to answer
 * a save dialog on a window it cannot see, so a dialog anywhere in here would
 * hang that request forever.
 *
 * That silence must never reach a human, though — it did once, for a VNC
 * session, and was fixed by giving the *interactive* dispatchers their own
 * path that never touches this registry at all. The focused-panel hotkeys and
 * the Web Pages tree's commands (`remoteVnc.screenshotPage`/`recordPage`) are
 * that same fix applied here: they call `takePageScreenshot`/`toggleRecordPage`
 * below, not `screenshot()`/`record()`/`recordStop()` on the `PanelEntry` this
 * function builds — those three are reachable ONLY through the panel registry
 * (`src/panelRegistry.ts`), which today means only the control server.
 */
export function registerPageEntry(url: string, entry: OpenPage, name: string): void {
  // 'page is not mirrored' is reserved and pinned by test/pageCapture.test.mjs
  // and test/controlRoutes.test.mjs — it must stay exact for a page that never
  // asked to mirror. A page that DID ask, whose Chrome failed to launch, gets
  // MIRROR_LAUNCH_FAILED_MESSAGE instead: same `mirrored: false`, a different
  // fix (close the tab and open it again retries the launch; this one has a
  // launch to retry at all, unlike the other case), so it needs its own
  // wording. entry.mirrorFailed is the only place that distinction
  // survives; see its doc comment on OpenPage.
  const notMirrored = (): Promise<never> =>
    Promise.reject(new Error(entry.mirrorFailed ? MIRROR_LAUNCH_FAILED_MESSAGE : 'page is not mirrored'));
  registerPanel({
    id: pageId(url),
    name,
    kind: 'page',
    mirrored: entry.mirrored,
    screenshot: entry.mirrored ? () => capturePageScreenshot(entry) : notMirrored,
    record: entry.mirrored ? () => startPageRecording(entry) : notMirrored,
    recordStop: entry.mirrored ? () => stopPageRecording(entry) : notMirrored,
    reload: () => reloadPage(entry),
    isRecording: () => entry.recording !== 'idle',
  });
}

/**
 * Reload the page a tab is showing, by whichever route it is showing it.
 *
 * Both flags, not either: `mirrored` is what the registry reports and `mirror`
 * is the live session, and a tab that fell back to the iframe after a failed
 * launch is the case where trusting one alone sends a reload to a browser tab
 * nobody is looking at.
 */
async function reloadPage(entry: OpenPage): Promise<void> {
  // A reload is "show me the current state", and for a tab still waiting on
  // its pre-use command — or one whose command failed — the honest answer is
  // that there is nothing to show yet. Rendering the page HTML here would load
  // the very URL the command exists to bring into being, which is the one
  // thing the pre-use path guarantees does not happen. Reachable from the
  // control server, which has no other way to know.
  if (entry.preUse === 'running' || entry.preUse === 'failed') {
    throw new Error(
      entry.preUse === 'running'
        ? 'the page is still running its preUseCommand'
        : 'the page did not open: its preUseCommand failed'
    );
  }
  if (entry.mirrored && entry.mirror) {
    // A real browser tab reloads in the browser. Re-rendering the webview
    // would rebuild the canvas the frames land on and leave the page alone.
    await entry.mirror.cdp.send('Page.reload', { ignoreCache: true }, entry.mirror.sessionId);
    return;
  }
  entry.panel.webview.html = renderPageHtml(
    withCacheBust(entry.external),
    entry.frameOrigin,
    entry.canvas
  );
}

// ---------------------------------------------------------------------------
// Mirror mode
// ---------------------------------------------------------------------------

/**
 * Which binary to drive. A configured path is taken as given — a wrong one
 * fails at launch with Chrome's own error, which says more than a guess of
 * ours would.
 *
 * That trust is only defensible because `remoteVnc.chromePath` is declared
 * `"scope": "machine"` in package.json, which is what keeps a cloned repo's
 * `.vscode/settings.json` from choosing the binary this extension spawns —
 * `machine` can be set in user or remote settings ONLY, unlike the default
 * `window` scope (and unlike `machine-overridable`, which a workspace CAN
 * override). Workspace trust does not cover this: an untrusted workspace's
 * settings still reach `get()`, and a user-level mirrored page would spawn
 * the result. test/manifest.test.mjs pins the scope, because nothing here
 * can see it.
 */
function resolveChromeBinary(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('remoteVnc')
    .get<string>('chromePath')
    ?.trim();
  if (configured) {
    return configured;
  }
  return pickChrome(chromeCandidates(process.platform), binaryExists);
}

/**
 * Whether a candidate names something runnable. chromeCandidates returns
 * absolute paths on macOS and Windows but bare command names on Linux, where
 * distributions disagree on the install prefix — a plain existsSync would find
 * none of them, and every Linux user would quietly get the iframe.
 */
function binaryExists(candidate: string): boolean {
  if (candidate.includes('/') || candidate.includes('\\')) {
    return fs.existsSync(candidate);
  }
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir !== '' && fs.existsSync(path.join(dir, candidate)));
}

/**
 * `remoteVnc.mirrorLaunchTimeout` (seconds, Settings UI) turned into the
 * milliseconds `launchChrome` wants. Read fresh on every launch, not cached:
 * the setting exists precisely so a user hitting the timeout can raise it
 * without reopening the window, and the shared browser is relaunched rarely
 * enough (see BROWSER_GRACE_MS) that re-reading configuration here costs
 * nothing.
 */
function mirrorLaunchTimeoutMs(): number {
  return clampLaunchTimeoutMs(
    vscode.workspace.getConfiguration('remoteVnc').get<number>('mirrorLaunchTimeout', 45)
  );
}

/**
 * One Chrome per window, shared by every mirrored tab in it. The launch
 * promise itself is the memo, so two tabs opened in the same tick wait on one
 * process rather than racing two into the same profile directory.
 */
let browser: Promise<ChromeHandle> | undefined;
let browserShutdown: ReturnType<typeof setTimeout> | undefined;

function sharedBrowser(context: vscode.ExtensionContext, binary: string): Promise<ChromeHandle> {
  if (browserShutdown) {
    clearTimeout(browserShutdown);
    browserShutdown = undefined;
  }
  if (!browser) {
    // A private profile under globalStorage: it keeps the cookies and
    // localStorage of "the state I clicked into" across reopens, and it
    // guarantees we never touch the user's own Chrome profile — which is
    // locked by their running browser anyway.
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'chrome');
    browser = Promise.resolve(vscode.workspace.fs.createDirectory(dir))
      .then(() =>
        launchChrome({ binary, userDataDir: dir.fsPath, launchTimeoutMs: mirrorLaunchTimeoutMs() })
      )
      .then((handle) => {
        // One frame handler for the whole connection, dispatching by session
        // id. CdpConnection has no `off`, so a handler per panel would outlive
        // its panel and hold it forever.
        handle.cdp.on('Page.screencastFrame', onScreencastFrame);
        handle.cdp.on('Page.frameNavigated', onFrameNavigated);
        return handle;
      })
      .catch((err: unknown) => {
        // A failed launch must not be remembered: every later open would await
        // the same rejection instead of retrying once the path is fixed.
        browser = undefined;
        throw err;
      });
  }
  return browser;
}

/** Wire up one panel's tab: attach, size it, and start the stream. */
async function startMirror(
  context: vscode.ExtensionContext,
  entry: OpenPage,
  binary: string,
  url: string,
  name: string
): Promise<void> {
  try {
    const handle = await sharedBrowser(context, binary);
    if (openPanels.get(url) !== entry) {
      return; // closed while Chrome was starting; nothing to attach to
    }
    // The saved URL, not the asExternalUri one: Chrome runs beside the
    // extension host, so it reaches the dev server directly. The tunnelled
    // form exists for the *client's* iframe and would only add a hop.
    const { sessionId, targetId } = await openTarget(handle.cdp, url);
    if (openPanels.get(url) !== entry) {
      await handle.cdp.send('Target.closeTarget', { targetId });
      return;
    }
    entry.mirror = {
      cdp: handle.cdp,
      sessionId,
      targetId,
      savedName: name,
      savedUrl: url,
      unacked: [],
      size: { width: 0, height: 0 },
      running: false,
      everyNthFrame: 0,
      pendingEveryNthFrame: 0,
      inFlightInput: 0,
      peakInFlightInput: 0,
      droppedMoves: 0,
      degraded: false,
      warnedDegraded: false,
    };
    mirrors.set(sessionId, entry);
    // The Page domain has to be on for Page.frameNavigated to be delivered —
    // the mirror ran without it, listening only for screencast frames, which is
    // why a tab could be navigated out from under the user with nothing to say
    // so. Non-fatal: a tab that streams but cannot report where it went is far
    // better than no tab, so a failure here must not reach the catch below and
    // tear the mirror down.
    await handle.cdp
      .send('Page.enable', {}, sessionId)
      .catch((err: unknown) => logger().warn(`mirror: Page.enable failed — ${String(err)}`));
    await applyViewport(entry);
    await ensureStreaming(entry);
  } catch (err) {
    logger().error(`mirror: "${name}" failed — ${String(err)}`);
    void vscode.window.showErrorMessage(
      `Remote VNC: could not mirror "${name}" — ${String(err)}. Opening it as a normal page instead.`
    );
    // Fall back in place: the tab is already open, so swap the canvas for the
    // iframe rather than leaving the user looking at a permanent "starting…".
    //
    // closeMirror first, because the failure can come from applyViewport or
    // ensureStreaming — by which point the session is assigned and routed.
    // Left behind, it would take reload() to a Chrome tab nobody can see while
    // the iframe the user IS looking at never reloads, and it would still name
    // a connection that releaseBrowser (now counting zero mirrors) is about to
    // kill. It also disposes the browser if this was the last mirror.
    entry.mirrored = false;
    // Distinguishes this page from one that never asked to mirror at all —
    // see the field's own doc comment on OpenPage. Set in the same breath as
    // `mirrored = false` because this catch is the only place either flag is
    // known; a later reader has no way to reconstruct which case it is in.
    entry.mirrorFailed = true;
    closeMirror(entry);
    if (openPanels.get(url) === entry) {
      entry.panel.webview.html = renderPageHtml(
        withCacheBust(entry.external),
        entry.frameOrigin,
        entry.canvas
      );
      registerPageEntry(url, entry, name);
    }
  }
}

/**
 * The mirror webview's two capture-result messages — the ack for a
 * `record()`/`recordStop()` call and the finished recording itself. Not part
 * of `parseMirrorRequest`'s allowlist: those messages become CDP calls, and
 * these never do — they are consumed here directly, the same way
 * `VncSession.onMessage` (src/vncPanel.ts) handles its own webview's
 * 'record-status'/'recording' without going through a shared translator.
 */
type RecordWebviewMessage =
  | { type: 'record-status'; recording: boolean; error?: string }
  | {
      type: 'recording';
      format: RecordingFormat;
      data: Uint8Array | ArrayBuffer;
      durationMs: number;
      reason: RecordingStopReason;
    };

function isRecordWebviewMessage(raw: unknown): raw is RecordWebviewMessage {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const type = (raw as Record<string, unknown>).type;
  return type === 'record-status' || type === 'recording';
}

/**
 * Everything the webview is allowed to ask for, and nothing else:
 * parseMirrorRequest is the allowlist, and it returns a CDP method only for
 * input events. See src/mirrorInput.ts for why that boundary is drawn there
 * rather than here. Capture-result messages are checked first, ahead of that
 * allowlist, because they carry recording bytes rather than anything destined
 * for a CDP call.
 */
export async function handleMirrorMessage(entry: OpenPage, raw: unknown): Promise<void> {
  if (isRecordWebviewMessage(raw)) {
    handleRecordMessage(entry, raw);
    return;
  }
  // process.platform, not vscode.env or an OS lookup of the MIRRORED
  // Chrome's own platform: the headless browser this extension launches is
  // always a child of this same process, on this same machine, so the
  // extension host's platform IS the mirrored Chrome's platform.
  const request = parseMirrorRequest(raw, process.platform);
  if (!request) {
    return;
  }
  if (request.kind === 'viewport') {
    // Doubles as the webview's "I am loaded" signal — it is posted from the
    // top level of the bundle, so it is the first thing any live webview says.
    entry.webviewLive = true;
    entry.viewport = { width: request.width, height: request.height };
    await applyViewport(entry).catch(logMirrorFailure);
    await ensureStreaming(entry);
    return;
  }
  if (request.kind === 'chord') {
    // The chord never reaches VS Code's dispatcher — media/pageMirror.ts
    // claims every key so the mirrored page does not lose half its keystrokes
    // to whatever workbench shortcut sits behind the canvas — so the webview
    // forwards the intent instead. Run the same commands the keybindings
    // would, exactly as src/vncPanel.ts's onMessage does for its own webview,
    // so there is one code path for both routes.
    void vscode.commands.executeCommand(
      request.action === 'screenshot' ? 'remoteVnc.screenshotFocused' : 'remoteVnc.recordFocusedToggle'
    );
    return;
  }
  const session = entry.mirror;
  if (!session) {
    return; // still launching, or already gone
  }
  if (request.kind === 'ack') {
    // Oldest first, one ack per frame. Acking the newest id instead would
    // leave any frame still in flight unacknowledged, and Chrome stops the
    // stream after a few of those — a page that silently freezes.
    const frameId = session.unacked.shift();
    if (frameId !== undefined) {
      await session.cdp
        .send('Page.screencastFrameAck', { sessionId: frameId }, session.sessionId)
        .catch(logMirrorFailure);
    }
    return;
  }
  // Only mouse, key and wheel input reach here — viewport, chord and ack all
  // returned above, and MirrorRequest has no other `kind`. This is the one
  // and only signal "the user is actually interacting" gets, so it is where
  // the active/idle rate tracks activity from; see noteMirrorInput.
  //
  // Noted BEFORE the backpressure gate: a move refused below is still the
  // user moving the mouse, and the rate should follow what they are doing,
  // not what we chose to forward.
  noteMirrorInput(entry);
  if (!mayForwardInput(request.params, session.inFlightInput)) {
    session.droppedMoves++;
    return;
  }
  await dispatchInput(entry, session, request.method, request.params);
}

/**
 * Forward one input event to Chrome, counting it for as long as it is
 * outstanding.
 *
 * The counting is the point. `Input.dispatch*`'s CDP response is deferred by
 * Chromium until the page's renderer has acknowledged the event, so this
 * promise is a renderer-latency probe that this file was already holding and
 * throwing away — see MAX_INFLIGHT_INPUT (src/mirrorInput.ts) for the
 * measured session where 128 of them were outstanding at teardown with
 * nothing anywhere reporting a number.
 *
 * Errors are logged here rather than left to the caller so the `finally` is
 * the single place the count comes back down — including for a dispatch that
 * timed out (INPUT_DISPATCH_TIMEOUT_MS), which is the only thing that ever
 * releases one Chrome will not answer.
 */
async function dispatchInput(
  entry: OpenPage,
  session: MirrorSession,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  session.inFlightInput++;
  session.peakInFlightInput = Math.max(session.peakInFlightInput, session.inFlightInput);
  if (session.inFlightInput >= MAX_INFLIGHT_INPUT) {
    markMirrorDegraded(entry, session);
  }
  try {
    await session.cdp.send(method, params, session.sessionId, INPUT_DISPATCH_TIMEOUT_MS);
  } catch (err) {
    logMirrorFailure(err);
  } finally {
    // Clamped at zero because `recoverMirror` resets the count while
    // dispatches are still outstanding: their answers (or timeouts) arrive
    // afterwards and would otherwise drive the counter negative, which reads
    // as "nothing in flight" forever after.
    session.inFlightInput = Math.max(0, session.inFlightInput - 1);
    if (session.degraded && session.inFlightInput <= RECOVER_INFLIGHT_INPUT) {
      clearMirrorDegraded(entry, session);
    }
  }
}

/** The toast's one button, shared with the recovery it triggers so the two
 *  cannot drift apart. */
const RESTART_MIRROR_ACTION = 'Restart Mirror';

/**
 * Say — once — that this mirror is struggling, and show it on the canvas the
 * user is typing into.
 *
 * Both halves matter and they are deliberately not the same thing. The banner
 * follows the STATE, so it appears and disappears with the backlog; the
 * warning and its toast are latched by `warnedDegraded`, because this runs on
 * a path that fires per keystroke and a message per keystroke is not a
 * message. Without the visible half the user's only evidence is a page that
 * has stopped responding to them, which is exactly how a degraded mirror gets
 * reported as a broken one.
 */
function markMirrorDegraded(entry: OpenPage, session: MirrorSession): void {
  if (session.degraded) {
    return;
  }
  session.degraded = true;
  void entry.panel.webview.postMessage({ type: 'degraded', degraded: true });
  if (session.warnedDegraded) {
    return;
  }
  session.warnedDegraded = true;
  logger().warn(
    `mirror ("${entry.panel.title}"): ${session.inFlightInput} input events are waiting on the ` +
      `page's renderer (cap ${MAX_INFLIGHT_INPUT}) — pointer motion is being dropped until it ` +
      `catches up. Keys and clicks are still forwarded. This is Chrome's own input queue, not a ` +
      `queue in this extension: the renderer answers Input.dispatch* only once it has processed ` +
      `the event, so a page busy compositing an animation falls behind faster than input arrives.`
  );
  void Promise.resolve(
    vscode.window.showWarningMessage(
      `Remote VNC (${entry.panel.title}): the mirrored page is not keeping up with input — ` +
        'pointer motion is being dropped so typing keeps landing.',
      RESTART_MIRROR_ACTION
    )
  ).then((choice) => {
    if (choice === RESTART_MIRROR_ACTION) {
      void recoverMirror(entry).catch(logMirrorFailure);
    }
  });
}

/** The queue drained: drop the banner and write down what the episode cost,
 *  which is the only place the depth this mirror actually reached is ever
 *  recorded while the tab is still open. */
function clearMirrorDegraded(entry: OpenPage, session: MirrorSession): void {
  session.degraded = false;
  void entry.panel.webview.postMessage({ type: 'degraded', degraded: false });
  logger().info(
    `mirror ("${entry.panel.title}"): input backlog cleared — depth ${session.inFlightInput}, ` +
      `peak ${session.peakInFlightInput}, ${session.droppedMoves} pointer moves dropped so far`
  );
}

/**
 * Route a record-start ack or a finished recording to whichever registry
 * caller is waiting, exactly as `VncSession.onMessage` does for its own
 * webview's 'record-status'/'recording' — including the part that matters
 * for this fix: a `record-status` error is ALWAYS logged and toasted, not
 * only when a registry waiter happens to be pending. That is what lets the
 * interactive start (`startPageRecordingInteractive`) stay fire-and-forget,
 * the same as `VncSession.startRecording` — it never pushes a waiter here,
 * so this is the only place its failure is ever reported.
 */
function handleRecordMessage(entry: OpenPage, msg: RecordWebviewMessage): void {
  if (msg.type === 'record-status') {
    if (msg.error) {
      logger().error(`recording (${entry.panel.title}): ${msg.error}`);
      void vscode.window.showWarningMessage(
        `Remote VNC (${entry.panel.title}): could not record — ${msg.error}.`
      );
    }
    entry.recording = msg.recording ? 'recording' : 'idle';
    const waiters = entry.recordStartWaiters.splice(0);
    for (const w of waiters) {
      if (msg.recording) {
        w.resolve();
      } else {
        w.reject(new Error(msg.error ?? 'could not start recording'));
      }
    }
    if (!msg.recording) {
      // A record-status reporting the recording ended or never started can
      // arrive while a STOP is already pending: recordStopWaiters is not
      // only settled by the normal 'recording' finish message below — the
      // webview side can end a take without ever posting that message (a
      // crash, a dropped connection, the tab having gone hidden mid-take).
      // Left unsettled, the control server's recordStop hangs forever (no
      // response timeout — src/controlServer.ts) and the very NEXT
      // recording on this tab silently answers the still-pending, now-stale
      // HTTP request with an unrelated file path once it finally does
      // resolve. This branch is the only OTHER place entry.recording can
      // reach 'idle' from 'recording', so it is the only other place that
      // hang can be caught.
      const stopWaiters = entry.recordStopWaiters.splice(0);
      if (stopWaiters.length > 0) {
        const err = new Error(msg.error ?? 'the mirror stopped recording before it could be saved');
        for (const w of stopWaiters) {
          w.reject(err);
        }
      }
      // The stream may have been running ONLY because this now-ended
      // recording exempted it from the focus gate — see shouldMirrorStream.
      // A failed start is the sharper case: ensureStreaming was already
      // called (see startPageRecording/startPageRecordingInteractive)
      // before this ack arrived, so a failure here can leave a stream
      // running on a tab nothing else will ever ask to stop.
      reapplyStreamingGate(entry);
    }
    return;
  }
  entry.recording = 'idle';
  // Same reasoning as the record-status branch above: this recording (now
  // finished) may have been the only reason the stream was running.
  reapplyStreamingGate(entry);
  // msg.format/msg.data cross the webview boundary untrusted, exactly as
  // VncSession.saveRecordingDirect/handleRecording note of their own
  // webview's message.
  const format: RecordingFormat = msg.format === 'gif' ? 'gif' : 'webm';
  const bytes = recordingBytes(format, msg.data);
  const stopWaiters = entry.recordStopWaiters.splice(0);
  if (!bytes) {
    if (stopWaiters.length > 0) {
      const err = new Error(`the mirrored page returned no usable ${format} data`);
      for (const w of stopWaiters) {
        w.reject(err);
      }
    } else {
      void vscode.window.showWarningMessage(
        `Remote VNC (${entry.panel.title}): the mirror returned no usable ${format} data.`
      );
    }
    return;
  }
  const name = captureFilename(entry.panel.title, new Date(), format);
  // Whether a registry caller is waiting is exactly what tells a
  // stop-that-really-happened-through-the-registry apart from one that
  // happened interactively (a chord, a tree click) — neither
  // `stopPageRecording` nor `stopPageRecordingInteractive` push a waiter for
  // the other kind of caller, so at most one of these branches ever has
  // anything to do. See the `recordStopWaiters` doc comment on `OpenPage`.
  if (stopWaiters.length > 0) {
    void saveCaptureFile(entry, bytes, name, 'recording').then(
      (savedPath) => {
        for (const w of stopWaiters) {
          w.resolve(savedPath);
        }
      },
      (err: unknown) => {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        for (const w of stopWaiters) {
          w.reject(wrapped);
        }
      }
    );
    return;
  }
  const note =
    msg.reason === 'maxDuration'
      ? ' (stopped at the 10-minute limit)'
      : msg.reason === 'disconnected'
        ? ' (session dropped)'
        : '';
  void interactiveSaveCapture(
    entry.globalStorageUri,
    entry.panel.title,
    bytes,
    name,
    recordingFilters(format),
    'recording',
    note
  );
}

/**
 * The CDP half of a screenshot, shared by the registry's `capturePageScreenshot`
 * and the interactive `takePageScreenshot`: `Page.captureScreenshot` at full
 * resolution — never the screencast, which is lossy JPEG scaled to the panel
 * (see SCREENCAST_QUALITY above).
 */
async function fetchPageScreenshotPng(entry: OpenPage): Promise<Buffer> {
  const session = entry.mirror;
  if (!session) {
    throw new Error('mirror is not ready yet');
  }
  const result = (await session.cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    session.sessionId
  )) as { data?: unknown };
  if (typeof result.data !== 'string' || !result.data) {
    throw new Error('the mirrored page returned no usable image data');
  }
  return Buffer.from(result.data, 'base64');
}

/**
 * The registry's screenshot for a mirrored page: saved the same no-dialog way
 * VncSession's registry path saves a session capture. A script awaiting this
 * promise has no one to answer a save dialog — see `registerPageEntry`'s doc
 * comment for why a human-facing caller must never reach this function
 * instead of `takePageScreenshot`.
 */
export async function capturePageScreenshot(entry: OpenPage): Promise<string> {
  const bytes = await fetchPageScreenshotPng(entry);
  const name = captureFilename(entry.panel.title, new Date(), 'png');
  return saveCaptureFile(entry, bytes, name, 'screenshot');
}

/**
 * The interactive screenshot — the focused-panel hotkey (via
 * `takePageScreenshot` below) and the Web Pages tree's
 * `remoteVnc.screenshotPage`. Reads `remoteVnc.screenshotAction`/
 * `screenshotCropEditor` and ends in `interactiveSaveCapture`, exactly as
 * `VncSession.takeScreenshot`+`saveScreenshot` do for a VNC session: a chord
 * in a mirrored page must look and behave like one on a VNC session, never
 * like the registry's silent write.
 */
async function takePageScreenshotInteractive(entry: OpenPage): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await fetchPageScreenshotPng(entry);
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Remote VNC (${entry.panel.title}): could not take a screenshot — ${describeError(err)}.`
    );
    return;
  }
  const name = captureFilename(entry.panel.title, new Date(), 'png');
  await interactiveSaveCapture(
    entry.globalStorageUri,
    entry.panel.title,
    bytes,
    name,
    { 'PNG image': ['png'] },
    'screenshot'
  );
}

/**
 * Why neither registry recording call may post to a webview that is not
 * listening. VS Code silently DROPS a message to such a webview — which is
 * exactly what `webviewLive` tracks (see its doc on `OpenPage`) — so the
 * webview never answers, nothing else settles the waiter until the tab is
 * closed or rebuilt, and `src/controlServer.ts` has no response timeout: the
 * HTTP request hangs. A hidden mirrored tab is the ordinary case here, since
 * VS Code tears the webview down when a tab is not visible and the control
 * server exists precisely to drive tabs nobody is looking at.
 *
 * Worded for a caller that can act on it: revealing the tab is the fix, and it
 * is one the script's own operator can perform.
 */
const NO_WEBVIEW_MESSAGE =
  'the mirrored tab is hidden, so it has no webview to record — reveal the tab and try again';

/**
 * The registry's rejection for a page that asked to mirror but whose Chrome
 * failed to launch — see `registerPageEntry` and `entry.mirrorFailed`. Worded
 * the same way NO_WEBVIEW_MESSAGE is: what happened, and what the caller can
 * do about it, since a script (and the human reading its error) has already
 * been told once, in the launch-failure toast, and would otherwise see only
 * a bare 'page is not mirrored' that reads as "you never asked for this."
 *
 * "Close the tab, then open it again" — not "reopen the tab": `reopen()`
 * (above) is what an already-open URL routes to, and for `mirrored: false`
 * it only rebuilds the iframe HTML — it never re-enters `startMirror`, so
 * that tab can never retry the launch no matter how many times it is
 * revealed. Only closing the panel (which drops its `OpenPage` from
 * `openPanels`) and opening the URL again takes the fresh-tab branch of
 * `openPagePanel` that actually calls `startMirror`. Telling a user to do
 * the thing that does not work is worse than saying nothing — this branch
 * already had to fix a stale comment for the same reason.
 */
const MIRROR_LAUNCH_FAILED_MESSAGE =
  'the mirrored browser failed to launch for this page — close the tab and open it again to retry ' +
  '(reopening it in place will not, since it is already open), or check the "Remote VNC" Output ' +
  'channel for why';

/** The registry's recording start: post the same start message
 *  media/webview.ts answers for a VNC session, to the canvas media/recorder.ts
 *  already paints (Task 6) — resolves once the webview confirms recording
 *  actually began, or rejects with its reported error. Rejects instead of
 *  posting when the webview is not listening (NO_WEBVIEW_MESSAGE): a message
 *  dropped there strands both this promise and `recording: 'starting'`, from
 *  which every stop path then refuses to proceed. */
export function startPageRecording(entry: OpenPage): Promise<void> {
  if (!entry.mirror) {
    return Promise.reject(new Error('mirror is not ready yet'));
  }
  if (!entry.webviewLive) {
    return Promise.reject(new Error(NO_WEBVIEW_MESSAGE));
  }
  if (entry.recording !== 'idle') {
    return Promise.reject(new Error('already recording'));
  }
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const format: RecordingFormat =
    config.get<string>('recordingFormat', 'webm') === 'gif' ? 'gif' : 'webm';
  const fps = clampFps(config.get<number>('recordingFrameRate', 10));
  return new Promise((resolve, reject) => {
    entry.recordStartWaiters.push({ resolve, reject });
    // Set BEFORE ensureStreaming: its gate reads entry.recording, and a
    // recording that has merely been requested must already count — the
    // registry's own caller (the control server, most often) is exactly the
    // case that runs on a tab nobody has focused, which is why the stream
    // may currently be stopped at all.
    entry.recording = 'starting';
    void ensureStreaming(entry).catch(logMirrorFailure);
    void entry.panel.webview.postMessage({ type: 'record-start', format, fps });
  });
}

/**
 * The interactive recording start — fire-and-forget, exactly like
 * `VncSession.startRecording`: no waiter is pushed, so success or failure is
 * reported entirely through `handleRecordMessage`'s own toast (for a
 * failure) or the eventual 'recording' message (for a stop).
 *
 * Needs the same `webviewLive` guard as the registry's `startPageRecording`:
 * this is reached from the Web Pages tree's record button, which has no
 * visibility check of its own (unlike the focused-panel hotkey, which only
 * fires on a panel that is showing). A hidden mirrored tab's webview drops
 * the post silently, stranding `recording: 'starting'` exactly as it would
 * for the registry path — see NO_WEBVIEW_MESSAGE.
 */
function startPageRecordingInteractive(entry: OpenPage): void {
  if (!entry.mirror) {
    void vscode.window.showInformationMessage(
      `Remote VNC (${entry.panel.title}): the mirror is not ready yet.`
    );
    return;
  }
  if (!entry.webviewLive) {
    void vscode.window.showInformationMessage(`Remote VNC (${entry.panel.title}): ${NO_WEBVIEW_MESSAGE}.`);
    return;
  }
  if (entry.recording !== 'idle') {
    void vscode.window.showInformationMessage(`Remote VNC (${entry.panel.title}): already recording.`);
    return;
  }
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const format: RecordingFormat =
    config.get<string>('recordingFormat', 'webm') === 'gif' ? 'gif' : 'webm';
  const fps = clampFps(config.get<number>('recordingFrameRate', 10));
  // Same reasoning as startPageRecording's own ensureStreaming call: the Web
  // Pages tree's record button is the OTHER non-chord way to reach this code,
  // and clicking a sidebar row moves focus off the panel just as surely as
  // the control server driving a tab nobody is looking at does.
  entry.recording = 'starting';
  void ensureStreaming(entry).catch(logMirrorFailure);
  void entry.panel.webview.postMessage({ type: 'record-start', format, fps });
}

/**
 * The registry's recording stop: resolves with the saved file's path.
 *
 * Only proceeds from `'recording'`, never `'starting'` — a stop requested
 * while a start is still in flight used to post `record-stop` anyway, which
 * could beat the webview's own start handling; the resulting
 * `record-status:false` is routed to `recordStartWaiters` (that call's own
 * waiter), and this call's `recordStopWaiters` entry would then sit pending
 * until the panel tore down. Rejecting immediately, without posting
 * anything, closes that race instead of narrowing it.
 *
 * The webview check comes first, ahead of the state check: a tab hidden
 * mid-recording still reads `recording === 'recording'`, and that is the one
 * combination that would otherwise post into the void and hang. See
 * NO_WEBVIEW_MESSAGE.
 */
export function stopPageRecording(entry: OpenPage): Promise<string> {
  if (!entry.webviewLive) {
    return Promise.reject(new Error(NO_WEBVIEW_MESSAGE));
  }
  if (entry.recording !== 'recording') {
    return Promise.reject(new Error(startingOrIdleMessage(entry)));
  }
  return new Promise((resolve, reject) => {
    entry.recordStopWaiters.push({ resolve, reject });
    void entry.panel.webview.postMessage({ type: 'record-stop' });
  });
}

/**
 * The interactive recording stop — fire-and-forget, exactly like
 * `VncSession.stopRecording`: no waiter is pushed, so `handleRecordMessage`
 * finds `recordStopWaiters` empty when the 'recording' message eventually
 * arrives and runs the interactive save instead of the registry's.
 *
 * The webview check comes first, ahead of the state check, for the same
 * reason it does in `stopPageRecording`: a tab hidden mid-recording still
 * reads `recording === 'recording'`, the one combination the state check
 * alone would wave through into a post that drops silently.
 */
function stopPageRecordingInteractive(entry: OpenPage): void {
  if (!entry.webviewLive) {
    void vscode.window.showInformationMessage(`Remote VNC (${entry.panel.title}): ${NO_WEBVIEW_MESSAGE}.`);
    return;
  }
  if (entry.recording !== 'recording') {
    void vscode.window.showInformationMessage(
      `Remote VNC (${entry.panel.title}): ${startingOrIdleMessage(entry)}.`
    );
    return;
  }
  void entry.panel.webview.postMessage({ type: 'record-stop' });
}

/** Why a stop cannot proceed right now — shared so the registry's rejection
 *  and the interactive toast say the same thing. */
function startingOrIdleMessage(entry: OpenPage): string {
  return entry.recording === 'starting'
    ? 'still starting the recording — try again in a moment'
    : 'no recording in progress';
}

/**
 * The no-dialog write shared by a page's screenshot and its registry-driven
 * recording stop: honours `remoteVnc.screenshotDirectory` when set (same
 * expansion as VncSession's own capture paths); otherwise writes under
 * `<globalStorage>/captures`, a destination that always exists and needs no
 * one to answer a prompt.
 */
async function saveCaptureFile(
  entry: OpenPage,
  bytes: Uint8Array,
  name: string,
  kind: 'screenshot' | 'recording'
): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration('remoteVnc')
    .get<string>('screenshotDirectory', '')
    .trim();
  const dir = configured
    ? vscode.Uri.file(expandHome(configured, os.homedir()))
    : vscode.Uri.joinPath(entry.globalStorageUri, 'captures');
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(dir, name);
  await vscode.workspace.fs.writeFile(uri, bytes);
  logger().info(`${kind} saved (${entry.panel.title}, registry) -> ${uri.fsPath}`);
  return uri.fsPath;
}

/**
 * The focused-panel hotkey's / Web-Pages-tree's screenshot for a mirrored
 * page (src/extension.ts) — resolved from a panel id, the same way
 * `VncSessionManager` resolves a VNC session for its own interactive
 * screenshot/record commands.
 */
export async function takePageScreenshot(id: string): Promise<void> {
  const entry = openPanelsById.get(id);
  if (!entry?.mirrored) {
    return; // the caller has already checked kind/mirrored where it can say why
  }
  await takePageScreenshotInteractive(entry);
}

/**
 * The focused-panel hotkey's / Web-Pages-tree's record toggle for a mirrored
 * page — one button, so the current state picks start or stop, the same
 * reasoning `recordFocusedToggle` (src/extension.ts) already uses for a VNC
 * session.
 */
export function toggleRecordPage(id: string): void {
  const entry = openPanelsById.get(id);
  if (!entry?.mirrored) {
    return;
  }
  if (entry.recording !== 'idle') {
    stopPageRecordingInteractive(entry);
  } else {
    startPageRecordingInteractive(entry);
  }
}

/** A page closing (or its webview being rebuilt from under a pending capture)
 *  must not leave a registry caller's promise pending forever — mirrors
 *  VncSession.rejectPendingCaptures. */
function rejectPendingPageCaptures(entry: OpenPage, reason: string): void {
  entry.recording = 'idle';
  const err = new Error(reason);
  for (const w of entry.recordStartWaiters.splice(0)) {
    w.reject(err);
  }
  for (const w of entry.recordStopWaiters.splice(0)) {
    w.reject(err);
  }
}

/** Route one screencast frame to the panel that owns its session. */
/**
 * A mirrored tab reporting where it now is.
 *
 * Only the main frame: a subframe navigating is an ordinary page doing its job
 * (an ad, an embed, an iframe route) and says nothing about where the user's
 * keystrokes are going. The top frame changing origin is the case worth a word,
 * and the word is the tab title — see mirrorTabTitle for why it is the origin
 * and not the URL.
 *
 * Nothing is blocked. A dev server that redirects, or an OAuth round trip, is
 * legitimate and common; this makes the move visible rather than impossible.
 */
function onFrameNavigated(params: Record<string, unknown>, sessionId?: string): void {
  const entry = sessionId ? mirrors.get(sessionId) : undefined;
  const session = entry?.mirror;
  if (!entry || !session) {
    return;
  }
  const frame = params.frame as { url?: unknown; parentId?: unknown } | undefined;
  if (!frame || frame.parentId !== undefined || typeof frame.url !== 'string') {
    return;
  }
  entry.panel.title = mirrorTabTitle(session.savedName, session.savedUrl, frame.url);
}

function onScreencastFrame(params: Record<string, unknown>, sessionId?: string): void {
  const entry = sessionId ? mirrors.get(sessionId) : undefined;
  const session = entry?.mirror;
  if (!entry || !session || typeof params.data !== 'string') {
    return;
  }
  // CDP calls the frame's acknowledgement token `sessionId` as well; it is an
  // integer, and unrelated to the string session id addressing the tab.
  if (typeof params.sessionId === 'number') {
    if (session.unacked.length >= MAX_UNACKED) {
      // Drop the NEWEST rather than the oldest. Acks arrive in order and are
      // matched by position, so discarding the head would silently shift every
      // later ack onto the wrong frame and leave one unacknowledged forever.
      // Chrome's own in-flight limit means this should never be reached, so
      // say something when it is.
      logger().warn(`mirror: ${MAX_UNACKED} frames unacknowledged — dropping a frame id`);
    } else {
      session.unacked.push(params.sessionId);
    }
  }
  void entry.panel.webview.postMessage({ type: 'frame', data: params.data });
}

/**
 * Emulate the viewport the page should lay itself out in — the saved canvas
 * size when it has one, otherwise whatever the panel currently measures.
 *
 * Exported for test/pageMirrorStream.test.mjs, alongside startScreencast and
 * ensureStreaming and for the same reason: `session.size` is a cache of what
 * Chrome has accepted, and anything that writes it without Chrome having
 * accepted it makes the guard below skip the retry — a page stuck at the
 * wrong layout for the life of the tab, with nothing to see but a blurry
 * mirror. It touches nothing but `entry.mirror` and the two sizes, so a fake
 * session reaches all of it.
 */
export async function applyViewport(entry: OpenPage): Promise<void> {
  const session = entry.mirror;
  if (!session) {
    return;
  }
  const size = mirrorViewport(entry.canvas, entry.viewport);
  if (size.width === session.size.width && size.height === session.size.height) {
    return;
  }
  await session.cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false },
    session.sessionId
  );
  // Recorded only once Chrome has accepted it. Assigned before the send, a
  // failed override still reads as applied, the next call at the same size
  // early-returns at the guard above, and the page stays laid out for the old
  // viewport for the life of the tab.
  session.size = size;
  if (session.running) {
    // maxWidth/maxHeight are fixed when the screencast starts, so without a
    // restart the frames would keep arriving at the old size — scaled up and
    // blurred to fill the resized tab.
    await startScreencast(entry);
  }
}

/**
 * Rebuild the surface a mirror paints on, for one whose webview has gone quiet.
 *
 * Measured, not assumed (headless Chrome, an iframe hidden the four ways a
 * workbench can hide one): a document hidden with display:none,
 * visibility:hidden or by being moved off-screen fires NOTHING when it comes
 * back — not pageshow, not visibilitychange, not resize. So a webview VS Code
 * chose to keep alive has no event to re-announce itself from, and no listener
 * added to media/pageMirror.ts could rescue it. Re-rendering the HTML re-runs
 * the bundle, which announces on load like any fresh one.
 *
 * The Chrome tab is not touched: the page, its cookies and its scroll position
 * live there, and only the canvas is replaced. Stop first — frames in flight
 * would land on a webview being torn down, and a frame nobody acknowledges
 * stops the stream for good.
 *
 * This rests on renderMirrorHtml minting a fresh nonce every call, so the
 * string always differs from the one already set and VS Code cannot take its
 * "same html, nothing to do" shortcut. Memoising that nonce for tidiness would
 * turn this function into a no-op, and the symptom would be a tab frozen for
 * good with no error anywhere — which is the failure this exists to undo.
 */
async function restartMirrorWebview(entry: OpenPage): Promise<void> {
  // Before the await, not after: nothing may mistake this webview for a live
  // one from here on, least of all a viewport message arriving mid-teardown.
  entry.webviewLive = false;
  // A recording in progress lives in the very canvas this rebuild throws away,
  // and a webview that goes quiet will not post the 'recording' message a
  // waiting registry caller needs — reject it instead of leaving it pending
  // for a webview that is never coming back.
  rejectPendingPageCaptures(entry, 'the mirror webview was rebuilt');
  await stopScreencast(entry);
  entry.panel.webview.html = renderMirrorHtml(entry.panel.webview, entry.extensionUri);
}

/**
 * The escape hatch for a mirror that has stopped responding — the one thing a
 * user can do about a stuck tab short of closing it.
 *
 * It was documented as that already, and it was unreachable for exactly the
 * case that needs it. `restartMirrorWebview` was gated on `!webviewLive`, and
 * the frozen mirror this branch was written for keeps a perfectly live
 * webview: its canvas is fine, the frames are fine, and what has stopped is
 * the renderer's acknowledgement of input. Clicking the page in the Web Pages
 * tree therefore took the `webviewLive === true` branch, where `applyViewport`
 * early-returns (the size has not changed) and `ensureStreaming` early-returns
 * (`running` is still true) — two awaits and nothing happens, which is worse
 * than no escape hatch, because it teaches the user that nothing helps.
 *
 * What this actually costs: the canvas, and any recording drawing from it.
 * Chrome's tab is untouched — the page, its cookies, its scroll position and
 * everything typed into it so far stay exactly as they are — so this is far
 * closer to "repaint" than to "reload".
 *
 * The counters are reset because the queue being abandoned is Chrome's, not
 * ours: those dispatches may still be answered, may still time out, and
 * `dispatchInput`'s clamp is what keeps their late arrival from driving the
 * count negative. `warnedDegraded` is reset too — a restart is the user
 * explicitly asking for a fresh start, and staying quiet afterwards would
 * hide whether it worked.
 */
export async function recoverMirror(entry: OpenPage): Promise<void> {
  const session = entry.mirror;
  if (session) {
    logger().info(
      `mirror: restarting the surface for "${entry.panel.title}" — input depth ` +
        `${session.inFlightInput} (peak ${session.peakInFlightInput}, ${session.droppedMoves} ` +
        `pointer moves dropped). Chrome's tab and the page state in it are kept; only the ` +
        `canvas is rebuilt.`
    );
    session.inFlightInput = 0;
    session.peakInFlightInput = 0;
    session.droppedMoves = 0;
    session.degraded = false;
    session.warnedDegraded = false;
  }
  await restartMirrorWebview(entry);
}

/**
 * What re-opening an already-open mirrored page does — extracted from
 * `reopen` so it is reachable from a test at all, the same reason
 * `applyMirrorViewState` was extracted from its own closure (`openPagePanel`
 * needs a real `WebviewPanel`, so anything left inline there can be deleted
 * outright with the suite still green).
 *
 * Re-opening now always rebuilds the mirror surface, rather than only when
 * the webview had gone quiet. "Open it again" is what a user reaches for when
 * a tab looks stuck, and for a mirror it is cheap — see `recoverMirror` for
 * what is and is not thrown away.
 *
 * The one exception is a recording in progress, which lives in the very
 * canvas a rebuild discards. Silently ending someone's take because they
 * clicked the page's row would be a new defect in place of the fixed one, so
 * that case keeps the old behaviour and says why.
 */
export async function reopenMirror(entry: OpenPage): Promise<void> {
  if (entry.recording !== 'idle') {
    void vscode.window.showInformationMessage(
      `Remote VNC (${entry.panel.title}): a recording is in progress, so the mirror was left ` +
        'alone — stop the recording first to restart it.'
    );
    await applyViewport(entry).catch(logMirrorFailure);
    await ensureStreaming(entry);
    return;
  }
  await recoverMirror(entry);
}

/**
 * The same recovery, addressed by registry id: the Web Pages tree row and the
 * `remoteVnc.restartMirror` command (src/extension.ts) both hold an id rather
 * than an `OpenPage`.
 *
 * Returns whether there was a mirror to restart, so the caller can word the
 * "not open / not mirrored" case with the page's name — the same division of
 * labour `manager.screenshotTarget` already has with its own callers.
 */
export function restartMirrorPage(id: string): boolean {
  const entry = openPanelsById.get(id);
  if (!entry?.mirrored) {
    return false;
  }
  void recoverMirror(entry).catch(logMirrorFailure);
  return true;
}

/**
 * Whether a mirrored tab's screencast should be running right now, given
 * only the three primitive facts that decide it. Pure and exported for
 * test/pageMirrorStream.test.mjs — this is THE gate: `ensureStreaming`
 * (deciding whether to start) and the view-state handler in `openPagePanel`
 * (deciding whether to stop) both call this one function instead of each
 * carrying their own copy, which had already drifted apart once (the
 * view-state handler's copy allowed a hidden-but-recording tab to keep
 * "streaming" with no webview left to paint into — see the HIDDEN case
 * below) before either half of the suite could catch it: the whole
 * `onDidChangeViewState` closure was unreachable from a test, so a `throw`
 * as its first statement still passed the suite.
 *
 * HIDDEN always means false, regardless of recording — checked first, and
 * unconditionally, on purpose: a hidden tab has no webview and therefore no
 * canvas for a recording to capture, so keeping a stream alive for one buys
 * nothing. It also cannot be recovered from short of closing the tab: a
 * hidden, still-`recording`/`starting` entry has no capture UI to ask for a
 * stop (there is no visible tab to click the button on) and — because
 * `reopen()` only rebuilds a webview that is NOT `webviewLive`, and hidden
 * already clears that — no further view-state event ever fires to retry the
 * decision either.
 *
 * Otherwise: `active` (real focus, not just `visible` — a mirror sitting in
 * a split view while the user types in a source file next to it needs no
 * frames at all) OR `recording !== 'idle'` (a recording draws from the very
 * canvas a screencast frame repaints — see media/recorder.ts's
 * `captureStream` — and both non-chord ways to start one, the Web Pages
 * tree's record button and the control server's `record()`, routinely run
 * on a tab that is visible but does not have focus).
 */
export function shouldMirrorStream(
  visible: boolean,
  active: boolean,
  recording: OpenPage['recording']
): boolean {
  if (!visible) {
    return false;
  }
  return active || recording !== 'idle';
}

/**
 * Stream, but only into a webview that exists, is listening, and passes
 * `shouldMirrorStream`.
 *
 * Exported, with startScreencast, for test/pageMirrorStream.test.mjs. Neither
 * touches anything but `entry.mirror`, `entry.webviewLive` and whatever
 * `shouldMirrorStream` reads, so the pair is reachable with a fake session —
 * and the run-state they share has already produced one freeze that no
 * other test in the suite could have caught.
 */
export async function ensureStreaming(entry: OpenPage): Promise<void> {
  const session = entry.mirror;
  if (!session || session.running || !entry.webviewLive) {
    return;
  }
  if (!shouldMirrorStream(entry.panel.visible, entry.panel.active, entry.recording)) {
    return;
  }
  await startScreencast(entry);
}

/**
 * Re-apply `shouldMirrorStream` right now, without waiting for the next
 * view-state event. Needed wherever `entry.recording` transitions AWAY from
 * a value that was itself the only reason the stream was running — a
 * recording ending, or failing to start, on a tab that is visible but not
 * focused must stop the screencast immediately (see `handleRecordMessage`'s
 * two callers), not keep running at the idle rate for the rest of the tab's
 * life with nothing left to show for it.
 */
function reapplyStreamingGate(entry: OpenPage): void {
  if (!entry.mirror) {
    return;
  }
  if (shouldMirrorStream(entry.panel.visible, entry.panel.active, entry.recording)) {
    void ensureStreaming(entry).catch(logMirrorFailure);
  } else {
    void stopScreencast(entry);
  }
}

/**
 * Everything a view-state change (visible/active, read live off `entry.panel`
 * — the same object `onDidChangeViewState`'s own event fires against) means
 * for a mirrored panel's stream and any recording in flight.
 *
 * Exported so it is reachable with a fake entry: the `onDidChangeViewState`
 * closure that used to hold this logic inline is otherwise untestable
 * (`openPagePanel` needs a real `WebviewPanel`), and two different one-line
 * deletions inside it — the hidden-tab stop this ends with (via
 * `reapplyStreamingGate`), and the lost-recording handling below — each left
 * the whole suite green on their own before this extraction and the tests
 * that came with it.
 *
 * Only a HIDDEN tab clears `webviewLive` — an unfocused-but-visible one
 * keeps its webview mounted and listening, and clearing the flag here would
 * make the next `ensureStreaming` call (once refocused) think the webview
 * needs rebuilding when it does not. Clearing it for a genuinely hidden tab
 * is what makes ITS restart safe: this event fires before the rebuilt
 * bundle has run, so `reapplyStreamingGate` below is normally a no-op there
 * too, and the webview's own size report is what actually restarts the
 * stream.
 *
 * Hiding mid-recording is not a graceful stop: with no
 * `retainContextWhenHidden`, VS Code destroys the webview outright, taking
 * its MediaRecorder with it — there is no chance for a terminal message, so
 * nothing else will ever notice this recording is over. Left alone that is
 * silent in two ways, not one: the take itself is lost with no file, no
 * toast, no log; and because nothing reset `entry.recording`,
 * `shouldMirrorStream(true, false, 'recording')` keeps reading true on
 * re-show, so the tab streams at full rate regardless of focus for the rest
 * of its life — the very focus gate this file exists to enforce,
 * permanently defeated. Checked for `'starting'` too, not only
 * `'recording'`: an ack that will now never arrive (the webview it would
 * have come from no longer exists) sticks there exactly the same way.
 *
 * `rejectPendingPageCaptures` resets the state and settles a REGISTRY
 * caller's promise (the control server's `record()`/`recordStop()`); the
 * toast is what reaches an INTERACTIVE recording, which pushes no waiter at
 * all (see `startPageRecordingInteractive`) and would otherwise hear
 * nothing.
 */
export function applyMirrorViewState(entry: OpenPage): void {
  if (!entry.panel.visible) {
    entry.webviewLive = false;
    if (entry.recording !== 'idle') {
      const reason = 'the tab was hidden, which destroys the mirror webview and the recording with it';
      rejectPendingPageCaptures(entry, reason);
      void vscode.window.showWarningMessage(
        `Remote VNC (${entry.panel.title}): recording lost — ${reason}.`
      );
    }
  }
  reapplyStreamingGate(entry);
}

/**
 * The `everyNthFrame` a screencast starts with, derived from
 * `remoteVnc.mirrorFrameRate` (the ACTIVE rate) and the current activity
 * state of `entry.mirror` (see src/mirrorRate.ts for the active/idle split
 * and why one fixed rate cannot serve both watching and typing).
 *
 * Why a derivation and not the setting itself: `Page.startScreencast` has no
 * frame-rate parameter. Chrome emits one frame per frame it COMPOSITES, and
 * `everyNthFrame` is a plain divisor of that stream — so the mapping is
 * `composite rate / wanted fps`, and it is a ceiling rather than a rate.
 * It is approximate in both directions: a page compositing below 60 Hz (or
 * not at all, which is every static page) delivers proportionally fewer
 * frames, and the assumed 60 Hz is Chrome's synthetic headless vsync rather
 * than anything CDP will tell us.
 *
 * Omitting it entirely — which is what this did — means every composited
 * frame is JPEG-encoded and shipped. Measured on one mirrored tab running a
 * continuous background animation: 144% CPU across the browser's 11 processes,
 * the browser process alone at 97%. An animated page never goes idle, so that
 * is not a spike, it is the resting cost of having the tab open.
 *
 * Read per start, not cached: applyViewport restarts the screencast on every
 * resize, and applyMirrorRate restarts it on an activity change, so a
 * changed setting or a fresh keystroke both take effect without reopening
 * the tab.
 */
function screencastEveryNthFrame(entry: OpenPage): number {
  // clampFps is the recorder's own 1..30 clamp (src/recording.ts), reused
  // rather than reproduced: the two settings bound the same kind of quantity.
  // Its non-finite fallback is a fixed 10, though — that is clampFps's own
  // choice, not DEFAULT_MIRROR_FPS below, and the two only ever coincided
  // because the mirror's default used to also be 10. A mirrorFrameRate that
  // is SET but unreadable (e.g. a string) now falls back to 10 fps, distinct
  // from the 30 an entirely UNSET one gets from the `.get()` default just
  // below — both defensible, neither worth unifying at the cost of a shared
  // constant crossing a module boundary for it.
  const activeFps = clampFps(
    vscode.workspace
      .getConfiguration('remoteVnc')
      .get<number>('mirrorFrameRate', DEFAULT_MIRROR_FPS)
  );
  const fps = selectMirrorFps(
    entry.mirror?.lastInputAt,
    Date.now(),
    activeFps,
    deriveIdleFps(activeFps),
    ACTIVE_WINDOW_MS
  );
  return Math.max(1, Math.round(ASSUMED_COMPOSITE_HZ / fps));
}

/**
 * `everyNthFrame` is an optional seam, not a public knob: every caller except
 * `applyMirrorRate` omits it and gets it computed fresh here, which is what
 * keeps `applyViewport`'s and `ensureStreaming`'s own restarts honest about
 * the CURRENT rate. `applyMirrorRate` is the one caller that has ALREADY
 * computed it — to decide whether a restart is even needed — and passing that
 * same value through avoids reading `remoteVnc.mirrorFrameRate` and
 * `Date.now()` a second time for a single restart, with a real (if narrow)
 * chance of the active/idle boundary flipping between the two reads.
 */
export async function startScreencast(entry: OpenPage, everyNthFrame?: number): Promise<void> {
  const session = entry.mirror;
  if (!session) {
    return;
  }
  // Ids from a previous run mean nothing to Chrome now; acking them would
  // desynchronise the queue against the frames actually in flight.
  session.unacked.length = 0;
  // Whether this is a fresh start or a rate restart of an already-running
  // stream — read before `running` is claimed below, which would otherwise
  // make every call look like a restart.
  const wasRunning = session.running;
  // Claimed for the duration of the call so two callers racing — the size
  // report and the visibility change routinely arrive together — do not both
  // start it.
  session.running = true;
  const nth = everyNthFrame ?? screencastEveryNthFrame(entry);
  // Claimed in the same synchronous stretch as `running`, and for the same
  // reason. `everyNthFrame` below is only written AFTER the awaited round
  // trip, so every input arriving inside that window found the old divisor
  // still recorded and fired its own duplicate Page.startScreencast —
  // bounded at a few per rate transition today, but the bound is "how many
  // events arrive while Chrome is answering", which is precisely the
  // quantity that grows when a mirror is in trouble. A claim nothing has to
  // wait for cannot be raced.
  session.pendingEveryNthFrame = nth;
  try {
    await session.cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: SCREENCAST_QUALITY,
        maxWidth: session.size.width,
        maxHeight: session.size.height,
        everyNthFrame: nth,
      },
      session.sessionId
    );
    // Recorded only once Chrome has accepted it, same discipline as
    // applyViewport's own `session.size` — a rejected start must not make
    // applyMirrorRate think the new rate is already running.
    session.everyNthFrame = nth;
  } catch (err) {
    if (wasRunning) {
      // A RESTART of an already-running stream, not a fresh start — reached
      // from applyMirrorRate (a rate change) AND applyViewport (a resize),
      // so this cannot claim to know WHY the restart happened; only that it
      // did not land. `Page.startScreencast` does not implicitly stop a
      // prior one, so Chrome's PREVIOUS cast may well still be live and
      // sending frames. `running` is deliberately left TRUE here — the
      // opposite of the fresh-start branch below — because setting it false
      // would be a second bug on top of the first: `stopScreencast`'s own
      // guard (`!session.running`) would then refuse to ever issue
      // Page.stopScreencast again, so nothing — not a blur, not hiding the
      // tab, not a webview rebuild — could reach that still-live cast; only
      // closing the whole tab (which closes the CDP target outright) would.
      // Leaving `running` true means a later stop attempt can still try.
      logger().warn(
        `mirror: restarting the screencast failed for "${entry.panel.title}" — most likely a ` +
          `dropped CDP connection. Frames, if any are still arriving, keep coming at the divisor ` +
          `Chrome last accepted (every ${session.everyNthFrame || 1} composited frame), not the ` +
          `${nth} just asked for. The stream is left marked as running so a later hide or blur can ` +
          `still attempt to stop it properly; if the connection is really gone that attempt will ` +
          `fail too, and only closing the tab will clear it.`
      );
    } else {
      // A genuinely fresh start failed: there is no live cast to protect,
      // and every ensureStreaming early-returns on `running`, so leaving it
      // stuck true here would freeze the tab for good with nothing to retry.
      session.running = false;
    }
    logMirrorFailure(err);
  }
}

/**
 * Re-evaluate the rate a RUNNING mirror should stream at, and restart the
 * screencast only when the chosen rate actually changed. `everyNthFrame` is
 * fixed for the life of a `Page.startScreencast` call — there is no cheaper
 * way to raise or lower it than asking Chrome to start over — so this exists
 * specifically to avoid doing that on every single keystroke when the rate
 * was already active.
 *
 * A no-op when nothing is currently streaming (hidden, unfocused, or still
 * launching): there is nothing to re-rate, and starting one here would race
 * `ensureStreaming`'s own gating instead of deferring to it.
 *
 * Exported for test/pageMirrorStream.test.mjs: it is the one piece of the
 * active/idle transition that does not depend on a real 2-second timer
 * firing — a test sets `entry.mirror.lastInputAt` to whatever instant it
 * wants and calls this directly, the same way `noteMirrorInput`'s own timer
 * would.
 */
export async function applyMirrorRate(entry: OpenPage): Promise<void> {
  const session = entry.mirror;
  if (!session || !session.running) {
    return;
  }
  // Computed once and carried into startScreencast: this function already
  // needs the value to decide whether a restart is warranted at all, and
  // asking startScreencast to compute it again would read
  // remoteVnc.mirrorFrameRate and Date.now() a second time for one restart —
  // with a real, if narrow, chance the active/idle boundary flips between
  // the two reads and the divisor actually applied does not match the one
  // this comparison was just made against.
  const nth = screencastEveryNthFrame(entry);
  // Compared against what was last ASKED for, not against what Chrome came
  // back and accepted, and the difference is two distinct defects:
  //
  //   * a start still in flight has not written the accepted value yet, so
  //     every input landing inside that window saw the OLD divisor and fired
  //     a duplicate restart of the one already running;
  //   * a restart that REJECTED never writes it at all, so the accepted value
  //     stays stale forever — and since the wanted divisor does not change
  //     while the user keeps typing, this comparison would then be false on
  //     every single input event, restarting the screencast on each one for
  //     as long as the failure lasts.
  //
  // The claim covers both: a divisor already requested is not requested
  // again. A failed request self-heals at the next genuine rate transition
  // (the idle timer 2s after the last keystroke asks for a different one),
  // which is the point at which retrying is worth something.
  if (nth === session.pendingEveryNthFrame) {
    return; // already at (or already asking for) the chosen rate
  }
  await startScreencast(entry, nth);
}

/**
 * Record that the webview forwarded a real input event and put the mirror on
 * the active rate for `ACTIVE_WINDOW_MS` from now — the only caller is the
 * final branch of `handleMirrorMessage`, reached solely for mouse/key/wheel
 * input.
 *
 * Debounced: typing fires this on every keystroke, and only the LAST one
 * should decide when the active window ends, so each call clears whatever
 * idle-transition timer the previous one armed rather than letting two race
 * (the earlier one firing after the later one would drop the rate back to
 * idle mid-sentence).
 */
function noteMirrorInput(entry: OpenPage): void {
  const session = entry.mirror;
  if (!session) {
    return;
  }
  session.lastInputAt = Date.now();
  void applyMirrorRate(entry).catch(logMirrorFailure);
  if (session.rateTimer) {
    clearTimeout(session.rateTimer);
  }
  session.rateTimer = setTimeout(() => {
    session.rateTimer = undefined;
    void applyMirrorRate(entry).catch(logMirrorFailure);
  }, ACTIVE_WINDOW_MS);
}

/**
 * Exported for test/pageMirrorStream.test.mjs: proving a stop actually
 * reaches `Page.stopScreencast` (rather than no-opping on `!session.running`)
 * is the whole point of leaving `running` true after a failed restart — see
 * startScreencast's catch block.
 */
export async function stopScreencast(entry: OpenPage): Promise<void> {
  const session = entry.mirror;
  if (!session || !session.running) {
    return;
  }
  session.running = false;
  session.unacked.length = 0;
  await session.cdp.send('Page.stopScreencast', {}, session.sessionId).catch(logMirrorFailure);
}

/**
 * Close one panel's browser tab and let the browser go if it was the last.
 *
 * Exported for test/pageMirrorStream.test.mjs, which reaches it for the
 * teardown log line below — the one place a session that never recovered
 * writes down how deep its input queue actually got. Its only other caller is
 * `onDidDispose` inside `openPagePanel`, which needs a real `WebviewPanel`
 * and is therefore unreachable from a test, so a deleted log line there would
 * leave the suite green.
 */
export function closeMirror(entry: OpenPage): void {
  const session = entry.mirror;
  entry.mirror = undefined;
  // A pending registry recording call has no session (and, on the disposal
  // path, no webview either) left to answer it.
  rejectPendingPageCaptures(entry, 'the mirror closed');
  if (session) {
    // The teardown line the last investigation had to reconstruct by dumping
    // CdpConnection's pending map. Written only when input was actually
    // forwarded, so a tab that was merely watched stays quiet — which is
    // itself the signal: a watched session's peak is 0, a typed one's is not.
    if (session.peakInFlightInput > 0) {
      logger().info(
        `mirror: closing "${entry.panel.title}" — input depth ${session.inFlightInput} at close, ` +
          `peak ${session.peakInFlightInput}, ${session.droppedMoves} pointer moves dropped`
      );
    }
    // Otherwise a timer armed by the last keystroke before the tab closed
    // fires later, referencing a session that already tore its CDP
    // connection down — harmless (applyMirrorRate re-reads entry.mirror,
    // which is already undefined by then, and no-ops), but pointless work
    // holding a timer handle alive for no reason.
    if (session.rateTimer) {
      clearTimeout(session.rateTimer);
    }
    mirrors.delete(session.sessionId);
    // Close the target, not just our attachment to it: an orphaned tab keeps
    // running the page's timers and holding its memory for as long as the
    // browser lives.
    void session.cdp.send('Target.closeTarget', { targetId: session.targetId }).catch(() => {});
  }
  releaseBrowser();
}

/**
 * Let the shared browser go once nothing is mirrored — after a grace period,
 * because closing a tab and reopening it is an ordinary thing to do and paying
 * Chrome's startup for it twice is worse than holding an idle process for half
 * a minute.
 */
function releaseBrowser(): void {
  if (!browser || browserShutdown || mirroredPanels() > 0) {
    return;
  }
  const pending = browser;
  browserShutdown = setTimeout(() => {
    browserShutdown = undefined;
    if (browser !== pending || mirroredPanels() > 0) {
      return;
    }
    browser = undefined;
    logger().info('mirror: no mirrored pages left — stopping the browser');
    void pending.then(
      (handle) => {
        handle.cdp.dispose();
        handle.kill();
      },
      () => {} // a launch that never succeeded has nothing to kill
    );
  }, BROWSER_GRACE_MS);
}

function mirroredPanels(): number {
  let count = 0;
  for (const entry of openPanels.values()) {
    if (entry.mirrored) {
      count++;
    }
  }
  return count;
}

/**
 * Stop the browser now, for extension deactivation. Chrome is a child of the
 * extension host but not tied to its lifetime — without this, closing the
 * window would leave a headless process resident with nothing to talk to.
 *
 * Returns a promise, and `deactivate` (src/extension.ts) awaits it, because
 * the launch it is killing may still be in flight: a first launch creates a
 * profile and can take seconds, and a `.then(kill)` on an unresolved promise
 * runs after the extension host is gone — which is to say never. The orphan
 * that leaves is a headless Chrome holding a page's memory with nothing left
 * to talk to. VS Code awaits a thenable `deactivate` (under its own timeout),
 * which is what makes this worth awaiting rather than merely tidy.
 */
export async function disposePageMirrors(): Promise<void> {
  if (browserShutdown) {
    clearTimeout(browserShutdown);
    browserShutdown = undefined;
  }
  const pending = browser;
  browser = undefined;
  await pending?.then(
    (handle) => {
      handle.cdp.dispose();
      handle.kill();
    },
    () => {} // a launch that never succeeded has nothing to kill
  );
}

/** Mirror traffic is best-effort: a closed tab or a dead socket rejects mid
 *  flight, and none of it is worth a modal in the user's face. */
function logMirrorFailure(err: unknown): void {
  logger().warn(`mirror: ${String(err)}`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
