import * as vscode from 'vscode';
import { PageEntry, SavedPage, collectPages } from './pages';

/** A saved-page row in the Web Pages tree. */
export class PageTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: PageEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.description = entry.url;
    this.tooltip = `${entry.name} — ${entry.url}`;
    this.iconPath = new vscode.ThemeIcon('globe');
    this.contextValue = 'remoteVnc.page';
    this.command = {
      command: 'remoteVnc.openPageItem',
      title: 'Open',
      arguments: [this],
    };
  }
}

/** Backs the "Web Pages" view. */
export class PagesTreeProvider
  implements vscode.TreeDataProvider<PageTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('remoteVnc.pages')) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh())
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PageTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): PageTreeItem[] {
    const config = vscode.workspace.getConfiguration('remoteVnc');
    const entries = collectPages(
      config.inspect<SavedPage[]>('pages'),
      vscode.workspace.isTrusted
    );
    return entries.map((entry) => new PageTreeItem(entry));
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
