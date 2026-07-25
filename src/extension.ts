import * as vscode from 'vscode';
import * as net from 'net';
import { VncSessionManager, RfbOptions, ConnectionRequest } from './vncPanel';
import {
  SavedConnection,
  ConnectionEntry,
  DEFAULT_PORT,
  collectConnections,
  effectiveAutoReconnect,
  secretKeyFor,
  baseFor,
} from './connections';
import { ConnectionsTreeProvider, ConnectionTreeItem } from './connectionsView';
import { SessionsTreeProvider, SessionTreeItem } from './sessionsView';
import { SavedPage, PageEntry, collectPages, basePagesFor, isValidPageUrl } from './pages';
import { PagesTreeProvider, PageTreeItem } from './pagesView';
import { openPagePanel } from './pagePanel';
import { logger, disposeLogger } from './log';

const PLAINTEXT_WARNING_KEY = 'remoteVnc.plaintextWarningDismissed';

let manager: VncSessionManager;

export function activate(context: vscode.ExtensionContext): void {
  // Create the log channel eagerly so it appears in the Output dropdown, and
  // record the environment that shapes the bridge↔webview tunnel.
  logger().info(`Remote VNC activated (remote=${vscode.env.remoteName ?? 'local'}, ui=${vscode.env.appHost}).`);
  manager = new VncSessionManager(context);
  context.subscriptions.push(manager);

  const connectionsProvider = new ConnectionsTreeProvider();
  const sessionsProvider = new SessionsTreeProvider(manager);
  const pagesProvider = new PagesTreeProvider();
  context.subscriptions.push(
    connectionsProvider,
    sessionsProvider,
    pagesProvider,
    vscode.window.createTreeView('remoteVnc.connectionsView', { treeDataProvider: connectionsProvider }),
    vscode.window.createTreeView('remoteVnc.sessionsView', { treeDataProvider: sessionsProvider }),
    vscode.window.createTreeView('remoteVnc.pagesView', { treeDataProvider: pagesProvider })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('remoteVnc.connect', () => connectAdHoc(context)),
    vscode.commands.registerCommand('remoteVnc.connectSaved', () => connectSaved(context)),
    vscode.commands.registerCommand('remoteVnc.addConnection', () => addConnection()),
    vscode.commands.registerCommand('remoteVnc.forgetPassword', () => forgetPassword(context)),
    vscode.commands.registerCommand('remoteVnc.disconnect', () => manager.disconnectActive()),
    // Tree-only commands: hidden from the Command Palette via the
    // `commandPalette` menu gate, and guarded here in case they are invoked
    // without a tree item.
    vscode.commands.registerCommand('remoteVnc.connectConnection', (item?: ConnectionTreeItem) => {
      if (item) {
        void connectEntry(context, item.entry);
      }
    }),
    vscode.commands.registerCommand('remoteVnc.editConnection', (item?: ConnectionTreeItem) => {
      if (item) {
        void editConnection(item.entry);
      }
    }),
    vscode.commands.registerCommand('remoteVnc.deleteConnection', (item?: ConnectionTreeItem) => {
      if (item) {
        void deleteConnection(context, item.entry);
      }
    }),
    vscode.commands.registerCommand('remoteVnc.forgetConnectionPassword', (item?: ConnectionTreeItem) => {
      if (item) {
        void forgetConnectionPassword(context, item.entry);
      }
    }),
    vscode.commands.registerCommand('remoteVnc.revealSession', (item?: SessionTreeItem) => {
      if (item) {
        manager.reveal(item.session.id);
      }
    }),
    vscode.commands.registerCommand('remoteVnc.disconnectSession', (item?: SessionTreeItem) => {
      if (item) {
        manager.disconnect(item.session.id);
      }
    }),
    // Web pages — saved URLs (design mockups, local dev servers) opened as
    // clean full-bleed editor tabs alongside the VNC sessions.
    vscode.commands.registerCommand('remoteVnc.openPage', () => openPage(context)),
    vscode.commands.registerCommand('remoteVnc.addPage', () => addPage()),
    vscode.commands.registerCommand('remoteVnc.openPageItem', (item?: PageTreeItem) => {
      if (item) {
        void openPagePanel(context.extensionUri, item.entry.name, item.entry.url, canvasOf(item.entry));
      }
    }),
    vscode.commands.registerCommand('remoteVnc.editPage', (item?: PageTreeItem) => {
      if (item) {
        void editPage(item.entry);
      }
    }),
    vscode.commands.registerCommand('remoteVnc.deletePage', (item?: PageTreeItem) => {
      if (item) {
        void deletePage(item.entry);
      }
    })
  );
}

