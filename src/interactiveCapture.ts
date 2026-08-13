import * as vscode from 'vscode';
import { trustedConfig } from './trustedSetting';
import * as os from 'os';
import { openInCropEditor } from './cropEditor';
import { saveCaptureBytes } from './captureSave';
import { stagedName } from './screenshotCrop';

/**
 * The interactive ending for a HUMAN-triggered capture — a keyboard chord, a
 * hotkey, a tree-row button — as opposed to the panel registry's
 * `screenshot()`/`record()`/`recordStop()`, which stay silent on purpose (no
 * dialog, no toast, just a path) because an HTTP caller cannot answer a modal
 * on a window it cannot see. See `src/panelRegistry.ts` and the "Ruling 2"
 * tests in `test/vncCapture.test.mjs` for that half of the contract.
 *
 * This file is the other half, extracted out of `VncSession` (src/vncPanel.ts)
 * once a second caller needed it verbatim: a mirrored page's capture (Task 7
 * fix round 1) must look and behave exactly like a VNC session's, and two
 * copies of "stage, open, offer Save As" were the one thing guaranteed to
 * drift the moment either grew a case the other did not — the same reasoning
 * `src/captureSave.ts`'s own header gives for the non-interactive half.
 *
 * Reads `remoteVnc.screenshotAction`/`remoteVnc.recordingAction`: `'open'`
 * stages the capture in extension storage and opens it as a tab (a screenshot
 * lands in the crop editor unless `remoteVnc.screenshotCropEditor` says
 * otherwise), anything else saves it where the user keeps files — silently
 * into `remoteVnc.screenshotDirectory` when set, a save dialog otherwise
 * (`saveCaptureBytes`).
 */
export async function interactiveSaveCapture(
  globalStorageUri: vscode.Uri,
  label: string,
  bytes: Uint8Array,
  name: string,
  filters: Record<string, string[]>,
  kind: 'screenshot' | 'recording',
  note = ''
): Promise<void> {
  const settingKey = kind === 'screenshot' ? 'screenshotAction' : 'recordingAction';
  // The other half of the pair captureSave.ts guards: 'save' is the branch
  // that writes without asking, so an untrusted workspace must not be able to
  // select it.
  const action = trustedConfig<string>('remoteVnc', settingKey, 'open');
  if (action === 'open') {
    await openCapture(globalStorageUri, label, bytes, name, filters, kind, note);
  } else {
    await saveCaptureBytes(bytes, name, filters, kind, label, note);
  }
}

/** Stage a capture in extension storage (no user folder touched) and open it
 *  as a tab; a toast offers copying it somewhere permanent. */
async function openCapture(
  globalStorageUri: vscode.Uri,
  label: string,
  bytes: Uint8Array,
  name: string,
  filters: Record<string, string[]>,
  kind: 'screenshot' | 'recording',
  note = ''
): Promise<void> {
  const dir = vscode.Uri.joinPath(globalStorageUri, 'recordings');
  let uri: vscode.Uri;
  let staged: string;
  try {
    ({ name: staged, uri } = await claimStagedName(dir, name, bytes));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Remote VNC (${label}): could not stage the ${kind} — ${describeError(err)}.`
    );
    return;
  }
  // A screenshot lands in the crop editor unless the user has said otherwise;
  // openInCropEditor answers with a boolean rather than throwing, so a tab
  // that failed to appear falls back to the built-in preview instead of
  // leaving the capture staged and invisible. A recording is not an image and
  // keeps vscode.open.
  const cropEditor =
    kind === 'screenshot' &&
    vscode.workspace.getConfiguration('remoteVnc').get<boolean>('screenshotCropEditor', true);
  if (!cropEditor || !(await openInCropEditor(uri))) {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
  // The crop tab carries a Save of its own, about the image it is currently
  // showing; this one is the whole-image escape hatch, so the screenshot
  // wording says which is which. One const feeds both the button and the
  // comparison, because two literals that have to match eventually will not.
  const saveLabel = kind === 'screenshot' ? 'Save Full Image As…' : 'Save As…';
  const choice = await vscode.window.showInformationMessage(
    `Remote VNC: ${kind} opened, not saved${note}.`,
    saveLabel
  );
  if (choice === saveLabel) {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${os.homedir()}/${staged}`),
      filters,
    });
    if (target) {
      try {
        await vscode.workspace.fs.copy(uri, target, { overwrite: true });
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Remote VNC (${label}): could not save the ${kind} — ${describeError(err)}.`
        );
      }
    }
  }
}

/**
 * Serialises staging so that picking a free name and writing it are one step.
 *
 * Capture names carry a second-resolution timestamp (`captureFilename` in
 * src/screenshot.ts), so two captures of one label inside the same second ask
 * for the same file — and a held-down screenshot keybinding does exactly
 * that, because the interactive screenshot call is fire-and-forget. Writing
 * the same name twice would replace the image an open crop tab is showing,
 * and that tab's next Crop would put its older pixels back over the newer
 * capture. Choosing a free name is not enough on its own: two concurrent
 * calls both finish reading the directory before either writes, so both are
 * handed the same free name.
 *
 * The queue is module-level, not per-panel: one staging directory serves
 * every VNC session AND every mirrored page (Task 7), and two panels sharing
 * a label — a session and a page reusing the same name, or two windows
 * sharing global storage — stay outside it by nature; that residue is what
 * the byte comparison in the crop editor's `stillOurs` exists to catch.
 */
let stageQueue: Promise<unknown> = Promise.resolve();

async function claimStagedName(
  dir: vscode.Uri,
  name: string,
  bytes: Uint8Array
): Promise<{ name: string; uri: vscode.Uri }> {
  const claim = stageQueue.catch(() => undefined).then(async () => {
    await vscode.workspace.fs.createDirectory(dir);
    const listing = await vscode.workspace.fs.readDirectory(dir);
    const picked = stagedName(
      name,
      listing.map(([entry]) => entry)
    );
    const uri = vscode.Uri.joinPath(dir, picked);
    await vscode.workspace.fs.writeFile(uri, bytes);
    return { name: picked, uri };
  });
  // A failed stage must not poison the queue for the next capture.
  stageQueue = claim.catch(() => undefined);
  return claim;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
