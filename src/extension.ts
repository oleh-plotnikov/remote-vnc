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
  applyConnectionEdit,
  toConnectionEntry,
} from './connections';
import { parseVisibleArea } from './cropLayout';
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
    vscode.commands.registerCommand('remoteVnc.screenshot', () => manager.screenshotActive()),
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
    vscode.commands.registerCommand('remoteVnc.screenshotSession', (item?: SessionTreeItem) => {
      if (item) {
        manager.screenshotSession(item.session.id);
      }
    }),
    vscode.commands.registerCommand('remoteVnc.screenshotConnection', (item?: ConnectionTreeItem) => {
      if (!item) {
        return;
      }
      if (!manager.screenshotTarget(item.entry.host, item.entry.port ?? DEFAULT_PORT)) {
        void vscode.window.showInformationMessage(
          `Remote VNC: "${item.entry.name}" is not connected — connect first, then take the screenshot.`
        );
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
    parkServerCursor: entry.parkServerCursor,
    scaleViewport: entry.scaleViewport,
    visibleArea: parseVisibleArea(entry.visibleArea),
  });
}

async function addConnection(): Promise<void> {
  // The scope question only appears when a folder is open, so the step count
  // is derived rather than written down — a fixed denominator would be a lie
  // in a window with no folder.
  const hasFolder = Boolean(vscode.workspace.workspaceFolders);
  const total = hasFolder ? 7 : 6;
  let step = 0;
  // The shared prompts name their field in their own title, so the counted
  // title carries the field name too — a step reading only "(4/7)" would leave
  // a Yes/No pick with nothing saying what is being answered.
  const title = (field?: string) => {
    const counted = `Add Saved Connection (${++step}/${total})`;
    return field ? `${counted} — ${field}` : counted;
  };

  const name = await vscode.window.showInputBox({
    title: title(),
    prompt: 'Display name for this connection',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
  });
  if (!name) {
    return;
  }

  const address = await vscode.window.showInputBox({
    title: title(),
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
  if (hasFolder) {
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
      { title: title(), placeHolder: 'Where should this connection be saved?' }
    );
    if (!scope) {
      return;
    }
    target = scope.target;
  }

  // A new connection inherits both defaults until the user says otherwise, so
  // the prompts are seeded with "no value of its own" rather than with the
  // global setting — confirming the latter would pin it and make the global
  // one dead for this connection.
  const autoReconnect = await promptAutoReconnect(
    undefined,
    getAutoReconnectDefault(),
    title('Auto-reconnect')
  );
  if (!autoReconnect) {
    return;
  }
  const forceRawEncoding = await promptForceRaw(false, title('Force Raw encoding'));
  if (forceRawEncoding === undefined) {
    return;
  }
  const park = await promptParkServerCursor(
    undefined,
    getParkServerCursorDefault(),
    title('Park server cursor')
  );
  if (!park) {
    return;
  }
  const area = await promptVisibleArea(undefined, title('Visible area'));
  if (!area) {
    return;
  }

  await saveConnection(
    target,
    applyConnectionEdit(undefined, {
      name: name.trim(),
      host: parsed.host,
      port: parsed.port,
      // Spread rather than assigned: the two inherited flags answer with a
      // patch whose value may be undefined, which applyConnectionEdit drops so
      // the field keeps following the global setting.
      ...autoReconnect,
      forceRawEncoding,
      ...park,
      visibleArea: area.visibleArea,
    })
  );

  const choice = await vscode.window.showInformationMessage(
    `Remote VNC: saved "${name.trim()}".`,
    'Connect Now'
  );
  if (choice) {
    await vscode.commands.executeCommand('remoteVnc.connectSaved');
  }
}

type ConnectionField =
  | 'name'
  | 'address'
  | 'autoReconnect'
  | 'forceRawEncoding'
  | 'parkServerCursor'
  | 'visibleArea'
  | 'done';

/** Describe a tri-state flag: explicit On/Off, or the global default it inherits. */
function describeFlag(value: boolean | undefined, fallback: boolean): string {
  if (value === undefined) {
    return `Default (${fallback ? 'On' : 'Off'})`;
  }
  return value ? 'On' : 'Off';
}

/**
 * Edit a saved connection through a menu of its properties.
 *
 * Each choice writes immediately instead of collecting answers for a final
 * confirmation: Esc then means "I am done" rather than "discard everything",
 * and a rename — which removes the previous record — does not depend on the
 * user reaching the end. The entry is re-read after every write so the values
 * on screen stay true.
 *
 * Inherited flags show the effective value marked as inherited. Showing the
 * raw absent value would invite the user to confirm it, writing an explicit
 * false that silences a global default they may later change.
 */
async function editConnection(entry: ConnectionEntry): Promise<void> {
  let current: ConnectionEntry = entry;
  for (;;) {
    const items: Array<vscode.QuickPickItem & { id?: ConnectionField }> = [
      { id: 'name', label: '$(edit) Name', description: current.name },
      {
        id: 'address',
        label: '$(server) Address',
        description: `${current.host}:${current.port ?? DEFAULT_PORT}`,
      },
      {
        id: 'autoReconnect',
        label: '$(sync) Auto-reconnect',
        description: describeFlag(current.autoReconnect, getAutoReconnectDefault()),
      },
      {
        id: 'forceRawEncoding',
        // Plain On/Off, not describeFlag: there is no global
        // remoteVnc.forceRawEncoding for an unset value to inherit, so
        // "Default (…)" would name a setting that does not exist.
        label: '$(zap) Force raw encoding',
        description: current.forceRawEncoding ? 'On' : 'Off',
      },
      {
        id: 'parkServerCursor',
        label: '$(target) Park server cursor',
        description: describeFlag(current.parkServerCursor, getParkServerCursorDefault()),
      },
      {
        id: 'visibleArea',
        label: '$(screen-full) Visible area',
        description: current.visibleArea ?? 'Auto',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { id: 'done', label: '$(check) Done' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `Edit Connection — ${current.name}`,
      placeHolder: 'Pick a property to change',
      ignoreFocusOut: true,
    });
    if (!pick?.id || pick.id === 'done') {
      return;
    }

    const patch = await promptConnectionField(pick.id, current);
    if (!patch) {
      continue;
    }

    const previousName = current.name;
    // Writing per change turns one failure point into one per change, and a
    // menu that simply vanished would look like it had saved. Read-only
    // settings and an unwritable .vscode/settings.json both land here.
    try {
      await saveConnection(
        current.scope,
        applyConnectionEdit(current, patch),
        previousName
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Remote VNC: could not save "${previousName}" — ${describeError(err)}.`
      );
      return;
    }

    // Settings writes are asynchronous; re-reading is what keeps the menu
    // honest after a rename or a cleared field.
    const name = patch.name ?? previousName;
    const reread = readConnection(current.scope, name);
    if (!reread) {
      void vscode.window.showWarningMessage(
        `Remote VNC: "${name}" is no longer saved in this scope — reopen it from the connections view to keep editing.`
      );
      return;
    }
    current = reread;
  }
}

/** Prompt for one field. Returns the patch to apply, or undefined if cancelled. */
async function promptConnectionField(
  field: Exclude<ConnectionField, 'done'>,
  current: ConnectionEntry
): Promise<Partial<SavedConnection> | undefined> {
  switch (field) {
    case 'name': {
      const name = await vscode.window.showInputBox({
        title: 'Name',
        prompt: 'Display name for this connection',
        value: current.name,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
      });
      return name ? { name: name.trim() } : undefined;
    }
    case 'address': {
      const address = await vscode.window.showInputBox({
        title: 'Address',
        prompt: 'Server address: host, host:port, or host:display',
        value: `${current.host}:${current.port ?? DEFAULT_PORT}`,
        ignoreFocusOut: true,
        validateInput: (v) =>
          parseAddress(v) ? undefined : 'Enter a valid host (and optional port).',
      });
      const parsed = address ? parseAddress(address) : undefined;
      return parsed ? { host: parsed.host, port: parsed.port } : undefined;
    }
    // The two inherited flags pass their raw value, not the effective one: the
    // prompt has to be able to say "Currently: Default (Off)" and to offer
    // that state back, which a resolved boolean cannot express.
    case 'autoReconnect':
      return promptAutoReconnect(current.autoReconnect, getAutoReconnectDefault());
    case 'forceRawEncoding': {
      const value = await promptForceRaw(current.forceRawEncoding ?? false);
      return value === undefined ? undefined : { forceRawEncoding: value };
    }
    case 'parkServerCursor':
      return promptParkServerCursor(current.parkServerCursor, getParkServerCursorDefault());
    case 'visibleArea':
      return promptVisibleArea(current.visibleArea);
  }
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

/** A connect request before the global defaults have been applied. */
type ConnectInput = Omit<ConnectionRequest, 'autoReconnect' | 'parkServerCursor' | 'scaleViewport'> & {
  autoReconnect?: boolean;
  parkServerCursor?: boolean;
  /** Per-connection display override; resolved into RfbOptions.scaleViewport. */
  scaleViewport?: boolean;
};

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
  // Resolve the per-connection-or-global defaults here, the single funnel for
  // every connect path, so ad-hoc connects and saved entries without the
  // fields follow the global settings. ConnectionRequest requires the
  // resolved booleans, so a future caller of manager.connect cannot skip this.
  const { scaleViewport, ...req } = request;
  const options = getRfbOptions();
  await manager.connect(
    {
      ...req,
      autoReconnect: effectiveAutoReconnect(req.autoReconnect, getAutoReconnectDefault()),
      parkServerCursor:
        req.parkServerCursor ??
        vscode.workspace.getConfiguration('remoteVnc').get<boolean>('parkServerCursor', false),
    },
    { ...options, scaleViewport: scaleViewport ?? options.scaleViewport }
  );
}

/** The global `remoteVnc.autoReconnect` default for connections without their own value. */
function getAutoReconnectDefault(): boolean {
  return vscode.workspace.getConfiguration('remoteVnc').get<boolean>('autoReconnect', true);
}

/** The global `remoteVnc.parkServerCursor` default for connections without their own value. */
function getParkServerCursorDefault(): boolean {
  return vscode.workspace.getConfiguration('remoteVnc').get<boolean>('parkServerCursor', false);
}

function promptPassword(prompt = 'VNC password (leave empty if the server has no authentication)'): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'VNC Authentication',
    prompt,
    password: true,
    ignoreFocusOut: true,
  });
}

/** "Currently: …" for a tri-state flag, in the Yes/No voice its prompt uses. */
function currentlyFlag(value: boolean | undefined, fallback: boolean): string {
  if (value === undefined) {
    return `Currently: ${describeFlag(undefined, fallback)}`;
  }
  return `Currently: ${value ? 'Yes' : 'No'}`;
}

/**
 * Ask whether a saved connection should auto-reconnect. Returns the patch to
 * apply — `{ autoReconnect: undefined }` means "follow the global setting",
 * which clears the field — or undefined when cancelled. Offering only Yes/No
 * would make the inherited state a one-way door: every answer would write an
 * explicit boolean and the connection could never go back to the default
 * without hand-editing settings.json.
 */
async function promptAutoReconnect(
  current: boolean | undefined,
  fallback: boolean,
  title = 'Auto-reconnect'
): Promise<{ autoReconnect: boolean | undefined } | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'No', description: 'Do not reconnect automatically', value: false as boolean | undefined },
      { label: 'Yes', description: 'Reconnect every 10s if the connection drops', value: true as boolean | undefined },
      {
        label: describeFlag(undefined, fallback),
        description: 'Follow the remoteVnc.autoReconnect setting',
        value: undefined,
      },
    ],
    { title, placeHolder: currentlyFlag(current, fallback), ignoreFocusOut: true }
  );
  return pick ? { autoReconnect: pick.value } : undefined;
}

/**
 * Ask whether to force the Raw encoding (compatibility). Returns undefined on
 * cancel. Two-state, unlike the flags above: there is no global
 * `remoteVnc.forceRawEncoding` setting, so there is nothing to inherit and no
 * default to offer.
 */
async function promptForceRaw(current = false, title = 'Force Raw encoding'): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'No', description: 'Normal encodings (Tight/ZRLE/…)', value: false },
      { label: 'Yes', description: 'Compatibility: only Raw — for embedded servers that render blank', value: true },
    ],
    {
      title,
      placeHolder: current ? 'Currently: Yes' : 'Currently: No',
      ignoreFocusOut: true,
    }
  );
  return pick?.value;
}

/**
 * Ask whether to park the server-drawn cursor when idle. Returns the patch to
 * apply — `{ parkServerCursor: undefined }` means "follow the global setting"
 * — or undefined when cancelled. See `promptAutoReconnect` for why the
 * inherited state has to be reachable.
 */
async function promptParkServerCursor(
  current: boolean | undefined,
  fallback: boolean,
  title = 'Park server cursor'
): Promise<{ parkServerCursor: boolean | undefined } | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'No',
        description: 'Leave the pointer where the server draws it',
        value: false as boolean | undefined,
      },
      {
        label: 'Yes',
        description: 'Move it to the bottom-right corner after a few idle seconds',
        value: true as boolean | undefined,
      },
      {
        label: describeFlag(undefined, fallback),
        description: 'Follow the remoteVnc.parkServerCursor setting',
        value: undefined,
      },
    ],
    { title, placeHolder: currentlyFlag(current, fallback), ignoreFocusOut: true }
  );
  return pick ? { parkServerCursor: pick.value } : undefined;
}

/**
 * Ask for the visible panel area. Returns a patch — `{ visibleArea: undefined }`
 * means "Auto", which clears the field — or undefined when cancelled. The two
 * must stay distinguishable: cancelling has to leave the setting alone.
 */
async function promptVisibleArea(
  current: string | undefined,
  title = 'Visible area'
): Promise<{ visibleArea: string | undefined } | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Auto', description: 'Show the whole framebuffer', custom: false },
      {
        label: 'Custom size…',
        description: current ? `Currently: ${current}` : 'Crop to a WIDTHxHEIGHT area',
        custom: true,
      },
    ],
    {
      title,
      placeHolder: current ? `Currently: ${current}` : 'Currently: Auto',
      // The input box behind "Custom size…" tells the user to go read the
      // framebuffer size out of the output channel — which they cannot do if
      // this pick dismisses the moment the editor takes focus.
      ignoreFocusOut: true,
    }
  );
  if (!pick) {
    return undefined;
  }
  if (!pick.custom) {
    return { visibleArea: undefined };
  }

  const value = await vscode.window.showInputBox({
    title,
    prompt:
      'Visible panel size as WIDTHxHEIGHT. The "connected" line in the Remote VNC output reports the size the server advertises.',
    value: current ?? '',
    placeHolder: '480x272',
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim() || parseVisibleArea(v) ? undefined : 'Enter a size like 480x272.',
  });
  if (value === undefined) {
    return undefined;
  }
  return { visibleArea: value.trim() ? value.trim() : undefined };
}

/** Read saved connections (scope-tagged, trust-gated, global-precedence). */
function getSavedConnections(): ConnectionEntry[] {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  return collectConnections(config.inspect<SavedConnection[]>('connections'), vscode.workspace.isTrusted);
}

/**
 * Re-read one connection from one scope. The layered reader deduplicates by
 * name across scopes, so it cannot see a workspace entry shadowed by a global
 * one — the menu needs the record it is actually writing. Tagging goes through
 * the same helper the layered reader uses, so the menu can never merge onto a
 * record `getSavedConnections` would have rejected.
 */
function readConnection(
  target: vscode.ConfigurationTarget,
  name: string
): ConnectionEntry | undefined {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const found = baseFor(config.inspect<SavedConnection[]>('connections'), target).find(
    (c) => c.name === name
  );
  return toConnectionEntry(found, target);
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
