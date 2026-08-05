import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import { createBridge, VncBridge } from './vncBridge';
import { screenshotFilename, captureFilename, pngBytesFromDataUrl, expandHome } from './screenshot';
import { SessionRegistry, SessionInfo, SessionStatus } from './sessionRegistry';
import { ReconnectPolicy } from './reconnectPolicy';
import { describeBridgeClose } from './closeDiagnostics';
import { brandIconPath } from './brandIcon';
import { logger } from './log';
import { RecordingFormat, RecordingStopReason, recordingBytes, clampFps } from './recording';

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
      onRecordingChange: () => this.updateRecordingContext(),
    });
    this.sessions.set(id, session);
    this.registry.add(id, request.label);
    this.active = session;
    this.updateRecordingContext();

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.active = session;
      }
      this.updateRecordingContext();
    });
    panel.onDidDispose(() => {
      this.sessions.delete(id);
      this.registry.remove(id);
      if (this.active === session) {
        this.active = this.sessions.values().next().value;
      }
      this.updateRecordingContext();
    });
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

/** A single VNC viewer panel with optional auto-reconnect. */
class VncSession {
  private readonly disposables: vscode.Disposable[] = [];
  private pendingConnect: ExtensionMessage | undefined;
  private disposed = false;
  /** Set once a specific bridge-side reason has been surfaced, so the webview's
   *  generic "closed unexpectedly" toast for the same failure is suppressed. */
  private bridgeReasonShown = false;
  private readonly host: string;
  private readonly port: number;
  private readonly label: string;
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
  private readonly onRecordingChange: () => void;
  private readonly globalStorageUri: vscode.Uri;