export function deactivate(): void {
  manager?.dispose();
  disposeLogger();
}

async function connectAdHoc(context: vscode.ExtensionContext): Promise<void> {
  const address = await vscode.window.showInputBox({
    title: 'Connect to VNC Server',
    prompt: 'Enter host, host:port, or host:display (e.g. 192.168.1.10, server:5901, server:1)',
    placeHolder: 'hostname[:port]',
    ignoreFocusOut: true,
    validateInput: (value) => (parseAddress(value) ? undefined : 'Enter a valid host (and optional port).'),
  });
  if (!address) {
    return;
  }
  const parsed = parseAddress(address);
  if (!parsed) {
    return;
  }

  const password = await promptPassword();
  if (password === undefined) {
    return; // user cancelled
  }

  await doConnect(context, { ...parsed, password: password || undefined, label: address });
}

async function connectSaved(context: vscode.ExtensionContext): Promise<void> {
  const saved = getSavedConnections();
  if (saved.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'Remote VNC: no saved connections yet.',
      'Add Connection…'
    );
    if (choice) {
      await addConnection();
    }
    return;
  }

  const pick = await vscode.window.showQuickPick(
    saved.map((c) => ({
      label: c.name,
      description: `${c.host}:${c.port ?? DEFAULT_PORT}`,
      connection: c,
    })),
    { title: 'Connect to Saved Server', placeHolder: 'Select a connection' }
  );
  if (!pick) {
    return;
  }
  await connectEntry(context, pick.connection);
}

