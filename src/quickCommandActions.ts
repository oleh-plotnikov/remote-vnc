import * as vscode from 'vscode';
import {
  ConnectionEntry,
  DEFAULT_PORT,
  SavedConnection,
  applyConnectionEdit,
} from './connections';
import {
  QUICK_COMMAND_TEMPLATE,
  QuickCommand,
  QuickCommandSource,
  expandQuickCommand,
  findConnectionFor,
  resolveQuickCommands,
} from './quickCommands';
import { SessionInfo } from './sessionRegistry';
import { QuickCommandItem, QuickCommandsGroupItem, SessionCommands } from './sessionsView';
import { logger } from './log';

/** The connection-store helpers extension.ts already owns. */
export interface ConnectionStore {
  list(): ConnectionEntry[];
  /** The record as STORED in one scope — the merge base for a write. Not a
   *  ConnectionEntry: that one has had preUseCommand/postUseCommand resolved
   *  away, and merging onto it would erase them from settings. */
  read(scope: vscode.ConfigurationTarget, name: string): SavedConnection | undefined;
  save(scope: vscode.ConfigurationTarget, conn: SavedConnection, oldName?: string): Promise<void>;
}

const SETTING = 'quickCommands';

/**
 * The scope `remoteVnc.quickCommands` is effectively read from — and so the
 * one an edit has to write back to, or the edit would be shadowed by the very
 * value it was meant to change. Workspace values only count when trusted,
 * matching how saved connections are read.
 */
function globalCommandsScope(): vscode.ConfigurationTarget {
  const inspect = vscode.workspace.getConfiguration('remoteVnc').inspect<unknown[]>(SETTING);
  if (vscode.workspace.isTrusted) {
    if (inspect?.workspaceFolderValue !== undefined) {
      return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspect?.workspaceValue !== undefined) {
      return vscode.ConfigurationTarget.Workspace;
    }
  }
  return vscode.ConfigurationTarget.Global;
}

function rawGlobalCommands(scope: vscode.ConfigurationTarget): unknown[] {
  const inspect = vscode.workspace.getConfiguration('remoteVnc').inspect<unknown[]>(SETTING);
  const value =
    scope === vscode.ConfigurationTarget.WorkspaceFolder
      ? inspect?.workspaceFolderValue
      : scope === vscode.ConfigurationTarget.Workspace
        ? inspect?.workspaceValue
        : inspect?.globalValue;
  return Array.isArray(value) ? value : [];
}

/** Lookup the Active Sessions tree uses to populate each session. */
export function sessionCommandsLookup(store: ConnectionStore): (s: SessionInfo) => SessionCommands {
  return (session) => {
    const connection = findConnectionFor(session, store.list(), DEFAULT_PORT);
    return {
      connection,
      commands: resolveQuickCommands(
        connection?.quickCommands,
        rawGlobalCommands(globalCommandsScope())
      ),
    };
  };
}

/**
 * Rewrite one command list. Works on the raw stored array rather than the
 * sanitized one, so a hand-written entry this version cannot parse survives an
 * edit of its neighbour.
 */
