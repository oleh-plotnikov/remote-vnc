import * as vscode from 'vscode';

export const DEFAULT_PORT = 5900;

export interface SavedConnection {
  name: string;
  host: string;
  port?: number;
  autoReconnect?: boolean;
  forceRawEncoding?: boolean;
  parkServerCursor?: boolean;
}

/** A saved connection plus the configuration scope it is defined in. */
export interface ConnectionEntry extends SavedConnection {
  scope: vscode.ConfigurationTarget;
}

/** The subset of WorkspaceConfiguration.inspect() we read. */
export interface ConnectionsInspect {
  globalValue?: SavedConnection[];
  workspaceValue?: SavedConnection[];
  workspaceFolderValue?: SavedConnection[];
}

/** A saved port is valid when absent or an integer in the TCP range. */
export function isValidPort(port: number | undefined): boolean {
  return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535);
}

/**
 * Resolve saved connections from a config inspection, tagging each with its
 * scope. Workspace scopes are layered UNDER global so a repo cannot shadow a
 * same-named user connection. In an untrusted workspace, workspace/folder
 * entries are dropped. Invalid entries (bad host/name type or out-of-range
 * port) are skipped.
 */
export function collectConnections(
  inspect: ConnectionsInspect | undefined,
  isTrusted: boolean
): ConnectionEntry[] {
  const layers: Array<{ list: SavedConnection[] | undefined; scope: vscode.ConfigurationTarget }> = [];
  if (isTrusted) {
    layers.push({ list: inspect?.workspaceFolderValue, scope: vscode.ConfigurationTarget.WorkspaceFolder });
    layers.push({ list: inspect?.workspaceValue, scope: vscode.ConfigurationTarget.Workspace });
  }
  layers.push({ list: inspect?.globalValue, scope: vscode.ConfigurationTarget.Global });

  const byName = new Map<string, ConnectionEntry>();
  for (const { list, scope } of layers) {
    for (const c of list ?? []) {
      if (c && typeof c.host === 'string' && typeof c.name === 'string' && isValidPort(c.port)) {
        byName.set(c.name, {
          name: c.name,
          host: c.host,
          port: c.port,
          autoReconnect: c.autoReconnect,
          forceRawEncoding: c.forceRawEncoding,
          parkServerCursor: c.parkServerCursor,
          scope,
        });
      }
    }
  }
  return [...byName.values()];
}

/**
 * Effective auto-reconnect for a session: the connection's own setting when
 * present, otherwise the global `remoteVnc.autoReconnect` default. Connections
 * saved before the per-connection field existed (≤0.1.0) carry no value, so
 * without the fallback they would silently never reconnect.
 */
export function effectiveAutoReconnect(
  perConnection: boolean | undefined,
  globalDefault: boolean
): boolean {
  return perConnection ?? globalDefault;
}

/** Secret-storage key for a connection's password, bound to host:port. */
export function secretKeyFor(conn: { name: string; host: string; port?: number }): string {
  return `remoteVnc:${conn.name}@${conn.host}:${conn.port ?? DEFAULT_PORT}`;
}

/** The existing saved list for a single scope (used as the write base). */
export function baseFor(
  inspect: ConnectionsInspect | undefined,
  target: vscode.ConfigurationTarget
): SavedConnection[] {
  if (target === vscode.ConfigurationTarget.Workspace) {
    return inspect?.workspaceValue ?? [];
  }
  if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
    return inspect?.workspaceFolderValue ?? [];
  }
  return inspect?.globalValue ?? [];
}
