import * as vscode from 'vscode';
import { VncSessionManager } from './vncPanel';
import { SessionInfo } from './sessionRegistry';

/** An active-session row in the Active Sessions tree. */
export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SessionInfo) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
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

/** Backs the "Active Sessions" view. */
export class SessionsTreeProvider
  implements vscode.TreeDataProvider<SessionTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly manager: VncSessionManager) {
    this.sub = manager.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionTreeItem[] {
    return this.manager.getSessions().map((s) => new SessionTreeItem(s));
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