  constructor(init: VncSessionInit) {
    this.host = init.request.host;
    this.port = init.request.port;
    this.label = init.request.label;
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
          `Remote VNC: authentication/security failure${msg.reason ? ` — ${msg.reason}` : ''}.`
        );
        break;
      case 'log':
        if (msg.level === 'error') {
          logger().error(`webview: ${msg.message}`);
        } else {
          logger().info(`webview: ${msg.message}`);
        }
        break;
      case 'screenshot':
        if (msg.error || !msg.dataUrl) {
          void vscode.window.showWarningMessage(
            `Remote VNC (${this.label}): could not capture a screenshot — ${msg.error ?? 'no image data'}.`
          );
        } else {
          void this.saveScreenshot(msg.dataUrl);
        }
        break;
      case 'record-status':
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
        this.onRecordingChange();
        break;
      case 'recording':
        this.recording = 'idle';
        this.onRecordingChange();
        this.flushRecordingWaiters();
        void this.handleRecording(msg);
        break;
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
   * Save a captured PNG. With `remoteVnc.screenshotDirectory` set the file is
   * written there silently (one click, no dialog); otherwise a save dialog
   * asks. Either way the paths are on the machine the extension host runs on —
   * under a remote (WSL, SSH, containers) that is the remote filesystem.
   */
  private async saveScreenshot(dataUrl: string): Promise<void> {
    const bytes = pngBytesFromDataUrl(dataUrl);
    if (!bytes) {
      void vscode.window.showWarningMessage(
        `Remote VNC (${this.label}): the webview returned no usable PNG data.`
      );
      return;
    }
    const name = screenshotFilename(this.label, new Date());
    const configured = vscode.workspace
      .getConfiguration('remoteVnc')
      .get<string>('screenshotDirectory', '')
      .trim();

    let uri: vscode.Uri | undefined;
    if (configured) {
      const dir = vscode.Uri.file(expandHome(configured, os.homedir()));
      try {
        await vscode.workspace.fs.createDirectory(dir);
        uri = vscode.Uri.joinPath(dir, name);
      } catch (err) {
        // An unusable directory should not eat the screenshot — fall back to
        // asking, with the reason on record.
        logger().warn(
          `screenshot: cannot use remoteVnc.screenshotDirectory "${configured}" — ${describeError(err)}; asking instead`
        );
      }
    }
    if (!uri) {
      uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${os.homedir()}/${name}`),
        filters: { 'PNG image': ['png'] },
      });
      if (!uri) {
        return; // cancelled
      }
    }

    try {
      await vscode.workspace.fs.writeFile(uri, bytes);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Remote VNC (${this.label}): could not save the screenshot — ${describeError(err)}.`
      );
      return;
    }
    logger().info(`screenshot saved (${this.label}) -> ${uri.fsPath}`);
    const choice = await vscode.window.showInformationMessage(
      `Remote VNC: screenshot saved — ${name}`,
      'Open'
    );
    if (choice === 'Open') {
      void vscode.commands.executeCommand('vscode.open', uri);
    }
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
    const action = vscode.workspace
      .getConfiguration('remoteVnc')
      .get<string>('recordingAction', 'save');
    if (action === 'open') {
      await this.openRecording(bytes, name, format, note);
    } else {
      await this.saveRecording(bytes, name, format, note);
    }
  }

  /** The screenshot save path, for a recording (directory → silent; else ask). */
  private async saveRecording(
    bytes: Uint8Array,
    name: string,
    format: RecordingFormat,
    note: string
  ): Promise<void> {
    const configured = vscode.workspace
      .getConfiguration('remoteVnc')
      .get<string>('screenshotDirectory', '')
      .trim();
    let uri: vscode.Uri | undefined;
    if (configured) {
      const dir = vscode.Uri.file(expandHome(configured, os.homedir()));
      try {
        await vscode.workspace.fs.createDirectory(dir);
        uri = vscode.Uri.joinPath(dir, name);
      } catch (err) {
        logger().warn(
          `recording: cannot use remoteVnc.screenshotDirectory "${configured}" — ${describeError(err)}; asking instead`
        );
      }
    }
    if (!uri) {
      uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${os.homedir()}/${name}`),
        filters: recordingFilters(format),
      });
      if (!uri) {
        return; // cancelled
      }
    }
    try {
      await vscode.workspace.fs.writeFile(uri, bytes);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Remote VNC (${this.label}): could not save the recording — ${describeError(err)}.`
      );
      return;
    }
    logger().info(`recording saved (${this.label}) -> ${uri.fsPath}`);
    const choice = await vscode.window.showInformationMessage(
      `Remote VNC: recording saved${note} — ${name}`,
      'Open'
    );
    if (choice === 'Open') {
      void vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  /** Stage in extension storage (no user folder touched) and open as a tab. */
  private async openRecording(
    bytes: Uint8Array,
    name: string,
    format: RecordingFormat,
    note: string
  ): Promise<void> {
    const dir = vscode.Uri.joinPath(this.globalStorageUri, 'recordings');
    let uri: vscode.Uri;
    try {
      await vscode.workspace.fs.createDirectory(dir);
      uri = vscode.Uri.joinPath(dir, name);
      await vscode.workspace.fs.writeFile(uri, bytes);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Remote VNC (${this.label}): could not stage the recording — ${describeError(err)}.`
      );
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
    const choice = await vscode.window.showInformationMessage(
      `Remote VNC: recording opened, not saved${note}.`,
      'Save As…'
    );
    if (choice === 'Save As…') {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${os.homedir()}/${name}`),
        filters: recordingFilters(format),
      });
      if (target) {
        try {
          await vscode.workspace.fs.copy(uri, target, { overwrite: true });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Remote VNC (${this.label}): could not save the recording — ${describeError(err)}.`
          );
        }
      }
    }
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
    this.bridge.dispose();
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this.panel.dispose();
  }
}

type ExtensionMessage =
  | {
      type: 'connect';
      url: string;
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
  | { type: 'securityfailure'; reason?: string }
  | { type: 'log'; level: 'info' | 'error'; message: string }
  | { type: 'screenshot'; dataUrl?: string; error?: string }
  | { type: 'record-status'; recording: boolean; error?: string }
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

/** Save-dialog filter for a recording format. */
function recordingFilters(format: RecordingFormat): Record<string, string[]> {
  return format === 'gif' ? { 'GIF image': ['gif'] } : { 'WebM video': ['webm'] };
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
