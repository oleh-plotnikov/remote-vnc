import * as vscode from 'vscode';
import { VncSessionManager } from './vncPanel';
import { SessionInfo } from './sessionRegistry';
import { ConnectionEntry } from './connections';
import { ResolvedQuickCommand, expandQuickCommand } from './quickCommands';

/** What the tree needs to know about a session's quick commands. */
export interface SessionCommands {
  /** The saved connection the session was opened from, if any. Ad-hoc
   *  sessions have none and so can only use global commands. */
  connection?: ConnectionEntry;
  commands: ResolvedQuickCommand[];
}

export type SessionCommandsLookup = (session: SessionInfo) => SessionCommands;

/** An active-session row in the Active Sessions tree. */
export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(session.label, collapsibleState);
    // A stable id is what lets VS Code keep the row's expanded/collapsed state
    // across the refresh every status or recording change triggers.
    this.id = session.id;
    if (session.status === 'reconnecting') {
      // `~spin` animates the codicon while the host retries the connection.
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
      this.tooltip = 'Reconnecting…';
    } else if (session.recording) {
      this.iconPath = new vscode.ThemeIcon('record', new vscode.ThemeColor('charts.red'));
      this.tooltip = 'Recording';
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    }
    this.contextValue = session.recording ? 'remoteVnc.session.recording' : 'remoteVnc.session';
    this.command = {
      command: 'remoteVnc.revealSession',
      title: 'Reveal',
      arguments: [this],
    };
  }
}

/** The "Quick commands" group under a session; its inline `+` adds one. */
export class QuickCommandsGroupItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly connection: ConnectionEntry | undefined,
    public readonly commands: ResolvedQuickCommand[]
  ) {
    super('Quick commands', vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${session.id}/quickCommands`;
    this.iconPath = new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.yellow'));
    this.contextValue = 'remoteVnc.quickCommands';
  }
}

/** One runnable command under a session. Clicking the row runs it. */
export class QuickCommandItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly connection: ConnectionEntry | undefined,
    public readonly quickCommand: ResolvedQuickCommand
  ) {
    super(quickCommand.name, vscode.TreeItemCollapsibleState.None);
    this.id = `${session.id}/quickCommands/${quickCommand.source}/${quickCommand.name}`;
    const expanded = expandQuickCommand(quickCommand.command, session);
    const line = expanded.ok ? expanded.command : quickCommand.command;
    this.description = line;
    const scope = quickCommand.source === 'global' ? 'all sessions' : `connection "${connection?.name}"`;
    this.tooltip = expanded.ok
      ? `${line}\n\nDefined for ${scope}.${quickCommand.confirm === false ? '' : ' Asks before running.'}`
      : `Cannot run: ${expanded.error}.`;
    this.iconPath = new vscode.ThemeIcon(
      expanded.ok ? 'terminal' : 'warning',
      expanded.ok ? undefined : new vscode.ThemeColor('problemsWarningIcon.foreground')
    );
    this.contextValue = 'remoteVnc.quickCommand';
    this.command = {
      command: 'remoteVnc.runQuickCommand',
      title: 'Run',
      arguments: [this],
    };
  }
}

/** Placeholder row shown while a session has no commands yet. */
export class AddQuickCommandItem extends vscode.TreeItem {
  constructor(public readonly group: QuickCommandsGroupItem) {
    super('Add quick command…', vscode.TreeItemCollapsibleState.None);
    this.id = `${group.session.id}/quickCommands/add`;
    this.iconPath = new vscode.ThemeIcon('add');
    this.contextValue = 'remoteVnc.addQuickCommand';
    this.command = {
      command: 'remoteVnc.addQuickCommand',
      title: 'Add Quick Command',
      arguments: [group],
    };
  }
}

export type SessionsNode = SessionTreeItem | QuickCommandsGroupItem | QuickCommandItem | AddQuickCommandItem;

/** Children of one tree node — split out of the provider so tests need no manager. */
export function sessionChildren(
  element: SessionsNode | undefined,
  sessions: SessionInfo[],
  lookup: SessionCommandsLookup
): SessionsNode[] {
  if (!element) {
    return sessions.map((s) => {
      // Open on first sight only when there is something to run; a session
      // without commands stays one line until the user asks for more.
      const state = lookup(s).commands.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      return new SessionTreeItem(s, state);
    });
  }
  if (element instanceof SessionTreeItem) {
    const { connection, commands } = lookup(element.session);
    return [new QuickCommandsGroupItem(element.session, connection, commands)];
  }
  if (element instanceof QuickCommandsGroupItem) {
    if (!element.commands.length) {
      return [new AddQuickCommandItem(element)];
    }
    return element.commands.map((c) => new QuickCommandItem(element.session, element.connection, c));
  }
  return [];
}

/** Backs the "Active Sessions" view. */
export class SessionsTreeProvider
  implements vscode.TreeDataProvider<SessionsNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: VncSessionManager,
    private readonly lookup: SessionCommandsLookup
  ) {
    this.disposables.push(
      manager.onDidChangeSessions(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('remoteVnc.connections') ||
          e.affectsConfiguration('remoteVnc.quickCommands')
        ) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh())
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionsNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionsNode): SessionsNode[] {
    return sessionChildren(element, this.manager.getSessions(), this.lookup);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