/** Resolve the password (stored, or prompted-and-stored) and open the session. */
async function connectEntry(context: vscode.ExtensionContext, entry: ConnectionEntry): Promise<void> {
  const secretKey = secretKeyFor(entry);
  let password: string | undefined;
  try {
    password = await context.secrets.get(secretKey);
  } catch {
    password = undefined; // keychain locked/unavailable — fall through to prompt
  }
  if (password === undefined) {
    const entered = await promptPassword(
      'Password (leave empty if the server has no authentication — it will be stored securely)'
    );
    if (entered === undefined) {
      return;
    }
    password = entered;
    // Store even an empty password so we can tell "no auth needed" from
    // "not entered yet" and avoid re-prompting on every connect.
    try {
      await context.secrets.store(secretKey, password);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Remote VNC: could not save the password — ${describeError(err)}. Using it for this session only.`
      );
    }
  }

  await doConnect(context, {
    host: entry.host,
    port: entry.port ?? DEFAULT_PORT,
    password: password || undefined,
    label: entry.name,
    autoReconnect: entry.autoReconnect,
    forceRawEncoding: entry.forceRawEncoding,
  });
}

async function addConnection(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Add Saved Connection (1/2)',
    prompt: 'Display name for this connection',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
  });
  if (!name) {
    return;
  }

  const address = await vscode.window.showInputBox({
    title: 'Add Saved Connection (2/2)',
    prompt: 'Server address: host, host:port, or host:display',
    placeHolder: 'hostname[:port]',
    ignoreFocusOut: true,
    validateInput: (v) => (parseAddress(v) ? undefined : 'Enter a valid host (and optional port).'),
  });
  if (!address) {
    return;
  }
  const parsed = parseAddress(address);
  if (!parsed) {
    return;
  }

  // Default to global; only offer workspace scope when a folder is open, and
  // make the "may be committed" implication explicit.
  let target = vscode.ConfigurationTarget.Global;
  if (vscode.workspace.workspaceFolders) {
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: 'User (global)',
          description: 'Available in every window',
          target: vscode.ConfigurationTarget.Global,
        },
        {
          label: 'Workspace',
          description: 'Stored in .vscode/settings.json — may be committed to source control',
          target: vscode.ConfigurationTarget.Workspace,
        },
      ],
      { title: 'Where should this connection be saved?', placeHolder: 'Select a scope' }
    );
    if (!scope) {
      return;
    }
    target = scope.target;
  }

  const autoReconnect = await promptAutoReconnect(getAutoReconnectDefault());
  if (autoReconnect === undefined) {
    return;
  }
  const forceRawEncoding = await promptForceRaw();
  if (forceRawEncoding === undefined) {
    return;
  }
  await saveConnection(target, { name: name.trim(), host: parsed.host, port: parsed.port, autoReconnect, forceRawEncoding });

  const choice = await vscode.window.showInformationMessage(
    `Remote VNC: saved "${name.trim()}".`,
    'Connect Now'
  );
  if (choice) {
    await vscode.commands.executeCommand('remoteVnc.connectSaved');
  }
}

async function editConnection(entry: ConnectionEntry): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Edit Connection (1/2)',
    prompt: 'Display name for this connection',
    value: entry.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
  });
  if (!name) {
    return;
  }

  const address = await vscode.window.showInputBox({
    title: 'Edit Connection (2/2)',
    prompt: 'Server address: host, host:port, or host:display',
    value: `${entry.host}:${entry.port ?? DEFAULT_PORT}`,
    ignoreFocusOut: true,
    validateInput: (v) => (parseAddress(v) ? undefined : 'Enter a valid host (and optional port).'),
  });
  if (!address) {
    return;
  }
  const parsed = parseAddress(address);
  if (!parsed) {
    return;
  }

  // Seed with the EFFECTIVE value: a legacy entry without the field follows
  // the global default, and showing the raw value ("No") would invite the
  // user to confirm it — writing an explicit false that disables the
  // reconnect they currently have.
  const autoReconnect = await promptAutoReconnect(
    effectiveAutoReconnect(entry.autoReconnect, getAutoReconnectDefault())
  );
  if (autoReconnect === undefined) {
    return;
  }
  const forceRawEncoding = await promptForceRaw(entry.forceRawEncoding ?? false);
  if (forceRawEncoding === undefined) {
    return;
  }
  await saveConnection(
    entry.scope,
    { name: name.trim(), host: parsed.host, port: parsed.port, autoReconnect, forceRawEncoding },
    entry.name
  );
}

async function deleteConnection(context: vscode.ExtensionContext, entry: ConnectionEntry): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Delete saved connection "${entry.name}"?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }

  const config = vscode.workspace.getConfiguration('remoteVnc');
  const base = baseFor(config.inspect<SavedConnection[]>('connections'), entry.scope);
  await config.update('connections', base.filter((c) => c.name !== entry.name), entry.scope);

  // Offer to also clear the stored password, if any.
  try {
    const stored = await context.secrets.get(secretKeyFor(entry));
    if (stored !== undefined) {
      const choice = await vscode.window.showInformationMessage(
        `Also forget the stored password for "${entry.name}"?`,
        'Forget Password'
      );
      if (choice === 'Forget Password') {
        await context.secrets.delete(secretKeyFor(entry));
      }
    }
  } catch {
    /* secret storage unavailable — nothing to clean up */
  }
}

async function forgetConnectionPassword(
  context: vscode.ExtensionContext,
  entry: ConnectionEntry
): Promise<void> {
  try {
    await context.secrets.delete(secretKeyFor(entry));
    void vscode.window.showInformationMessage(
      `Remote VNC: cleared the stored password for "${entry.name}".`
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Remote VNC: could not clear the password — ${describeError(err)}.`
    );
  }
}

