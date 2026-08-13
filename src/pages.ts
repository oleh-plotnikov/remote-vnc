import * as vscode from 'vscode';

import { logger } from './log';
import {
  StripNoticeLog,
  resolveUseCommands,
  type UseCommands,
  type UseCommandsSource,
} from './useCommands';

/** A saved web page opened in a clean editor tab (e.g. design mockups). */
export interface SavedPage extends UseCommandsSource {
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
  /**
   * Render this page as a live mirror of a real Chrome tab instead of an
   * iframe. Costs a Chrome process and makes the tab a picture rather than a
   * document (no text selection, no in-page find) — in exchange the pixels are
   * ours, so screenshot and recording work. Opt-in per page for that reason.
   */
  mirror?: boolean;
}

/**
 * A saved page plus the configuration scope it is defined in.
 *
 * `Omit`, not `extends SavedPage`: the raw command fields are deliberately NOT
 * on this type. `use` below is the trust-gated result, and it is the only way
 * to reach a command — a caller that could still read `entry.preUseCommand`
 * would be one refactor away from executing a command this build decided to
 * drop.
 */
export interface PageEntry
  extends Omit<SavedPage, 'preUseCommand' | 'postUseCommand' | 'preUseTimeout'> {
  scope: vscode.ConfigurationTarget;
  use: UseCommands;
}

/** First-occurrence-only reporting for commands the trust gate dropped. */
const stripNotices = new StripNoticeLog();

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
        // The strip site. preUseCommand/postUseCommand are ARBITRARY SHELL
        // COMMANDS read out of settings, and `remoteVnc.pages` is
        // workspace-settable on purpose — so without this a cloned repository
        // could ship a command that runs the moment one of its saved pages is
        // opened. Workspace Trust is the gate (the same one `tasks.json` uses)
        // because machine scope, the fix `remoteVnc.chromePath` got for this
        // same class of defect, would break the legitimate case this feature
        // was written for: entries kept in a `.code-workspace`. Do not lift
        // these fields straight off `p` — the scope is the only thing that
        // tells a command the user wrote from one a repository shipped, and
        // this is the only place it is known.
        const { commands, stripped } = resolveUseCommands(p, {
          fromWorkspace: scope !== vscode.ConfigurationTarget.Global,
          isTrusted,
        });
        const notice = stripNotices.notice('page', p.name, stripped);
        if (notice) {
          logger().warn(`page: ${notice}`);
        }
        byName.set(p.name, {
          name: p.name,
          url: p.url,
          ...size,
          ...(p.mirror === true ? { mirror: true as const } : {}),
          use: commands,
          scope,
        });
      }
    }
  }
  return [...byName.values()];
}

/**
 * Merge a wizard's patch onto a saved page.
 *
 * The same reasoning as `applyConnectionEdit` (src/connections.ts), and the
 * same defect it was written to fix: a dialog only knows the fields it asks
 * about, so rebuilding the record from a literal deletes every other one. The
 * page editor did exactly that and silently dropped `mirror`; with commands in
 * the schema it would silently drop those too, which for a field the user had
 * to be trusted to set is a worse loss than a flag.
 *
 * A key present in `patch` with the value `undefined` clears that field (the
 * canvas "Auto" answer removes width/height); a key absent from `patch` is
 * inherited from `base`. Keys are dropped rather than written as `undefined`
 * so settings.json does not accumulate empty properties, and `scope` and `use`
 * — which describe where an entry came from and what the trust gate made of
 * it, and are not part of the stored shape — never reach the record. `use` in
 * particular must not: writing the RESOLVED commands back would persist a trust
 * decision into settings, so editing a page in an untrusted workspace would
 * erase the very commands it was only supposed to ignore, and `scope` would
 * land in settings.json as a stray number. `editPage` passes the STORED record
 * today and so cannot hit either, but the strip is what keeps that true of the
 * next caller — this is the same defect `applyConnectionEdit` was given its own
 * strip for.
 */
export function applyPageEdit(
  base: PageEntry | SavedPage | undefined,
  patch: Partial<SavedPage> & { name: string; url: string }
): SavedPage {
  const { scope: _scope, use: _use, ...merged } = { ...(base ?? {}), ...patch } as Record<string, unknown>;
  const record: Record<string, unknown> = merged;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record as unknown as SavedPage;
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
