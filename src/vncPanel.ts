import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import { createBridge, VncBridge } from './vncBridge';
import { captureFilename, pngBytesFromDataUrl, expandHome } from './screenshot';
import { interactiveSaveCapture } from './interactiveCapture';
import { SessionRegistry, SessionInfo, SessionStatus } from './sessionRegistry';
import { ReconnectPolicy } from './reconnectPolicy';
import { describeBridgeClose } from './closeDiagnostics';
import { brandIconPath } from './brandIcon';
import type { CaptureChord } from './captureChord';
import { logger } from './log';
import { RecordingFormat, RecordingStopReason, recordingBytes, clampFps, recordingFilters } from './recording';
import { registerPanel, unregisterPanel, setFocusedPanel, getFocusedPanel } from './panelRegistry';
import { releasePostUseCommand } from './useCommandRunner';

export interface RfbOptions {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  qualityLevel: number;
  compressionLevel: number;
  showDotCursor: boolean;
}

export interface ConnectionRequest {
  host: string;
  port: number;
  /** Sent alongside the password for security types that ask for one (Apple
   *  ARD/DH, which macOS offers ahead of VNC Auth). Absent for the classic
   *  password-only servers, which ignore it. */
  username?: string;
  password?: string;
  label: string;
  /** Required so every caller resolves the per-connection value against the
   *  `remoteVnc.autoReconnect` default (see doConnect) — an optional field
   *  with a hard fallback here once made legacy entries silently never
   *  reconnect. */
  autoReconnect: boolean;
  /** Advertise only Raw to the server (compatibility with servers whose Tight
   *  output noVNC cannot render, e.g. some embedded appliances). */
  forceRawEncoding?: boolean;
  /** Park the server-drawn pointer in the bottom-right corner when idle —
   *  touch-screen devices paint the arrow into the framebuffer itself, so
   *  moving it aside is the only way to get it out of the picture. Required
   *  (like autoReconnect) so every caller resolves the per-connection value
   *  against the `remoteVnc.parkServerCursor` default in doConnect. */
  parkServerCursor: boolean;
  /** Show only this area of the framebuffer — for servers that advertise a
   *  stride-padded width and render the padding as a dead band. */
  visibleArea?: { width: number; height: number };
  /**
   * A claim on the entry's `postUseCommand` (src/useCommands.ts), already taken
   * by the caller — `connectEntry` in src/extension.ts — BEFORE it ran the
   * `preUseCommand`.
   *
   * Handed over rather than taken here, because a connect has no panel to hang
   * a claim on until the bridge is up, and the stack the pre-use command starts
   * exists from the moment it starts. Every path through this method either
   * adopts the claim (the session's dispose releases it) or releases it on the
   * spot; the caller's own `finally` covers the paths that never reach here,
   * which is how a started stack cannot end up with nobody holding it.
   */
  useToken?: string;
  /** Called once, when the created session has adopted `useToken` and is
   *  therefore the thing that will release it. The caller releases the claim
   *  itself if this never fires. */
  onUseTokenAdopted?: () => void;
}

const VIEW_TYPE = 'remoteVnc.screen';

/** Fixed delay between reconnect attempts. */
const RECONNECT_INTERVAL_MS = 10000;

/** Opens a fresh bridge and resolves the URL the webview should dial. */
export type BridgeConnector = () => Promise<{ bridge: VncBridge; clientUrl: string }>;

interface VncSessionInit {
  request: ConnectionRequest;
  panel: vscode.WebviewPanel;
  connector: BridgeConnector;
  bridge: VncBridge;
  clientUrl: string;
  options: RfbOptions;
  context: vscode.ExtensionContext;
  onStatus: (status: SessionStatus) => void;
  onRecordingChange: () => void;
}