async function forgetPassword(context: vscode.ExtensionContext): Promise<void> {
  const saved = getSavedConnections();
  if (saved.length === 0) {
    void vscode.window.showInformationMessage('Remote VNC: no saved connections.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    saved.map((c) => ({ label: c.name, description: `${c.host}:${c.port ?? DEFAULT_PORT}`, connection: c })),
    { title: 'Forget Saved Password', placeHolder: 'Select a connection to clear its stored password' }
  );
  if (!pick) {
    return;
  }
  try {
    await context.secrets.delete(secretKeyFor(pick.connection));
    void vscode.window.showInformationMessage(`Remote VNC: cleared the stored password for "${pick.connection.name}".`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Remote VNC: could not clear the password — ${describeError(err)}.`);
  }
}

/** Palette entry: pick a saved page or enter an ad-hoc URL. */
async function openPage(context: vscode.ExtensionContext): Promise<void> {
  const saved = getSavedPages();
  const adHoc = { label: '$(globe) Open URL…', description: 'One-off, not saved' };
  const pick = await vscode.window.showQuickPick(
    [
      ...saved.map((p) => ({ label: p.name, description: p.url, page: p as PageEntry | undefined })),
      { ...adHoc, page: undefined },
    ],
    { title: 'Open Web Page', placeHolder: 'Select a saved page or enter a URL' }
  );
  if (!pick) {
    return;
  }
  if (pick.page) {
    await openPagePanel(context.extensionUri, pick.page.name, pick.page.url, canvasOf(pick.page));
    return;
  }
  const url = await promptPageUrl();
  if (!url) {
    return;
  }
  await openPagePanel(context.extensionUri, new URL(url).host || url, url);
}

/** The entry's fixed canvas, when both dimensions are configured. */
function canvasOf(page: SavedPage): { width: number; height: number } | undefined {
  return page.width !== undefined && page.height !== undefined
    ? { width: page.width, height: page.height }
    : undefined;
}

async function addPage(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Add Web Page (1/3)',
    prompt: 'Display name for this page',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
  });
  if (!name) {
    return;
  }
  const url = await promptPageUrl();
  if (!url) {
    return;
  }
  const canvas = await promptPageCanvas();
  if (canvas === undefined) {
    return;
  }

  // Default to global; only offer workspace scope when a folder is open
  // (mirrors addConnection — a committed settings.json is opt-in).
  let target = vscode.ConfigurationTarget.Global;
  if (vscode.workspace.workspaceFolders) {
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: 'User (global)',
          description: 'Available in every window',
          target: vscode.ConfigurationTarget.Global,
        },
        {
          label: 'Workspace',
          description: 'Stored in .vscode/settings.json — may be committed to source control',
          target: vscode.ConfigurationTarget.Workspace,
        },
      ],
      { title: 'Where should this page be saved?', placeHolder: 'Select a scope' }
    );
    if (!scope) {
      return;
    }
    target = scope.target;
  }

  await savePage(target, { name: name.trim(), url, ...canvas });
}

async function editPage(entry: PageEntry): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Edit Web Page (1/3)',
    prompt: 'Display name for this page',
    value: entry.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
  });
  if (!name) {
    return;
  }
  const url = await promptPageUrl(entry.url);
  if (!url) {
    return;
  }
  const canvas = await promptPageCanvas({ width: entry.width, height: entry.height });
  if (canvas === undefined) {
    return;
  }
  await savePage(entry.scope, { name: name.trim(), url, ...canvas }, entry.name);
}

async function deletePage(entry: PageEntry): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Delete saved page "${entry.name}"?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const base = basePagesFor(config.inspect<SavedPage[]>('pages'), entry.scope);
  await config.update('pages', base.filter((p) => p.name !== entry.name), entry.scope);
}

async function promptPageUrl(value?: string): Promise<string | undefined> {
  const url = await vscode.window.showInputBox({
    title: value ? 'Edit Web Page (2/3)' : 'Add Web Page (2/3)',
    prompt: 'Full http(s) URL — container-local ports are forwarded automatically',
    placeHolder: 'http://localhost:8089/ui_kits/kiosk/',
    value,
    ignoreFocusOut: true,
    validateInput: (v) => (isValidPageUrl(v.trim()) ? undefined : 'Enter an absolute http(s) URL.'),
  });
  return url?.trim() || undefined;
}

/**
 * Optional fixed-canvas step. Returns the parsed `{width,height}` for a
 * scale-to-fit page, an empty object for a responsive page, or `undefined`
 * when the step is cancelled (ESC) so the caller aborts. Pressing Enter on an
 * empty box keeps the page responsive; editing prefills the current size.
 */
async function promptPageCanvas(
  existing?: { width?: number; height?: number }
): Promise<{ width?: number; height?: number } | undefined> {
  const current =
    existing && existing.width !== undefined && existing.height !== undefined
      ? `${existing.width}x${existing.height}`
      : '';
  const answer = await vscode.window.showInputBox({
    title: existing ? 'Edit Web Page (3/3)' : 'Add Web Page (3/3)',
    prompt:
      'Optional fixed size WIDTH×HEIGHT — renders at that canvas scaled to fit the tab, ' +
      'right for fixed-size design mockups (the kiosk is 1280x800). Leave empty for a responsive page.',
    placeHolder: '1280x800',
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim() || parsePageSize(v)
        ? undefined
        : 'Enter WIDTH×HEIGHT, each 100–16384 (e.g. 1280x800), or leave empty.',
  });
  if (answer === undefined) {
    return undefined; // cancelled — abort the flow
  }
  return parsePageSize(answer) ?? {};
}

/** Parse "WIDTH×HEIGHT" (x or ×) into a sane canvas size, or undefined. */
function parsePageSize(text: string): { width: number; height: number } | undefined {
  const m = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/.exec(text);
  if (!m) {
    return undefined;
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  const ok = (n: number) => n >= 100 && n <= 16384;
  return ok(width) && ok(height) ? { width, height } : undefined;
}

/** Read saved pages (scope-tagged, trust-gated, global-precedence). */
function getSavedPages(): PageEntry[] {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  return collectPages(config.inspect<SavedPage[]>('pages'), vscode.workspace.isTrusted);
}

/** Upsert a page into a single scope; `oldName` removes a renamed record. */
async function savePage(
  target: vscode.ConfigurationTarget,
  page: SavedPage,
  oldName?: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const base = basePagesFor(config.inspect<SavedPage[]>('pages'), target);
  const next = [...base.filter((p) => p.name !== page.name && p.name !== (oldName ?? page.name)), page];
  await config.update('pages', next, target);
}

/** A connect request before the auto-reconnect default has been applied. */
type ConnectInput = Omit<ConnectionRequest, 'autoReconnect'> & { autoReconnect?: boolean };

/** Apply the unencrypted-traffic warning (once) and then open the session. */
async function doConnect(context: vscode.ExtensionContext, request: ConnectInput): Promise<void> {
  if (!isLoopbackHost(request.host) && !context.globalState.get<boolean>(PLAINTEXT_WARNING_KEY)) {
    const choice = await vscode.window.showWarningMessage(
      `Remote VNC: the connection to "${request.host}" is not encrypted. Classic VNC sends the screen and every keystroke (including passwords typed into the remote desktop) in cleartext. On an untrusted network, tunnel over SSH first (ssh -L 5901:localhost:5900 ${request.host}).`,
      { modal: false },
      'Connect Anyway',
      "Don't Show Again"
    );
    if (choice === undefined) {
      return; // dismissed → treat as cancel
    }
    if (choice === "Don't Show Again") {
      await context.globalState.update(PLAINTEXT_WARNING_KEY, true);
    }
  }
  // Resolve auto-reconnect here, the single funnel for every connect path, so
  // ad-hoc connects and saved entries without the field follow the global
  // default. ConnectionRequest requires the resolved boolean, so a future
  // caller of manager.connect cannot skip this step.
  await manager.connect(
    { ...request, autoReconnect: effectiveAutoReconnect(request.autoReconnect, getAutoReconnectDefault()) },
    getRfbOptions()
  );
}

/** The global `remoteVnc.autoReconnect` default for connections without their own value. */
function getAutoReconnectDefault(): boolean {
  return vscode.workspace.getConfiguration('remoteVnc').get<boolean>('autoReconnect', true);
}

function promptPassword(prompt = 'VNC password (leave empty if the server has no authentication)'): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'VNC Authentication',
    prompt,
    password: true,
    ignoreFocusOut: true,
  });
}

/** Ask whether a saved connection should auto-reconnect. Returns undefined on cancel. */
async function promptAutoReconnect(current = false): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'No', description: 'Do not reconnect automatically', value: false },
      { label: 'Yes', description: 'Reconnect every 10s if the connection drops', value: true },
    ],
    {
      title: 'Auto-reconnect',
      placeHolder: current ? 'Currently: Yes' : 'Currently: No',
    }
  );
  return pick?.value;
}

/** Ask whether to force the Raw encoding (compatibility). Returns undefined on cancel. */
async function promptForceRaw(current = false): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'No', description: 'Normal encodings (Tight/ZRLE/…)', value: false },
      { label: 'Yes', description: 'Compatibility: only Raw — for embedded servers that render blank', value: true },
    ],
    {
      title: 'Force Raw encoding',
      placeHolder: current ? 'Currently: Yes' : 'Currently: No',
    }
  );
  return pick?.value;
}

/** Read saved connections (scope-tagged, trust-gated, global-precedence). */
function getSavedConnections(): ConnectionEntry[] {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  return collectConnections(config.inspect<SavedConnection[]>('connections'), vscode.workspace.isTrusted);
}

/**
 * Upsert a connection into a single scope. `oldName` lets an edit that renames
 * the entry remove the previous record too. Reads the existing list from the
 * same scope as the write base so other scopes are untouched.
 */
async function saveConnection(
  target: vscode.ConfigurationTarget,
  conn: SavedConnection,
  oldName?: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const base = baseFor(config.inspect<SavedConnection[]>('connections'), target);
  const next = [...base.filter((c) => c.name !== conn.name && c.name !== (oldName ?? conn.name)), conn];
  await config.update('connections', next, target);
}

function getRfbOptions(): RfbOptions {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  return {
    viewOnly: config.get<boolean>('viewOnly', false),
    scaleViewport: config.get<boolean>('scaleViewport', true),
    resizeSession: config.get<boolean>('resizeSession', false),
    qualityLevel: clamp(config.get<number>('qualityLevel', 6), 0, 9),
    compressionLevel: clamp(config.get<number>('compressionLevel', 2), 0, 9),
    showDotCursor: config.get<boolean>('showDotCursor', false),
  };
}

/**
 * Parse a user-entered address into host and port.
 *  - "host"          → port 5900
 *  - "host:5901"     → port 5901
 *  - "host:1"        → display 1 → port 5901 (values < 100 are display numbers)
 *  - "[::1]:5901"    → bracketed IPv6 literal
 *  - "fe80::1"       → bare IPv6 literal → port 5900
 * Returns undefined for anything that is not a recognisable host[:port].
 */
export function parseAddress(input: string): { host: string; port: number } | undefined {
  const value = input.trim();
  if (!value) {
    return undefined;
  }

  // Bracketed IPv6: [addr] or [addr]:port
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracket) {
    if (!net.isIPv6(bracket[1])) {
      return undefined;
    }
    const port = toPort(bracket[2]);
    return port === undefined ? undefined : { host: bracket[1], port };
  }

  // More than one colon is only valid as a bare IPv6 literal.
  if ((value.match(/:/g) ?? []).length > 1) {
    return net.isIPv6(value) ? { host: value, port: DEFAULT_PORT } : undefined;
  }

  // host  or  host:port
  const [host, portPart] = value.split(':');
  if (!host || !isValidHost(host)) {
    return undefined;
  }
  const port = toPort(portPart);
  return port === undefined ? undefined : { host, port };
}

/** Resolve a port part. Missing → default; invalid → undefined; small → display offset. */
function toPort(part: string | undefined): number | undefined {
  if (!part) {
    return DEFAULT_PORT;
  }
  // Decimal digits only — Number() would otherwise accept "0x10", "1e2", "5.0",
  // "+5", " 5 ", connecting to a port the user never typed.
  if (!/^\d+$/.test(part)) {
    return undefined;
  }
  const n = Number(part);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    return undefined;
  }
  // Small numbers are conventionally VNC display offsets (":1" → 5901).
  return n < 100 ? DEFAULT_PORT + n : n;
}

/**
 * Accept an IPv4/IPv6 literal or a hostname/label shaped like a real DNS name.
 * Rejects whitespace, slashes, and control characters that would otherwise flow
 * into net.connect, the panel title, and the plaintext-warning message.
 */
function isValidHost(host: string): boolean {
  if (net.isIPv4(host) || net.isIPv6(host)) {
    return true;
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*$/.test(host);
}

function isLoopbackHost(host: string): boolean {
  let h = host.toLowerCase();
  if (h === 'localhost' || h === '::1') {
    return true;
  }
  // Treat the IPv4-mapped IPv6 form of loopback (::ffff:127.0.0.1) as loopback.
  if (h.startsWith('::ffff:')) {
    h = h.slice('::ffff:'.length);
  }
  return net.isIPv4(h) && h.startsWith('127.');
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
