import * as vscode from 'vscode';
import { ConnectionEntry, DEFAULT_PORT, SavedConnection, collectConnections } from './connections';

/** A saved-connection row in the Saved Connections tree. */
export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: ConnectionEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    const address = `${entry.host}:${entry.port ?? DEFAULT_PORT}`;
    this.description = address;
    this.tooltip = `${entry.name} — ${address}`;
    this.iconPath = new vscode.ThemeIcon('vm');
    this.contextValue = 'remoteVnc.connection';
    this.command = {
      command: 'remoteVnc.connectConnection',
      title: 'Connect',
      arguments: [this],
    };
  }
}

/** Backs the "Saved Connections" view. */
export class ConnectionsTreeProvider
  implements vscode.TreeDataProvider<ConnectionTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('remoteVnc.connections')) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh())
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ConnectionTreeItem[] {
    const config = vscode.workspace.getConfiguration('remoteVnc');
    const entries = collectConnections(
      config.inspect<SavedConnection[]>('connections'),
      vscode.workspace.isTrusted
    );
    return entries.map((entry) => new ConnectionTreeItem(entry));
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
