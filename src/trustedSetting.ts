/**
 * Resolving a setting the way VS Code would, minus the layers an untrusted
 * workspace is not allowed to supply.
 *
 * `remoteVnc.connections` and `remoteVnc.pages` already do this for themselves
 * (see collectConnections/collectPages): in an untrusted window, entries that
 * came from workspace or folder settings are dropped and only user-level ones
 * are offered. The capture settings needed the same rule for a sharper reason —
 * `screenshotAction: 'save'` removes the save dialog and `screenshotDirectory`
 * names the destination, so between them a `.vscode/settings.json` in a cloned
 * repository could route screenshots of a live VNC session into a directory
 * inside that repository, with nothing shown to the user.
 *
 * Declaring these `"scope": "machine"` in package.json would also stop it, but
 * by taking per-project configuration away from workspaces that ARE trusted.
 * Trust is the axis that actually matters here, and it is the one the rest of
 * the extension already uses.
 */

import * as vscode from 'vscode';

import { logger } from './log';

/** The shape `vscode.WorkspaceConfiguration.inspect` returns, as much as is used here. */
export interface InspectedSetting<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * The effective value, and whether a workspace-supplied one was discarded to
 * get it — the caller logs that, because a setting silently not taking effect
 * is worse than one that never existed.
 *
 * `in` rather than `??`, deliberately: `screenshotDirectory` defaults to `''`
 * and booleans default to `false`, so a present-but-falsy layer is a real
 * answer and must beat the layer below it.
 */
export function trustedSetting<T>(
  inspected: InspectedSetting<T> | undefined,
  isTrusted: boolean
): { value: T | undefined; ignored: boolean } {
  if (!inspected) {
    return { value: undefined, ignored: false };
  }
  const fromWorkspace =
    'workspaceFolderValue' in inspected && inspected.workspaceFolderValue !== undefined
      ? { value: inspected.workspaceFolderValue }
      : 'workspaceValue' in inspected && inspected.workspaceValue !== undefined
        ? { value: inspected.workspaceValue }
        : undefined;

  if (fromWorkspace && isTrusted) {
    return { value: fromWorkspace.value, ignored: false };
  }
  const value =
    inspected.globalValue !== undefined ? inspected.globalValue : inspected.defaultValue;
  return { value, ignored: fromWorkspace !== undefined };
}

/**
 * Read one setting through that rule, logging when a workspace value is
 * dropped.
 *
 * The log line is not decoration: a setting that silently does not take effect
 * is harder to diagnose than one that was never written, and the workspace that
 * wrote it may well have been the user's own — trusting the folder is one
 * click away, and the message is what tells them that is the click.
 */
export function trustedConfig<T>(section: string, key: string, fallback: T): T {
  const inspected = vscode.workspace.getConfiguration(section).inspect<T>(key);
  const { value, ignored } = trustedSetting<T>(inspected, vscode.workspace.isTrusted);
  if (ignored) {
    logger().warn(
      `${section}.${key} from this workspace's settings was ignored — the workspace is not ` +
        'trusted. Trust it (Workspaces: Manage Workspace Trust) or set the value in your user settings.'
    );
  }
  return value ?? fallback;
}
