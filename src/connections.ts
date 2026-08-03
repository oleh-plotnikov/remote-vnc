import * as vscode from 'vscode';

export const DEFAULT_PORT = 5900;

export interface SavedConnection {
  name: string;
  host: string;
  port?: number;
  autoReconnect?: boolean;
  forceRawEncoding?: boolean;
  parkServerCursor?: boolean;
  /** Visible panel area "WxH" when the server advertises a padded framebuffer. */
  visibleArea?: string;
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
 * Tag a stored record with the scope it came from, or reject it as unusable
 * (bad host/name type, out-of-range port).
 *
 * Every `ConnectionEntry` in the extension is built here — by the layered
 * reader below and by the single-scope re-read the edit menu does after each
 * write — so both producers agree on validity and on shape. The record is
 * spread rather than rebuilt from a literal of known keys: rebuilding is
 * exactly the defect `applyConnectionEdit` exists to fix, and it would reappear
 * here the moment a field is added to the schema and forgotten in the literal.
 */
export function toConnectionEntry(
  conn: SavedConnection | undefined,
  scope: vscode.ConfigurationTarget
): ConnectionEntry | undefined {
  if (!conn || typeof conn.host !== 'string' || typeof conn.name !== 'string' || !isValidPort(conn.port)) {
    return undefined;
  }
  return { ...conn, scope };
}

/**
 * Resolve saved connections from a config inspection, tagging each with its
 * scope. Workspace scopes are layered UNDER global so a repo cannot shadow a
 * same-named user connection. In an untrusted workspace, workspace/folder
 * entries are dropped. Invalid entries are skipped.
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
      const entry = toConnectionEntry(c, scope);
      if (entry) {
        byName.set(entry.name, entry);
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

/**
 * Merge a wizard's patch onto a saved connection.
 *
 * A dialog only knows the fields it asks about. Rebuilding the record from a
 * literal therefore deletes every other field — which is how an edit used to
 * erase `visibleArea` and `parkServerCursor`. Merging keeps them.
 *
 * A key present in `patch` with the value `undefined` clears that field (the
 * visible-area "Auto" choice removes the key); a key absent from `patch` is
 * inherited from `base`. Keys are dropped rather than written as `undefined`
 * so settings.json does not accumulate empty properties, and `scope` — which
 * tags where an entry came from and is not part of the stored shape — never
 * reaches the record. The overloads enforce that creating a connection from
 * nothing (base=undefined) requires providing mandatory fields in the patch.
 */
export function applyConnectionEdit(
  base: ConnectionEntry | SavedConnection,
  patch: Partial<SavedConnection>
): SavedConnection;
export function applyConnectionEdit(
  base: undefined,
  patch: SavedConnection
): SavedConnection;
export function applyConnectionEdit(
  base: Partial<ConnectionEntry> | undefined,
  patch: Partial<SavedConnection>
): SavedConnection {
  const { scope: _scope, ...merged } = { ...(base ?? {}), ...patch };
  const record: Record<string, unknown> = merged;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record as unknown as SavedConnection;
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