/** Owns the webview panels and their associated TCP↔WS bridges. */
export class VncSessionManager {
  private readonly sessions = new Map<string, VncSession>();
  private active: VncSession | undefined;
  private readonly registry = new SessionRegistry();
  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.registry.onChange(() => this._onDidChangeSessions.fire());
  }

  async connect(request: ConnectionRequest, options: RfbOptions): Promise<void> {
    // Reveal an existing session to the same target instead of duplicating it.
    const existing = this.findByTarget(request.host, request.port);
    if (existing) {
      existing.reveal();
      this.active = existing;
      return;
    }

    logger().info(`connect: ${request.label} -> ${request.host}:${request.port}`);

    // A fixed bridge port is opt-in, for remotes where asExternalUri does not
    // auto-forward (local Dev Containers): the user forwards this one known port.
    const listenPort = getBridgePort();

    // The connector opens a fresh bridge and resolves a webview-reachable URL.
    // The session reuses it for every reconnect attempt. Ephemeral bridge
    // ports are recycled across (re)connects (see vncBridge recycledPorts),
    // so remote windows reuse the same forwarded port instead of leaving one
    // dead Ports-panel row per attempt.
    const connector: BridgeConnector = async () => {
      const bridge = await createBridge({ host: request.host, port: request.port }, { listenPort });
      try {
        const clientUrl = await toWebviewWsUrl(bridge.url, listenPort !== undefined);
        return { bridge, clientUrl };
      } catch (err) {
        bridge.dispose();
        throw err;
      }
    };

    let first: { bridge: VncBridge; clientUrl: string };
    try {
      first = await connector();
    } catch (err) {
      logger().error(`could not open local bridge for ${request.host}:${request.port} — ${describeError(err)}`);
      const hint =
        listenPort && isAddrInUse(err)
          ? ` Port ${listenPort} (remoteVnc.bridgePort) is already in use — only one session is possible with a fixed bridge port; disconnect the other session or change the port.`
          : '';
      void vscode.window.showErrorMessage(
        `Remote VNC: could not open a local bridge — ${describeError(err)}.${hint}`
      );
      return;
    }

    // Tab title is the name the user gave this connection (its label), never
    // the VNC server's self-reported desktop name (see the 'desktopname'
    // handler) — that is the server's identity, not the operator's.
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      request.label,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      }
    );
    // One shared Barto mark on every tab (white on dark themes, purple on light).
    panel.iconPath = brandIconPath(this.context.extensionUri);

    const id = crypto.randomUUID();
    const session = new VncSession({
      request,
      panel,
      connector,
      bridge: first.bridge,
      clientUrl: first.clientUrl,
      options,
      context: this.context,
      onStatus: (status) => this.registry.setStatus(id, status),
      onRecordingChange: () => {
        this.registry.setRecording(id, session.isRecording);
        this.updateRecordingContext();
      },
    });
    this.sessions.set(id, session);
    this.registry.add(id, request.label);
    // A VNC session's pixels are always ours (noVNC paints them into the
    // webview's own canvas) — unlike an unmirrored page tab, so `mirrored`
    // is unconditionally true here. Capture delegates to the session's
    // control-channel methods, which reuse the same save/validate helpers
    // the interactive screenshot/record commands use, just without the
    // dialog and crop-editor branching a script cannot answer.
    registerPanel({
      id,
      name: request.label,
      kind: 'session',
      mirrored: true,
      screenshot: () => session.captureScreenshot(),
      record: () => session.captureStartRecording(),
      recordStop: () => session.captureStopRecording(),
      reload: () => session.reload(),
      isRecording: () => session.isRecording,
    });
    this.active = session;
    // The claim `connectEntry` took before it ran the preUseCommand is adopted
    // HERE, at the first moment there is a tab whose close can release it —
    // by token, so a session closing cannot stop a stack another still-open tab
    // is using. See PostUseTracker (src/useCommands.ts). Every earlier return
    // above leaves the claim unadopted on purpose: the caller's `finally`
    // releases it, which runs the stop command for a stack that was started
    // and then could not be used.
    const useToken = request.useToken;
    request.onUseTokenAdopted?.();
    // A freshly opened tab is the active one before any onDidChangeViewState
    // fires (that event only reports subsequent changes) — the hotkey chords
    // must resolve to it immediately, not just after the user alt-tabs away
    // and back.
    setFocusedPanel(id);
    void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', true);
    this.updateRecordingContext();

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.active = session;
        setFocusedPanel(id);
        void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', true);
      } else if (getFocusedPanel()?.id === id) {
        // Only the panel that is actually focused may clear the key — a
        // background tab going inactive must not blow away the context a
        // different, now-focused tab just set.
        setFocusedPanel(undefined);
        void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', false);
      }
      this.updateRecordingContext();
    });
    panel.onDidDispose(() => {
      this.sessions.delete(id);
      this.registry.remove(id);
      const wasFocused = getFocusedPanel()?.id === id;
      unregisterPanel(id);
      // Closing a tab does not fire onDidChangeViewState first, so the
      // context key needs its own clear here — otherwise a stale "true"
      // would hijack the chords in whatever the user looks at next.
      if (wasFocused) {
        void vscode.commands.executeCommand('setContext', 'remoteVnc.panelFocused', false);
      }
      if (this.active === session) {
        this.active = this.sessions.values().next().value;
      }
      this.updateRecordingContext();
      if (useToken) {
        releasePostUseCommand(useToken);
      }
    });
  }

  /**
   * Whether a session for this target is already open.
   *
   * `connect` already reveals rather than duplicates one, but the pre-use
   * command runs BEFORE connect is called — it has to, since it is what makes
   * the target answer — so the caller needs to ask this first. Without it,
   * clicking an already-open connection would re-run its start command.
   */
  hasSessionFor(host: string, port: number): boolean {
    return this.findByTarget(host, port) !== undefined;
  }

  /** Sessions currently open, for the Active Sessions tree view. */
  getSessions(): SessionInfo[] {
    return this.registry.list();
  }

  /** Bring a session's panel to the foreground. */
  reveal(id: string): void {
    this.sessions.get(id)?.reveal();
  }

  /** Tear down a specific session. */
  disconnect(id: string): void {
    void this.sessions.get(id)?.disposeGracefully();
  }

  disconnectActive(): void {
    if (!this.active) {
      void vscode.window.showInformationMessage('Remote VNC: no active session.');
      return;
    }
    void this.active.disposeGracefully();
  }

  /** Screenshot the focused session (palette entry and the panel button). */
  screenshotActive(): void {
    if (!this.active) {
      void vscode.window.showInformationMessage('Remote VNC: no active session to screenshot.');
      return;
    }
    this.active.takeScreenshot();
  }

  /** Start recording the focused session (palette and the panel button). */
  recordActive(): void {
    if (!this.active) {
      void vscode.window.showInformationMessage('Remote VNC: no active session to record.');
      return;
    }
    this.active.startRecording();
  }

  /** Stop the focused session's recording. */
  stopRecordingActive(): void {
    if (!this.active || !this.active.isRecording) {
      void vscode.window.showInformationMessage('Remote VNC: no recording in progress.');
      return;
    }
    this.active.stopRecording();
  }

  /** Screenshot a specific session (Active Sessions tree button). */
  screenshotSession(id: string): void {
    this.sessions.get(id)?.takeScreenshot();
  }

  /** Screenshot the live session for a target, if one exists (connection row). */
  screenshotTarget(host: string, port: number): boolean {
    const session = this.findByTarget(host, port);
    session?.takeScreenshot();
    return session !== undefined;
  }

  /** Start recording a specific session (Active Sessions tree button). */
  recordSession(id: string): void {
    this.sessions.get(id)?.startRecording();
  }

  /** Stop a specific session's recording (Active Sessions tree button). */
  stopRecordingSession(id: string): void {
    this.sessions.get(id)?.stopRecording();
  }

  /**
   * Toggle recording for the live session of a target, if one exists
   * (connection-row button — one button, camera-style target semantics).
   */
  toggleRecordTarget(host: string, port: number): boolean {
    const session = this.findByTarget(host, port);
    if (!session) {
      return false;
    }
    if (session.isRecording) {
      session.stopRecording();
    } else {
      session.startRecording();
    }
    return true;
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      session.dispose();
    }
    this._onDidChangeSessions.dispose();
  }

  private findByTarget(host: string, port: number): VncSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.matches(host, port)) {
        return s;
      }
    }
    return undefined;
  }

  /** Mirror the focused session's recording state into the when-clause key. */
  private updateRecordingContext(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'remoteVnc.recordingActive',
      this.active?.isRecording ?? false
    );
  }
}