async function updateCommands(
  store: ConnectionStore,
  source: QuickCommandSource,
  connection: ConnectionEntry | undefined,
  mutate: (list: unknown[]) => unknown[]
): Promise<void> {
  try {
    if (source === 'connection') {
      if (!connection) {
        return;
      }
      // Re-read: the tree item may be older than the last settings write.
      const current = store.read(connection.scope, connection.name);
      if (!current) {
        void vscode.window.showWarningMessage(
          `Remote VNC: "${connection.name}" is no longer saved — nothing was changed.`
        );
        return;
      }
      const next = mutate(Array.isArray(current.quickCommands) ? [...current.quickCommands] : []);
      await store.save(
        connection.scope,
        applyConnectionEdit(current, {
          quickCommands: next.length ? (next as QuickCommand[]) : undefined,
        })
      );
    } else {
      const scope = globalCommandsScope();
      const next = mutate([...rawGlobalCommands(scope)]);
      await vscode.workspace
        .getConfiguration('remoteVnc')
        .update(SETTING, next.length ? next : undefined, scope);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Remote VNC: could not save the quick command — ${err instanceof Error ? err.message : String(err)}.`
    );
  }
}

const nameOf = (c: unknown): unknown => (c && typeof c === 'object' ? (c as QuickCommand).name : undefined);

/** One terminal per session-and-command, reused while its shell lives. */
const terminals = new Map<string, vscode.Terminal>();

const RUN = 'Run';
const RUN_ALWAYS = "Run and Don't Ask Again";

export async function runQuickCommand(store: ConnectionStore, item: QuickCommandItem): Promise<void> {
  const { session, quickCommand, connection } = item;
  const expanded = expandQuickCommand(quickCommand.command, session);
  if (!expanded.ok) {
    void vscode.window.showErrorMessage(`Remote VNC: cannot run "${quickCommand.name}" — ${expanded.error}.`);
    return;
  }
  if (quickCommand.confirm !== false) {
    // A modal message cannot hold a checkbox, so "don't ask again" is a
    // second button — the same shape VS Code's own confirmations use.
    const choice = await vscode.window.showWarningMessage(
      `Run "${quickCommand.name}" on ${session.label}?`,
      {
        modal: true,
        detail: `${expanded.command}\n\n"${RUN_ALWAYS}" turns confirmation off for this command; turn it back on with Edit.`,
      },
      RUN,
      RUN_ALWAYS
    );
    if (choice !== RUN && choice !== RUN_ALWAYS) {
      return;
    }
    if (choice === RUN_ALWAYS) {
      // Not awaited before running: the user asked to run now, and a failed
      // settings write is reported on its own by updateCommands.
      void updateCommands(store, quickCommand.source, connection, (list) =>
        list.map((c) =>
          nameOf(c) === quickCommand.name && c && typeof c === 'object'
            ? { ...(c as QuickCommand), confirm: false }
            : c
        )
      );
    }
  }

  const title = `${session.label} · ${quickCommand.name}`;
  let terminal = terminals.get(title);
  if (!terminal || terminal.exitStatus !== undefined || !vscode.window.terminals.includes(terminal)) {
    terminal = vscode.window.createTerminal({ name: title, iconPath: new vscode.ThemeIcon('zap') });
    terminals.set(title, terminal);
  }
  terminal.show();
  terminal.sendText(expanded.command, true);
  // The command line itself is not logged: it is the user's, and may carry
  // a token or a password they chose to keep in settings.
  logger().info(`quick command "${quickCommand.name}" sent to a terminal (${session.host}:${session.port}).`);
}

/** Forget a closed terminal so the map does not hold it. */
export function trackTerminalClose(): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((closed) => {
    for (const [key, t] of terminals) {
      if (t === closed) {
        terminals.delete(key);
      }
    }
  });
}

async function promptName(value: string, taken: Set<string>): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'Quick command name',
    prompt: 'Label shown under the session',
    placeHolder: 'Reboot',
    value,
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim() ? 'A name is required.' : taken.has(v.trim()) ? 'A command with this name already exists here.' : undefined,
  });
  return name?.trim() || undefined;
}

async function promptCommandLine(value: string): Promise<string | undefined> {
  const command = await vscode.window.showInputBox({
    title: 'Command line',
    prompt: 'Runs in a terminal. ${host} and ${port} are replaced with the session\'s target.',
    value,
    valueSelection: [value.length, value.length],
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A command is required.'),
  });
  return command?.trim() || undefined;
}

async function promptConfirm(current: boolean): Promise<boolean | undefined> {
  const items: Array<vscode.QuickPickItem & { value: boolean }> = [
    { label: '$(shield) Ask before running', description: current ? 'current' : undefined, value: true },
    { label: '$(zap) Run immediately', description: current ? undefined : 'current', value: false },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Confirmation',
    placeHolder: 'Ask before running? Keep it on for anything that reboots or deletes.',
    ignoreFocusOut: true,
  });
  return pick?.value;
}

/** Stored shape; `confirm` is written only when it differs from the default. */
function toStored(name: string, command: string, confirm: boolean): QuickCommand {
  return confirm ? { name, command } : { name, command, confirm: false };
}

export async function addQuickCommand(store: ConnectionStore, group: QuickCommandsGroupItem): Promise<void> {
  const { connection, session } = group;
  let source: QuickCommandSource = 'global';
  if (connection) {
    const where = await vscode.window.showQuickPick(
      [
        {
          label: `$(vm) Only "${connection.name}"`,
          description: 'saved with this connection',
          source: 'connection' as const,
        },
        {
          label: '$(globe) All sessions',
          description: 'remoteVnc.quickCommands',
          source: 'global' as const,
        },
      ],
      { title: `Add Quick Command — ${session.label}`, placeHolder: 'Where should it appear?', ignoreFocusOut: true }
    );
    if (!where) {
      return;
    }
    source = where.source;
  }

  const taken = new Set(group.commands.filter((c) => c.source === source).map((c) => c.name));
  const name = await promptName('', taken);
  if (!name) {
    return;
  }
  const command = await promptCommandLine(QUICK_COMMAND_TEMPLATE);
  if (!command) {
    return;
  }
  const confirm = await promptConfirm(true);
  if (confirm === undefined) {
    return;
  }
  await updateCommands(store, source, connection, (list) => [...list, toStored(name, command, confirm)]);
}

export async function editQuickCommand(store: ConnectionStore, item: QuickCommandItem): Promise<void> {
  const { quickCommand: qc, connection } = item;
  const name = await promptName(qc.name, new Set());
  if (!name) {
    return;
  }
  const command = await promptCommandLine(qc.command);
  if (!command) {
    return;
  }
  const confirm = await promptConfirm(qc.confirm !== false);
  if (confirm === undefined) {
    return;
  }
  await updateCommands(store, qc.source, connection, (list) => {
    // A rename onto another command's name would leave two entries sharing
    // it, and sanitizing would then silently hide the second.
    if (name !== qc.name && list.some((c) => nameOf(c) === name)) {
      void vscode.window.showErrorMessage(`Remote VNC: a quick command named "${name}" already exists.`);
      return list;
    }
    return list.map((c) => (nameOf(c) === qc.name ? toStored(name, command, confirm) : c));
  });
}

export async function deleteQuickCommand(store: ConnectionStore, item: QuickCommandItem): Promise<void> {
  const { quickCommand: qc, connection } = item;
  const where = qc.source === 'global' ? 'all sessions' : `"${connection?.name}"`;
  const choice = await vscode.window.showWarningMessage(
    `Delete quick command "${qc.name}" from ${where}?`,
    { modal: true },
    'Delete'
  );
  if (choice !== 'Delete') {
    return;
  }
  await updateCommands(store, qc.source, connection, (list) => list.filter((c) => nameOf(c) !== qc.name));
}
