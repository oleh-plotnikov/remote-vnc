import * as vscode from 'vscode';
import * as os from 'os';
import { expandHome } from './screenshot';
import { logger } from './log';

/**
 * Writing a capture out to where the user keeps files.
 *
 * This was a private method on `VncSession` while the session was the only
 * thing that produced captures. The crop editor's footer `Save` does exactly
 * the same job for the image its tab is holding, so the body moved here rather
 * than being written a second time: the destination policy — silent into
 * `remoteVnc.screenshotDirectory` when it is set, a save dialog otherwise — is
 * a promise the setting makes to the user, and two copies of it would drift the
 * first time either call site grew a case the other did not.
 */

/**
 * Save `bytes` as `name`, returning where they landed, or undefined when the
 * dialog was cancelled or the write failed.
 *
 * `label` only words the messages — it is the connection's name on the session
 * path and the file's own name in the crop editor, where there is no
 * connection to speak of. The configured directory is created if missing; a
 * directory that cannot be used is logged and falls through to the dialog
 * rather than failing the save outright.
 */
export async function saveCaptureBytes(
  bytes: Uint8Array,
  name: string,
  filters: Record<string, string[]>,
  kind: 'screenshot' | 'recording' | 'crop',
  label: string,
  note = ''
): Promise<vscode.Uri | undefined> {
  const configured = vscode.workspace
    .getConfiguration('remoteVnc')
    .get<string>('screenshotDirectory', '')
    .trim();
  let uri: vscode.Uri | undefined;
  if (configured) {
    const dir = vscode.Uri.file(expandHome(configured, os.homedir()));
    try {
      await vscode.workspace.fs.createDirectory(dir);
      uri = vscode.Uri.joinPath(dir, name);
    } catch (err) {
      logger().warn(
        `${kind}: cannot use remoteVnc.screenshotDirectory "${configured}" — ${describeError(err)}; asking instead`
      );
    }
  }
  if (!uri) {
    uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${os.homedir()}/${name}`),
      filters,
    });
    if (!uri) {
      return undefined; // cancelled
    }
  }
  try {
    await vscode.workspace.fs.writeFile(uri, bytes);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Remote VNC (${label}): could not save the ${kind} — ${describeError(err)}.`
    );
    return undefined;
  }
  logger().info(`${kind} saved (${label}) -> ${uri.fsPath}`);
  const choice = await vscode.window.showInformationMessage(
    `Remote VNC: ${kind} saved${note} — ${name}`,
    'Open'
  );
  if (choice === 'Open') {
    void vscode.commands.executeCommand('vscode.open', uri);
  }
  return uri;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
