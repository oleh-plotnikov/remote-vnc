import * as vscode from 'vscode';

/** A saved web page opened in a clean editor tab (e.g. design mockups). */
export interface SavedPage {
  name: string;
  url: string;
  /**
   * Optional fixed canvas size. When set, the page renders in a
   * width×height viewport scaled to fit the tab (like the VNC viewer's
   * scaleViewport) instead of reflowing responsively — right for fixed-size
   * design mockups (the kiosk canvas is 1280×800).
   */
  width?: number;
  height?: number;
}

/** A saved page plus the configuration scope it is defined in. */
export interface PageEntry extends SavedPage {
  scope: vscode.ConfigurationTarget;
}

/** The subset of WorkspaceConfiguration.inspect() we read. */
export interface PagesInspect {
  globalValue?: SavedPage[];
  workspaceValue?: SavedPage[];
  workspaceFolderValue?: SavedPage[];
}

/** A page URL is valid when it parses as absolute http(s). */
export function isValidPageUrl(url: unknown): boolean {
  if (typeof url !== 'string') {
    return false;
  }
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolve saved pages from a config inspection, tagging each with its scope.
 * Workspace scopes are layered UNDER global so a repo cannot shadow a
 * same-named user page. In an untrusted workspace, workspace/folder entries
 * are dropped (a committed settings.json must not inject URLs). Invalid
 * entries are skipped.
 */
export function collectPages(
  inspect: PagesInspect | undefined,
  isTrusted: boolean
): PageEntry[] {
  const layers: Array<{ list: SavedPage[] | undefined; scope: vscode.ConfigurationTarget }> = [];
  if (isTrusted) {
    layers.push({ list: inspect?.workspaceFolderValue, scope: vscode.ConfigurationTarget.WorkspaceFolder });
    layers.push({ list: inspect?.workspaceValue, scope: vscode.ConfigurationTarget.Workspace });
  }
  layers.push({ list: inspect?.globalValue, scope: vscode.ConfigurationTarget.Global });

  const byName = new Map<string, PageEntry>();
  for (const { list, scope } of layers) {
    for (const p of list ?? []) {
      if (p && typeof p.name === 'string' && p.name.trim() && isValidPageUrl(p.url)) {
        const size = sanitizeSize(p.width, p.height);
        byName.set(p.name, { name: p.name, url: p.url, ...size, scope });
      }
    }
  }
  return [...byName.values()];
}

/** A canvas size is used only when BOTH dimensions are sane positive ints. */
function sanitizeSize(
  width: unknown,
  height: unknown
): { width: number; height: number } | undefined {
  const ok = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 16384;
  return ok(width) && ok(height) ? { width, height } : undefined;
}

/** The existing saved list for a single scope (used as the write base). */
export function basePagesFor(
  inspect: PagesInspect | undefined,
  target: vscode.ConfigurationTarget
): SavedPage[] {
  if (target === vscode.ConfigurationTarget.Workspace) {
    return inspect?.workspaceValue ?? [];
  }
  if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
    return inspect?.workspaceFolderValue ?? [];
  }
  return inspect?.globalValue ?? [];
}