/** A single VNC viewer panel with optional auto-reconnect. Exported (only)
 *  so its registry-facing capture/reload methods are directly unit-testable
 *  without going through VncSessionManager.connect(), which needs a live
 *  TCP bridge. */
export class VncSession {
  private readonly disposables: vscode.Disposable[] = [];
  private pendingConnect: ExtensionMessage | undefined;
  private disposed = false;
  /** Set once a specific bridge-side reason has been surfaced, so the webview's
   *  generic "closed unexpectedly" toast for the same failure is suppressed. */
  private bridgeReasonShown = false;
  private readonly host: string;
  private readonly port: number;
  private readonly label: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly autoReconnect: boolean;
  private readonly forceRaw: boolean;
  private readonly parkServerCursor: boolean;
  private readonly visibleArea?: { width: number; height: number };
  private readonly options: RfbOptions;
  private readonly extensionUri: vscode.Uri;
  private readonly panel: vscode.WebviewPanel;
  private readonly connector: BridgeConnector;
  private readonly onStatus: (status: SessionStatus) => void;
  private readonly policy = new ReconnectPolicy(RECONNECT_INTERVAL_MS);
  private bridge: VncBridge;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private authFailed = false;
  /** The RFB handshake completed on the current bridge (webview said connected). */
  private sawConnected = false;
  /** When the current bridge reached connected, for durations in close logs. */
  private connectedAt: number | undefined;
  /** The "force raw encoding" hint has been logged once for this session. */
  private rawHintShown = false;
  private recording: 'idle' | 'starting' | 'recording' = 'idle';
  /** Resolvers waiting for the in-flight recording to flush (graceful close). */
  private recordingWaiters: Array<() => void> = [];
  /**
   * Waiters for the panel registry's non-interactive capture calls (control
   * server, hotkey dispatcher) — one small queue per in-flight request kind.
   * These bypass the interactive save-dialog/crop-editor branching in
   * `onMessage`: a script awaiting a promise has no one to answer a dialog.
   */
  private screenshotWaiters: Array<{ resolve: (path: string) => void; reject: (err: Error) => void }> = [];
  private recordStartWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private recordStopWaiters: Array<{ resolve: (path: string) => void; reject: (err: Error) => void }> = [];
  private readonly onRecordingChange: () => void;
  private readonly globalStorageUri: vscode.Uri;

