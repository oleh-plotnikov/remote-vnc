import * as vscode from 'vscode';

import { logger } from './log';
import {
  StripNoticeLog,
  resolveUseCommands,
  type UseCommands,
  type UseCommandsSource,
} from './useCommands';

export const DEFAULT_PORT = 5900;

export interface SavedConnection extends UseCommandsSource {
  name: string;
  host: string;
  port?: number;
  /** Account name for servers whose security type asks for one. macOS offers
   *  Apple ARD/DH (30) ahead of VNC Auth (2), and noVNC takes the first type
   *  it supports from the server's list — so a Mac target needs a username as
   *  well as a password. Classic password-only servers ignore it. */
  username?: string;
  autoReconnect?: boolean;
  forceRawEncoding?: boolean;
  parkServerCursor?: boolean;
  /** Scale to fit the panel (true) or render 1:1 (false); absent = follow
   *  the global `remoteVnc.scaleViewport` default. */
  scaleViewport?: boolean;
  /** Visible panel area "WxH" when the server advertises a padded framebuffer. */
  visibleArea?: string;
}

/**
 * A saved connection plus the configuration scope it is defined in.
 *
 * `Omit`, not `extends SavedConnection`: the raw command fields are
 * deliberately NOT on this type, so `use` — the trust-gated result — is the
 * only way to reach a command. See PageEntry (src/pages.ts) for the same
 * reasoning.
 */
export interface ConnectionEntry
  extends Omit<SavedConnection, 'preUseCommand' | 'postUseCommand' | 'preUseTimeout'> {
  scope: vscode.ConfigurationTarget;
  use: UseCommands;
}

/** First-occurrence-only reporting for commands the trust gate dropped. */
const stripNotices = new StripNoticeLog();

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
 *
 * The three command fields are the one exception, and they are destructured
 * out by name so the spread cannot carry them through. They are ARBITRARY
 * SHELL COMMANDS from settings, and `remoteVnc.connections` is
 * workspace-settable, so a cloned repository could otherwise ship one that
 * runs the moment its saved connection is opened. `resolveUseCommands` drops
 * them unless the workspace is trusted (the gate `tasks.json` uses); the
 * connection itself is unaffected and still connects. `isTrusted` is a
 * required parameter rather than an option with a default because a caller
 * that forgets it must not silently get the permissive answer.
 */
export function toConnectionEntry(
  conn: SavedConnection | undefined,
  scope: vscode.ConfigurationTarget,
  isTrusted: boolean
): ConnectionEntry | undefined {
  if (!conn || typeof conn.host !== 'string' || typeof conn.name !== 'string' || !isValidPort(conn.port)) {
    return undefined;
  }
  const { preUseCommand: _pre, postUseCommand: _post, preUseTimeout: _timeout, ...rest } = conn;
  const { commands, stripped } = resolveUseCommands(conn, {
    fromWorkspace: scope !== vscode.ConfigurationTarget.Global,
    isTrusted,
  });
  const notice = stripNotices.notice('connection', conn.name, stripped);
  if (notice) {
    logger().warn(`connect: ${notice}`);
  }
  return { ...rest, use: commands, scope };
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
      const entry = toConnectionEntry(c, scope, isTrusted);
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
 * so settings.json does not accumulate empty properties, and `scope` and `use`
 * — which describe where an entry came from and what the trust gate made of
 * it, and are not part of the stored shape — never reach the record. `use` in
 * particular must not: writing the RESOLVED commands back would persist a
 * trust decision into settings, so editing a connection in an untrusted
 * workspace would erase the very commands it was only supposed to ignore.
 * That is also why the edit menu merges onto the STORED record rather than
 * onto a `ConnectionEntry`, which no longer carries the raw fields at all.
 *
 * The overloads enforce that creating a connection from nothing
 * (base=undefined) requires providing mandatory fields in the patch.
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
  const { scope: _scope, use: _use, ...merged } = { ...(base ?? {}), ...patch };
  const record: Record<string, unknown> = merged;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record as unknown as SavedConnection;
}

/**
 * Secret-storage key for a connection's password.
 *
 * Bound to the display NAME as well as host:port — all three, which is easy to
 * misread from the shape of the string. That matters because every read and
 * every delete derives the key from the entry as it stands right now, so
 * changing any of the three renames the key out from under a stored password.
 * See `secretMigration`, which is what keeps that from stranding one.
 */
export function secretKeyFor(conn: { name: string; host: string; port?: number }): string {
  return `remoteVnc:${conn.name}@${conn.host}:${conn.port ?? DEFAULT_PORT}`;
}

/**
 * The key move an edit implies, or undefined when the edit does not touch the
 * key.
 *
 * Without this, editing a connection's name, host or port left its password
 * under the old key: the connection no longer offered it, "Forget Password"
 * computed the new key and so could not see it, and deleting the entry deleted
 * the new key — leaving the real password in the OS keyring with nothing in the
 * UI able to reach it again.
 *
 * Compares the derived keys rather than the fields, so the default-port case
 * falls out for free: an omitted port and an explicit 5900 are the same
 * address, and moving a secret between two names for it would be a no-op that
 * could still fail halfway.
 */
export function secretMigration(
  before: { name: string; host: string; port?: number },
  after: { name: string; host: string; port?: number }
): { from: string; to: string } | undefined {
  const from = secretKeyFor(before);
  const to = secretKeyFor(after);
  return from === to ? undefined : { from, to };
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