  constructor(init: VncSessionInit) {
    this.host = init.request.host;
    this.port = init.request.port;
    this.label = init.request.label;
    this.username = init.request.username;
    this.password = init.request.password;
    this.autoReconnect = init.request.autoReconnect;
    this.forceRaw = init.request.forceRawEncoding ?? false;
    this.parkServerCursor = init.request.parkServerCursor;
    this.visibleArea = init.request.visibleArea;
    this.options = init.options;
    this.extensionUri = init.context.extensionUri;
    this.panel = init.panel;
    this.connector = init.connector;
    this.onStatus = init.onStatus;
    this.onRecordingChange = init.onRecordingChange;
    this.globalStorageUri = init.context.globalStorageUri;
    this.bridge = init.bridge;

    this.panel.webview.html = renderHtml(this.panel.webview, this.extensionUri, init.clientUrl);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg))
    );
    this.wireBridge(this.bridge);
    this.panel.onDidDispose(() => this.dispose());

    // The connection is sent only after the webview signals it is ready —
    // messages posted before the script's listener is attached can be dropped.
    this.pendingConnect = {
      type: 'connect',
      url: init.clientUrl,
      username: this.username,
      password: this.password,
      options: this.options,
      forceRaw: this.forceRaw,
      parkCursor: this.parkServerCursor,
      crop: this.visibleArea,
    };
  }

  private wireBridge(bridge: VncBridge): void {
    bridge.onClosed((reason) => this.onBridgeClosed(reason));
  }

  /**
   * The bridge closed on its own (server died / network dropped) — a
   * user-initiated teardown goes through dispose()→finalize(), which never
   * fires onClosed, so reaching here means the connection dropped unexpectedly.
   */
  private onBridgeClosed(reason?: string): void {
    if (this.disposed) {
      return;
    }
    const decision = this.policy.onBridgeClosed({
      autoReconnect: this.autoReconnect,
      disposed: this.disposed,
      authFailed: this.authFailed,
    });
    // What to log depends on how far this bridge got: a close before the RFB
    // handshake ever completed, or a clean server-side drop of a session that
    // did connect (the blank-screen signature "force raw encoding" fixes),
    // are called out explicitly — see closeDiagnostics.
    const diag = describeBridgeClose({
      label: this.label,
      target: `${this.host}:${this.port}`,
      reason,
      sawConnected: this.sawConnected,
      connectedMs: this.connectedAt === undefined ? undefined : Date.now() - this.connectedAt,
      forceRaw: this.forceRaw,
      willReconnect: decision.action === 'reconnect',
      reconnectSeconds: RECONNECT_INTERVAL_MS / 1000,
      rawHintShown: this.rawHintShown,
    });
    logger()[diag.level](diag.message);
    if (diag.hint) {
      logger().info(diag.hint);
    }
    this.rawHintShown = diag.rawHintShown;
    if (decision.action === 'reconnect') {
      this.scheduleReconnect(decision.delayMs);
      return;
    }
    // Stop: surface the drop the same way a non-reconnecting session does.
    void this.post({ type: 'disconnect' });
    if (reason) {
      this.bridgeReasonShown = true;
      void vscode.window.showWarningMessage(`Remote VNC (${this.label}): ${reason}`);
    }
  }

  private scheduleReconnect(delayMs: number): void {
    this.onStatus('reconnecting');
    void this.post({ type: 'reconnecting' });
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => void this.attemptReconnect(), delayMs);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let established: { bridge: VncBridge; clientUrl: string };
    try {
      established = await this.connector();
    } catch (err) {
      logger().warn(`reconnect: could not open bridge (${this.label}) — ${describeError(err)}; retrying in ${RECONNECT_INTERVAL_MS / 1000}s`);
      this.scheduleReconnect(RECONNECT_INTERVAL_MS);
      return;
    }
    if (this.disposed) {
      established.bridge.dispose();
      return;
    }
    // Swap in the fresh bridge and re-render so the CSP matches its origin.
    try {
      this.bridge.dispose();
    } catch {
      /* ignore */
    }
    this.bridge = established.bridge;
    this.wireBridge(this.bridge);
    this.bridgeReasonShown = false;
    // A fresh bridge means a fresh handshake; connection state starts over.
    this.sawConnected = false;
    this.connectedAt = undefined;
    this.pendingConnect = {
      type: 'connect',
      url: established.clientUrl,
      username: this.username,
      password: this.password,
      options: this.options,
      forceRaw: this.forceRaw,
      parkCursor: this.parkServerCursor,
      crop: this.visibleArea,
    };
    this.panel.webview.html = renderHtml(this.panel.webview, this.extensionUri, established.clientUrl);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private onMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'chord':
        // The chord never reached VS Code's dispatcher — noVNC swallows keys
        // to forward them to the remote machine — so the webview forwards the
        // intent instead. Run the same commands the keybindings would, which
        // keeps one code path for both routes.
        void vscode.commands.executeCommand(
          msg.action === 'screenshot'
            ? 'remoteVnc.screenshotFocused'
            : 'remoteVnc.recordFocusedToggle'
        );
        break;
      case 'ready':
        if (this.pendingConnect) {
          void this.post(this.pendingConnect);
          this.pendingConnect = undefined;
        }
        break;
      case 'status':
        if (msg.state === 'connected') {
          // The one place the extension host learns the RFB handshake
          // completed — logged so the Output channel shows how far a session
          // got, not just that it eventually closed.
          if (!this.sawConnected) {
            this.sawConnected = true;
            this.connectedAt = Date.now();
            // The framebuffer size is the advertised one — when it is wider
            // than the device's visible panel (embedded servers often pad the
            // width to their line stride), the viewer shows a dead band the
            // device's own screen does not have.
            const size = msg.width && msg.height ? `, framebuffer ${msg.width}x${msg.height}` : '';
            logger().info(`connected (${this.label}, ${this.host}:${this.port}${size}).`);
          }
          this.onStatus('connected');
        } else if (msg.state === 'disconnected' && msg.clean === false && !this.bridgeReasonShown && !this.autoReconnect) {
          logger().error(`webview reported an unclean disconnect (target ${this.host}:${this.port}).`);
          logger().show(true);
          void vscode.window.showWarningMessage(
            'Remote VNC: connection closed unexpectedly. See the "Remote VNC" output for details.'
          );
        }
        break;
      case 'desktopname':
        // Intentionally ignored: the tab keeps the connection's user-given
        // label, not the server's self-reported desktop name.
        break;
      case 'securityfailure':
        // Auth/security failure: a retry cannot fix it, so stop reconnecting.
        this.authFailed = true;
        this.clearReconnectTimer();
        this.onStatus('connected');
        logger().error(`security failure${msg.reason ? ` — ${msg.reason}` : ''} (target ${this.host}:${this.port}).`);
        void vscode.window.showErrorMessage(
          `Remote VNC: authentication/security failure${msg.reason ? ` — ${msg.reason}` : ''}.${
            // A server that wants a username while the connection has none is
            // the one case the user cannot act on from the message alone: the
            // prompt only ever asks for a password, so it reads as a rejected
            // password no matter how many times it is retyped.
            msg.needs?.includes('username') && !this.username
              ? ' This server also wants an account name — set "username" on the saved connection (macOS targets negotiate Apple ARD, which requires one).'
              : ''
          }`
        );
        break;
      case 'log':
        if (msg.level === 'error') {
          logger().error(`webview: ${msg.message}`);
        } else {
          logger().info(`webview: ${msg.message}`);
        }
        break;
      case 'screenshot': {
        // A pending control-channel/hotkey request takes the response
        // instead of the interactive dialog/crop-editor path below — there
        // is no one to answer a save dialog on a script's behalf.
        const waiter = this.screenshotWaiters.shift();
        if (waiter) {
          if (msg.error || !msg.dataUrl) {
            waiter.reject(new Error(msg.error ?? 'no image data'));
          } else {
            this.saveScreenshotDirect(msg.dataUrl).then(waiter.resolve, waiter.reject);
          }
        } else if (msg.error || !msg.dataUrl) {
          void vscode.window.showWarningMessage(
            `Remote VNC (${this.label}): could not capture a screenshot — ${msg.error ?? 'no image data'}.`
          );
        } else {
          void this.saveScreenshot(msg.dataUrl);
        }
        break;
      }
      case 'record-status': {
        if (msg.error) {
          logger().error(`recording (${this.label}): ${msg.error}`);
          void vscode.window.showWarningMessage(
            `Remote VNC (${this.label}): could not record — ${msg.error}.`
          );
        }
        this.recording = msg.recording ? 'recording' : 'idle';
        if (this.recording === 'idle') {
          this.flushRecordingWaiters();
        }
        // This is the ack for a captureStartRecording() call, if one is
        // pending — recording === true means it took.
        const startWaiters = this.recordStartWaiters.splice(0);
        for (const w of startWaiters) {
          if (msg.recording) {
            w.resolve();
          } else {
            w.reject(new Error(msg.error ?? 'could not start recording'));
          }
        }
        this.onRecordingChange();
        break;
      }
      case 'recording': {
        this.recording = 'idle';
        this.onRecordingChange();
        this.flushRecordingWaiters();
        const stopWaiters = this.recordStopWaiters.splice(0);
        if (stopWaiters.length > 0) {
          this.saveRecordingDirect(msg).then(
            (path) => {
              for (const w of stopWaiters) {
                w.resolve(path);
              }
            },
            (err: Error) => {
              for (const w of stopWaiters) {
                w.reject(err);
              }
            }
          );
        } else {
          void this.handleRecording(msg);
        }
        break;
      }
    }
  }

  /** Ask the webview for the current framebuffer as a PNG. */
  takeScreenshot(): void {
    void this.post({ type: 'screenshot' });
  }

  get isRecording(): boolean {
    return this.recording !== 'idle';
  }

  /** Ask the webview to start recording; settings pick format and rate. */
  startRecording(): void {
    if (this.recording !== 'idle') {
      void vscode.window.showInformationMessage(`Remote VNC (${this.label}): already recording.`);
      return;
    }
    const config = vscode.workspace.getConfiguration('remoteVnc');
    const format: RecordingFormat =
      config.get<string>('recordingFormat', 'webm') === 'gif' ? 'gif' : 'webm';
    const fps = clampFps(config.get<number>('recordingFrameRate', 10));
    this.recording = 'starting';
    this.onRecordingChange();
    void this.post({ type: 'record-start', format, fps });
  }

  stopRecording(): void {
    if (this.recording === 'idle') {
      void vscode.window.showInformationMessage(`Remote VNC (${this.label}): no recording in progress.`);
      return;
    }
    void this.post({ type: 'record-stop' });
  }

  /**
   * Screenshot for the panel registry (control server / focused hotkey):
   * unlike `takeScreenshot`, this resolves with the saved path and skips the
   * crop editor and the open/save choice — a caller here is a script or a
   * key chord, not someone present to answer a dialog. Shares the webview
   * round trip with `takeScreenshot`; `onMessage`'s 'screenshot' case
   * routes the response to whichever waiter (if any) is queued.
   */
  captureScreenshot(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.screenshotWaiters.push({ resolve, reject });
      void this.post({ type: 'screenshot' });
    });
  }

  /** Registry-driven recording start: resolves once the webview confirms
   *  recording actually began (or rejects with its reported error). */
  captureStartRecording(): Promise<void> {
    if (this.recording !== 'idle') {
      return Promise.reject(new Error('already recording'));
    }
    const config = vscode.workspace.getConfiguration('remoteVnc');
    const format: RecordingFormat =
      config.get<string>('recordingFormat', 'webm') === 'gif' ? 'gif' : 'webm';
    const fps = clampFps(config.get<number>('recordingFrameRate', 10));
    return new Promise((resolve, reject) => {
      this.recordStartWaiters.push({ resolve, reject });
      this.recording = 'starting';
      this.onRecordingChange();
      void this.post({ type: 'record-start', format, fps });
    });
  }

  /** Registry-driven recording stop: resolves with the saved file's path. */
  captureStopRecording(): Promise<string> {
    if (this.recording === 'idle') {
      return Promise.reject(new Error('no recording in progress'));
    }
    return new Promise((resolve, reject) => {
      this.recordStopWaiters.push({ resolve, reject });
      void this.post({ type: 'record-stop' });
    });
  }

  /**
   * Registry-driven "reload": always rejects. "Reload" is a page-target
   * concept (re-render an iframe) — a session is a live, possibly-unattended
   * connection, so reinterpreting "reload" as "drop and re-establish it"
   * would let an unauthenticated-looking HTTP call force a destructive
   * reconnect on a session the caller may not even be watching. Rejecting is
   * a deliberate decision, not a placeholder.
   */
  reload(): Promise<void> {
    return Promise.reject(new Error('reload applies to page targets only'));
  }

  /**
   * Disconnect on the user's behalf: an in-flight recording is stopped and
   * given a moment to deliver its bytes before the webview is destroyed.
   * (Closing the tab skips this — the webview dies instantly; documented.)
   */
  async disposeGracefully(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.recording !== 'idle') {
      void this.post({ type: 'record-stop' });
      await Promise.race([
        new Promise<void>((resolve) => this.recordingWaiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    this.dispose();
  }

  /**
   * Save a captured PNG, per `remoteVnc.screenshotAction`: silently into
   * `remoteVnc.screenshotDirectory` (or a save dialog) by default, or opened
   * as an unsaved tab. Either way `save` paths are on the machine the
   * extension host runs on — under a remote (WSL, SSH, containers) that is
   * the remote filesystem.
   */
  private async saveScreenshot(dataUrl: string): Promise<void> {
    const bytes = pngBytesFromDataUrl(dataUrl);
    if (!bytes) {
      void vscode.window.showWarningMessage(
        `Remote VNC (${this.label}): the webview returned no usable PNG data.`
      );
      return;
    }
    const name = captureFilename(this.label, new Date(), 'png');
    await interactiveSaveCapture(
      this.globalStorageUri,
      this.label,
      bytes,
      name,
      { 'PNG image': ['png'] },
      'screenshot'
    );
  }

  /**
   * The registry's screenshot path: writes straight to
   * `remoteVnc.screenshotDirectory` when set, or under this window's own
   * extension storage otherwise — **never** a save dialog, and never the
   * crop editor or "open" branch. `remoteVnc.screenshotAction`/
   * `screenshotCropEditor` govern only the interactive command. This is the
   * path a later task calls from an HTTP handler: a dialog on a window the
   * caller cannot see would hang that request forever with no one able to
   * dismiss it, so unlike the interactive `saveCapture`, this never falls
   * back to `showSaveDialog`.
   */
  private async saveScreenshotDirect(dataUrl: string): Promise<string> {
    const bytes = pngBytesFromDataUrl(dataUrl);
    if (!bytes) {
      throw new Error('the webview returned no usable PNG data');
    }
    const name = captureFilename(this.label, new Date(), 'png');
    return this.saveCaptureDirect(bytes, name, 'screenshot');
  }

  /**
   * The no-dialog counterpart of `saveCapture`, for the registry's
   * screenshot/recordStop only — see `saveScreenshotDirect`. Honours
   * `remoteVnc.screenshotDirectory` when set (same expansion as the
   * interactive path); otherwise writes under
   * `<globalStorage>/captures`, a destination that always exists and needs
   * no one to answer a prompt.
   */
  private async saveCaptureDirect(
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
      : vscode.Uri.joinPath(this.globalStorageUri, 'captures');
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, name);
    await vscode.workspace.fs.writeFile(uri, bytes);
    logger().info(`${kind} saved (${this.label}, registry) -> ${uri.fsPath}`);
    return uri.fsPath;
  }

  private flushRecordingWaiters(): void {
    for (const resolve of this.recordingWaiters.splice(0)) {
      resolve();
    }
  }

  /** Validate, then save or open a finished recording, per settings. */
  private async handleRecording(msg: Extract<WebviewMessage, { type: 'recording' }>): Promise<void> {
    // msg.format crosses the webview boundary untrusted — the TS type is
    // only a compile-time hint, not a runtime guarantee. Re-normalise it
    // the same way startRecording does, so an untrusted message can never
    // name the file we silently write to disk.
    const format: RecordingFormat = msg.format === 'gif' ? 'gif' : 'webm';
    const bytes = recordingBytes(format, msg.data);
    if (!bytes) {
      void vscode.window.showWarningMessage(
        `Remote VNC (${this.label}): the webview returned no usable ${format} data.`
      );
      return;
    }
    const note =
      msg.reason === 'maxDuration'
        ? ' (stopped at the 10-minute limit)'
        : msg.reason === 'disconnected'
          ? ' (session dropped)'
          : '';
    logger().info(
      `recording finished (${this.label}) — ${format}, ${Math.round(msg.durationMs / 1000)}s, reason ${msg.reason}`
    );
    const name = captureFilename(this.label, new Date(), format);
    await interactiveSaveCapture(
      this.globalStorageUri,
      this.label,
      bytes,
      name,
      recordingFilters(format),
      'recording',
      note
    );
  }

  /** The registry's record-stop path: the mirror of `saveScreenshotDirect`
   *  for a finished recording — validate, then save with `saveCaptureDirect`
   *  (never a dialog) and resolve with the path. `remoteVnc.recordingAction`
   *  governs only the interactive command. */
  private async saveRecordingDirect(msg: Extract<WebviewMessage, { type: 'recording' }>): Promise<string> {
    const format: RecordingFormat = msg.format === 'gif' ? 'gif' : 'webm';
    const bytes = recordingBytes(format, msg.data);
    if (!bytes) {
      throw new Error(`the webview returned no usable ${format} data`);
    }
    const name = captureFilename(this.label, new Date(), format);
    return this.saveCaptureDirect(bytes, name, 'recording');
  }

  private post(message: ExtensionMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal();
  }

  matches(host: string, port: number): boolean {
    return this.host === host && this.port === port;
  }

  dispose(): void {
    // panel.dispose() re-fires onDidDispose synchronously, which calls us again.
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearReconnectTimer();
    this.flushRecordingWaiters();
    this.rejectPendingCaptures();
    this.bridge.dispose();
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this.panel.dispose();
  }

  /** A session closing must not leave a registry caller's promise pending
   *  forever — the webview that would have answered it is gone. */
  private rejectPendingCaptures(): void {
    const err = new Error('session closed');
    for (const w of this.screenshotWaiters.splice(0)) {
      w.reject(err);
    }
    for (const w of this.recordStartWaiters.splice(0)) {
      w.reject(err);
    }
    for (const w of this.recordStopWaiters.splice(0)) {
      w.reject(err);
    }
  }
}

type ExtensionMessage =
  | {
      type: 'connect';
      url: string;
      username?: string;
      password?: string;
      options: RfbOptions;
      forceRaw?: boolean;
      parkCursor?: boolean;
      crop?: { width: number; height: number };
    }
  | { type: 'disconnect' }
  | { type: 'reconnecting' }
  | { type: 'screenshot' }
  | { type: 'record-start'; format: RecordingFormat; fps: number }
  | { type: 'record-stop' };

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'status'; state: 'connecting' | 'connected' | 'disconnected'; clean?: boolean; width?: number; height?: number }
  | { type: 'desktopname'; name: string }
  | { type: 'securityfailure'; reason?: string; needs?: string[] }
  | { type: 'log'; level: 'info' | 'error'; message: string }
  | { type: 'screenshot'; dataUrl?: string; error?: string }
  | { type: 'record-status'; recording: boolean; error?: string }
  | { type: 'chord'; action: CaptureChord }
  | {
      type: 'recording';
      format: RecordingFormat;
      data: Uint8Array | ArrayBuffer;
      durationMs: number;
      reason: RecordingStopReason;
    };

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bridgeUrl: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'style.css')
  );

  // Lock connect-src down to the exact loopback origin of this session's bridge.
  const bridgeOrigin = originOf(bridgeUrl) ?? 'ws://127.0.0.1:*';
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${bridgeOrigin}`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Remote VNC</title>
</head>
<body>
  <div id="status" class="status">Connecting…</div>
  <div id="rec" class="rec" hidden>● REC</div>
  <div id="screen" class="screen"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAddrInUse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EADDRINUSE';
}

/** Authorities already noted as unchanged-by-asExternalUri (once per session). */
const unchangedAuthorityNoted = new Set<string>();

/** The configured fixed bridge port, or undefined for an ephemeral port. */
function getBridgePort(): number | undefined {
  const port = vscode.workspace.getConfiguration('remoteVnc').get<number>('bridgePort', 0);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Resolve the bridge's loopback WebSocket URL to one the webview can reach.
 *
 * `asExternalUri` tunnels a remote loopback port out to the client when VS Code
 * is attached to a remote (Remote-SSH, WSL, Codespaces) and is a no-op for a
 * local window. It is designed for http(s), so the ws(s) URL is mapped to
 * http(s) on the way in and the resolved scheme mapped back on the way out (a
 * forwarded local port stays ws://; a TLS tunnel becomes wss://).
 *
 * Two sharp edges are handled explicitly:
 *  - The single-use token lives in the query string and must survive verbatim.
 *    `vscode.Uri.toString()` percent-encodes the query, turning `token=abc` into
 *    `token%3Dabc`, which the bridge then rejects — so the original query is
 *    carried across by hand and never round-tripped through `vscode.Uri`.
 *  - In a *local Dev Container*, `asExternalUri` does NOT auto-forward and
 *    returns the loopback authority unchanged; the locally-rendered webview then
 *    cannot reach it. That case is detected and surfaced (see `bridgePort`).
 */
export async function toWebviewWsUrl(
  loopbackWsUrl: string,
  fixedPortForwarded = false
): Promise<string> {
  const remote = vscode.env.remoteName;
  try {
    const ws = vscode.Uri.parse(loopbackWsUrl);
    const httpScheme = ws.scheme === 'wss' ? 'https' : 'http';
    // Strip the query going in: asExternalUri forwards by authority, and the
    // token must not pass through vscode.Uri's query encoder (see above).
    const external = await vscode.env.asExternalUri(ws.with({ scheme: httpScheme, query: '' }));
    const wsScheme = external.scheme === 'https' ? 'wss' : 'ws';
    const qIndex = loopbackWsUrl.indexOf('?');
    const rawQuery = qIndex >= 0 ? loopbackWsUrl.slice(qIndex) : '';
    const path = external.path && external.path !== '/' ? external.path : '/';
    const resolved = `${wsScheme}://${external.authority}${path}${rawQuery}`;
    logger().info(
      `tunnel: remote=${remote ?? 'local'} loopback=${redactToken(loopbackWsUrl)} -> external=${redactToken(resolved)}`
    );
    // In a remote window an unchanged loopback authority is AMBIGUOUS: local
    // Dev Containers register a same-port client-side forward (verified: the
    // webview connects fine), while other remotes may genuinely leave the
    // bridge unreachable. So this is a log-only note, emitted ONCE per
    // authority — with autoReconnect it used to re-warn and force the Output
    // panel open every 10s, stealing focus in a perfectly working setup.
    if (remote && external.authority === ws.authority) {
      if (fixedPortForwarded) {
        logger().info(
          `tunnel: authority unchanged (${ws.authority}); relying on the statically forwarded ` +
            'bridge port (remoteVnc.bridgePort). Ensure that port is forwarded to this machine.'
        );
      } else if (!unchangedAuthorityNoted.has(ws.authority)) {
        unchangedAuthorityNoted.add(ws.authority);
        logger().warn(
          `tunnel: asExternalUri left ${ws.authority} unchanged in a remote window (${remote}). ` +
            'Local Dev Containers and WSL usually forward the port automatically under the same ' +
            'address, so if the viewer connects this is fine. If it cannot connect, set ' +
            '"remoteVnc.bridgePort" to a fixed port and forward it (forwardPorts in ' +
            'devcontainer.json, or the Ports panel). See README → "Running on a remote".'
        );
      }
    }
    return resolved;
  } catch (err) {
    // If forwarding is unavailable, fall back to the raw URL — correct for a
    // local window, but for a remote window this loopback URL is unreachable
    // from the webview, so make the failure loud instead of silently degrading.
    logger().error(
      `tunnel: asExternalUri failed (remote=${vscode.env.remoteName ?? 'local'}), ` +
        `falling back to loopback ${redactToken(loopbackWsUrl)} — ${describeError(err)}`
    );
    return loopbackWsUrl;
  }
}

/** Strip the single-use bridge token from a URL before logging it. */
function redactToken(url: string): string {
  return url.replace(/token=[^&]+/, 'token=…');
}

/** Return the `scheme://host:port` origin of a ws URL, or undefined if unparsable. */
function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}
