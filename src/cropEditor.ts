import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { brandIconPath } from './brandIcon';
import { logger } from './log';
import { pngBytesFromDataUrl, pngSize } from './screenshot';
import {
  CropRect,
  MAX_CROP_DATAURL_CHARS,
  acceptCrop,
  bytesEqual,
  isStagedPath,
} from './screenshotCrop';
import { saveCaptureBytes } from './captureSave';

/**
 * The crop editor: the tab a screenshot opens into, where a rectangle dragged
 * over the picture becomes the file.
 *
 * It is a `CustomReadonlyEditorProvider` because "readonly" is VS Code's word
 * for "this provider has no dirty state and no editor-mediated save", not for
 * "does not write" — the provider writes the file itself, which is precisely
 * what Crop does. A plain `WebviewPanel` was rejected: it is not the file's own
 * tab, and surviving a window reload would need a panel serializer plus an
 * explicit `onWebviewPanel:` activation event, where the custom-editor
 * extension point generates its activation event for free.
 *
 * Nothing arriving from the webview is trusted with the disk. The webview cuts
 * the pixels and posts an image; the rectangle rides along as a cross-check,
 * never as an instruction, and every payload passes a length bound, a PNG
 * header read and `acceptCrop` before a byte is written.
 */

/** Contributed for `*.png` at `priority: "option"`, so the built-in image
 *  preview keeps every PNG it already owns and this editor is reached
 *  deliberately — by our own `vscode.openWith`, or by Reopen Editor With…. */
export const CROP_VIEW_TYPE = 'remoteVnc.crop';

/** The built-in image preview, behind the footer's "Open as Image". */
const IMAGE_PREVIEW_VIEW_TYPE = 'imagePreview.previewEditor';

export function registerCropEditor(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.window.registerCustomEditorProvider(
    CROP_VIEW_TYPE,
    new CropEditorProvider(context),
    // These are `WebviewPanelOptions` and nothing else — there is no
    // `enableScripts` and no `localResourceRoots` at this level; those belong
    // to the webview and are set in resolveCustomEditor.
    { webviewOptions: { retainContextWhenHidden: true } }
  );
}

/**
 * Open a PNG in the crop editor, reporting whether it worked so a caller with
 * somewhere else to go — the capture flow, which can still fall back to
 * `vscode.open` — is not left with a tab that never appeared.
 */
export async function openInCropEditor(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, CROP_VIEW_TYPE);
    return true;
  } catch (err) {
    logger().error(
      `crop: could not open ${uri.fsPath} in the crop editor — ${describeError(err)}`
    );
    return false;
  }
}

/**
 * The `Crop Image…` command. It takes no argument and resolves its own target
 * from the active tab, which is what lets one command serve the palette, the
 * editor-title button and a keybinding alike.
 */
export async function cropActiveImage(): Promise<void> {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri =
    input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText
      ? input.uri
      : undefined;
  if (!uri || !uri.path.toLowerCase().endsWith('.png')) {
    void vscode.window.showInformationMessage(
      'Remote VNC: open a PNG first, then run Crop Image….'
    );
    return;
  }
  if (!(await openInCropEditor(uri))) {
    void vscode.window.showWarningMessage(
      'Remote VNC: could not open the crop editor. See the "Remote VNC" output for details.'
    );
  }
}

/**
 * What one open crop tab knows. `original` is the file as it was when the tab
 * opened and is never replaced — it is the entire undo history, which is why
 * closing the tab is what discards it. `current` is what the tab is showing and
 * therefore what the disk must still contain for a write to be safe.
 */
interface CropEntry {
  uri: vscode.Uri;
  original: Uint8Array;
  current: Uint8Array;
  width: number;
  height: number;
  staged: boolean;
  cropped: boolean;
  saving: boolean;
  confirmed: boolean;
}

/** The document is the URI and nothing more: every mutable thing belongs to the
 *  tab looking at the file, not to the file. */
class CropDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    /* nothing owned here — the panel entry holds the bytes */
  }
}

class CropEditorProvider implements vscode.CustomReadonlyEditorProvider<CropDocument> {
  /** Open tabs by document URI. Each entry pins the capture twice over, so
   *  dropping it on dispose is how those megabytes are released. */
  private readonly entries = new Map<string, CropEntry>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * No I/O, and nothing here can throw. A URI replayed by a window reload after
   * the 7-day sweep removed the capture must not leave a tab that can never
   * open at all; a missing file is a state this editor draws, so the read waits
   * for resolveCustomEditor, where there is a webview to say it in.
   */
  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): CropDocument {
    // `backupId` and `untitledDocumentData` are ignored on purpose: a readonly
    // provider is never dirty, so there is no hot-exit state to restore.
    return new CropDocument(uri);
  }

  async resolveCustomEditor(
    document: CropDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    // Content options have to be set here rather than at registration: VS Code
    // starts custom-editor webviews with empty ones. The roots must not be `[]`
    // either — that silently blocks cropEditor.js and cropEditor.css and leaves
    // a blank tab with no error anywhere.
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewPanel.iconPath = brandIconPath(this.context.extensionUri);

    const key = document.uri.toString();
    let entry: CropEntry | undefined;
    let disposed = false;
    // Registered before the read, not after it. A tab closed while a
    // multi-megabyte capture is still coming off a remote filesystem would
    // otherwise have its dispose listener attached to an emitter that has
    // already fired: the listener never runs, and the entry — with the two
    // copies of the capture it pins — stays in the map for the life of the
    // window. Guard by identity so a stale dispose cannot release a newer
    // tab's bytes.
    webviewPanel.onDidDispose(() => {
      disposed = true;
      if (entry && this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    });

    // Everything below assigns `webview.html` last, after its listener is
    // attached. The page's module ends by posting 'ready', VS Code does not
    // buffer a message that arrives before a listener exists, and the read
    // between here and there is an `await` — so setting the HTML first would
    // race the page's only request for its pixels against a file read that is
    // an IPC round trip of its own. Losing that race is a blank tab with
    // nothing in any log to say why.
    const bytes = await readBytes(document.uri);
    if (disposed) {
      // The tab went away while the capture was being read. Assigning
      // `webview.html` now throws "Webview is disposed", and there is nothing
      // left to draw into anyway.
      return;
    }
    const size = bytes && pngSize(bytes);
    if (!bytes || !size) {
      // Drawn in the tab, never as a blank canvas and never as a bare toast.
      // The failure state keeps no state of its own, so it answers only the two
      // messages that still make sense.
      const reason = bytes
        ? 'This file is not a PNG the crop editor can read.'
        : 'This capture is no longer available.';
      const dead: CropExtensionMessage = { type: 'unavailable', reason };
      logger().error(`crop: ${reason} (${document.uri.fsPath})`);
      webview.onDidReceiveMessage((msg: CropWebviewMessage) => {
        if (!isWebviewMessage(msg)) {
          return;
        }
        if (msg.type === 'ready') {
          void webview.postMessage(dead);
        } else if (msg.type === 'reopen') {
          void vscode.commands.executeCommand(
            'vscode.openWith',
            document.uri,
            IMAGE_PREVIEW_VIEW_TYPE
          );
        }
      });
      webview.html = renderCropHtml(webview, this.context.extensionUri);
      return;
    }

    const staging = vscode.Uri.joinPath(this.context.globalStorageUri, 'recordings');
    const open: CropEntry = {
      uri: document.uri,
      original: bytes,
      current: bytes,
      width: size.width,
      height: size.height,
      staged: isStagedPath(key, staging.toString()),
      cropped: false,
      saving: false,
      confirmed: false,
    };
    entry = open;
    this.entries.set(key, open);
    // The captured `webview`, never `webviewPanel.webview`: that getter asserts
    // the panel is alive, and every handler below can still be running its
    // awaits when the tab closes. A postMessage to a dead webview resolves
    // false, which is the outcome we want; a throw out of a `void`-ed handler
    // is an unhandled rejection nobody sees.
    webview.onDidReceiveMessage((msg: CropWebviewMessage) => {
      if (!isWebviewMessage(msg)) {
        return;
      }
      void this.onMessage(webview, open, msg);
    });
    webview.html = renderCropHtml(webview, this.context.extensionUri);
    logger().info(
      `crop: opened ${basename(open.uri)} (${size.width}x${size.height}` +
        `${open.staged ? ', staged' : ''})`
    );
  }

  private async onMessage(
    webview: vscode.Webview,
    entry: CropEntry,
    msg: CropWebviewMessage
  ): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Idempotent: the host holds the payload, so a reloaded webview re-fires
        // this and the tab heals with no extra host state. The `pendingConnect`
        // idiom of src/vncPanel.ts, minus the one-shot.
        void webview.postMessage(imageMessage(entry));
        return;
      case 'crop':
      case 'revert':
        // One flag for both, because both write the same file. It stands in for
        // disabling the buttons, so a write that fails cannot strand a button
        // in the webview with no route back.
        if (entry.saving) {
          logger().info('crop: a write is already in flight; ignoring this request.');
          return;
        }
        entry.saving = true;
        try {
          if (msg.type === 'crop') {
            await this.applyCrop(webview, entry, msg);
          } else {
            await this.applyRevert(webview, entry);
          }
        } finally {
          entry.saving = false;
        }
        return;
      case 'save': {
        // No dialog when remoteVnc.screenshotDirectory is set: that is the
        // established contract of the setting, here as everywhere else.
        const name = basename(entry.uri);
        await saveCaptureBytes(entry.current, name, { 'PNG image': ['png'] }, 'crop', name);
        return;
      }
      case 'reopen':
        await vscode.commands.executeCommand(
          'vscode.openWith',
          entry.uri,
          IMAGE_PREVIEW_VIEW_TYPE
        );
        return;
      case 'log':
        if (msg.level === 'error') {
          logger().error(`crop: ${msg.message}`);
        } else {
          logger().info(`crop: ${msg.message}`);
        }
        return;
    }
  }

  /**
   * The guarded write. The order is the point: the refusals that cost nothing
   * come first, the modal appears only once the payload itself has checked out
   * — nobody should be asked to approve a crop that was going to be rejected —
   * and the disk is touched last of all.
   */
  private async applyCrop(
    webview: vscode.Webview,
    entry: CropEntry,
    msg: Extract<CropWebviewMessage, { type: 'crop' }>
  ): Promise<void> {
    if (msg.error) {
      refuseCrop(`the webview reported "${msg.error}"`);
      return;
    }
    const dataUrl = msg.dataUrl;
    // A type check, not a falsy check: the TypeScript signature is a
    // compile-time hint about a value that crossed postMessage, exactly as
    // `recordingBytes` says of its own input. A truthy non-string clears a
    // falsy check and clears the length bound too (`(5).length > n` is false),
    // and then `pngBytesFromDataUrl` throws on `.startsWith` — out of a
    // `void`-ed handler, so the user would press Crop and get nothing at all:
    // no toast, no Output line.
    if (typeof dataUrl !== 'string' || !dataUrl) {
      refuseCrop('the message carried no data URL');
      return;
    }
    // Bounded before Buffer.from runs, not after: a cap on the decoded bytes is
    // not a cap, because the allocation it exists to prevent is already made.
    if (dataUrl.length > MAX_CROP_DATAURL_CHARS) {
      refuseCrop(`the data URL is ${dataUrl.length} characters, over the limit`);
      return;
    }
    const bytes = pngBytesFromDataUrl(dataUrl);
    if (!bytes) {
      refuseCrop('the payload is not a base64 PNG data URL');
      return;
    }
    const out = pngSize(bytes);
    if (!out) {
      refuseCrop('the decoded bytes carry no PNG header');
      return;
    }
    const rect = acceptCrop(msg.rect, entry.width, entry.height, out.width, out.height);
    if (!rect) {
      refuseCrop(
        `a ${out.width}x${out.height} image does not match the rectangle claimed against ` +
          `a ${entry.width}x${entry.height} source`
      );
      return;
    }
    if (!(await this.consentToOverwrite(entry))) {
      return;
    }
    if (!(await this.stillOurs(entry))) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(entry.uri, bytes);
    } catch (err) {
      logger().error(`crop: could not write ${entry.uri.fsPath} — ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        `Remote VNC: could not write the cropped image — ${describeError(err)}.`
      );
      return;
    }
    entry.current = bytes;
    entry.width = out.width;
    entry.height = out.height;
    entry.cropped = true;
    logger().info(
      `crop: ${basename(entry.uri)} cropped to ${rect.width}x${rect.height} at ${rect.x},${rect.y}`
    );
    // The file changed, so the tab has to show the new pixels — unlike a
    // non-destructive editor, this re-post is required rather than tidy.
    void webview.postMessage(imageMessage(entry));
  }

  /**
   * Revert is the whole undo history: the bytes read when the tab opened. It
   * goes through the same staleness check as Crop, because putting an old image
   * back over a file something else has since replaced is the same accident
   * running the other way.
   */
  private async applyRevert(webview: vscode.Webview, entry: CropEntry): Promise<void> {
    const size = pngSize(entry.original);
    if (!size) {
      // Unreachable: an entry exists only because pngSize accepted these bytes.
      // Worded for Revert rather than routed through refuseCrop, which speaks
      // about a payload the webview posted — there is no payload here.
      logger().error('crop: the bytes read when the tab opened are no longer a readable PNG.');
      void vscode.window.showWarningMessage('Remote VNC: could not restore the original image.');
      return;
    }
    if (!(await this.stillOurs(entry))) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(entry.uri, entry.original);
    } catch (err) {
      logger().error(`crop: could not restore ${entry.uri.fsPath} — ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        `Remote VNC: could not restore the original image — ${describeError(err)}.`
      );
      return;
    }
    entry.current = entry.original;
    entry.width = size.width;
    entry.height = size.height;
    entry.cropped = false;
    logger().info(`crop: ${basename(entry.uri)} reverted to ${size.width}x${size.height}`);
    void webview.postMessage(imageMessage(entry));
  }

  /**
   * Reopen Editor With… puts this editor on any PNG in the workspace, and
   * silently overwriting one of those is not acceptable. Consent belongs to the
   * tab and dies with it, so the same file reaching a second tab is asked about
   * again. A staged capture is never asked about — `isStagedPath` is the single
   * predicate deciding that, so a misclassification shows up here and in the
   * save dialog's starting directory at once instead of leaving a quiet hole.
   */
  private async consentToOverwrite(entry: CropEntry): Promise<boolean> {
    if (entry.staged || entry.confirmed) {
      return true;
    }
    const name = basename(entry.uri);
    const choice = await vscode.window.showWarningMessage(
      `Remote VNC: overwrite ${name} with the cropped image?`,
      {
        modal: true,
        detail: 'The file is replaced in place. Revert undoes it only while this tab stays open.',
      },
      'Overwrite'
    );
    if (choice !== 'Overwrite') {
      logger().info(`crop: overwrite of ${name} declined.`);
      return false;
    }
    entry.confirmed = true;
    return true;
  }

  /**
   * Whether the disk still holds what this tab is showing.
   *
   * A name collision is not the only way a file moves under an open tab — a
   * sync client, another editor or a restored backup all do it too, and none of
   * them announce themselves — so the check is a byte comparison against the
   * bytes the tab last read or wrote, not a check of the name or the mtime.
   *
   * A file that is *gone* refuses the same way but must not be worded the same.
   * The 7-day sweep runs un-awaited at startup (src/extension.ts), so a window
   * reload can restore a tab onto a capture the sweep is about to delete: this
   * tab is then holding the last copy of that image, and telling its owner to
   * reopen the tab would be telling them to throw it away. Save still works.
   */
  private async stillOurs(entry: CropEntry): Promise<boolean> {
    const onDisk = await readBytes(entry.uri);
    if (onDisk && bytesEqual(onDisk, entry.current)) {
      return true;
    }
    const gone = !onDisk;
    logger().error(
      `crop: ${entry.uri.fsPath} ${gone ? 'is gone' : 'changed outside the crop editor'};` +
        ' nothing written.'
    );
    void vscode.window.showWarningMessage(
      gone
        ? 'Remote VNC: this file is gone — the staged copy was removed. Save keeps the image ' +
            'this tab is still showing; closing the tab discards it.'
        : 'Remote VNC: this file changed outside the crop editor; reopen it to crop the current image.'
    );
    return false;
  }
}

/**
 * The two halves of the protocol, hand-kept on both sides — this repo has no
 * shared protocol module, and `media/cropEditor.ts` mirrors the inbound half at
 * its top. Bytes cross as an `ArrayBuffer` rather than through `asWebviewUri`:
 * `globalStorageUri` is not in the default `localResourceRoots`, so the editor
 * works for any path on any filesystem provider and the webview is never handed
 * a filesystem URI.
 *
 * `ArrayBuffer` and not `Uint8Array`, and the difference is the whole payload
 * rather than a detail — see `toArrayBuffer`.
 */
type CropExtensionMessage =
  | {
      type: 'image';
      bytes: ArrayBuffer;
      width: number;
      height: number;
      name: string;
      staged: boolean;
      cropped: boolean;
    }
  | { type: 'unavailable'; reason: string };

type CropWebviewMessage =
  | { type: 'ready' }
  | { type: 'crop'; rect?: CropRect; dataUrl?: string; error?: string }
  | { type: 'revert' }
  | { type: 'save' }
  | { type: 'reopen' }
  | { type: 'log'; level: 'info' | 'error'; message: string };

function renderCropHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'cropEditor.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'cropEditor.css')
  );

  // No connect-src at all: the cropper talks to nobody, and the bytes it draws
  // arrive by postMessage. `blob:` is the only image source it needs, because
  // the decode goes through a Blob rather than a data URL.
  const csp = [
    `default-src 'none'`,
    `img-src blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Crop</title>
</head>
<body>
  <header id="bar" class="bar">
    <span id="srcsize" class="srcsize"></span>
    <span id="readout" class="readout"></span>
    <span id="badge" class="badge" hidden></span>
  </header>
  <div id="stage" class="stage" tabindex="0" data-state="empty">
    <div id="frame" class="frame">
      <canvas id="view"></canvas>
      <div id="scrim-top" class="scrim"></div>
      <div id="scrim-bottom" class="scrim"></div>
      <div id="scrim-left" class="scrim"></div>
      <div id="scrim-right" class="scrim"></div>
      <div id="sel" class="sel" hidden></div>
    </div>
  </div>
  <div id="dead" class="dead" hidden></div>
  <footer id="foot" class="foot">
    <button id="crop" class="btn primary" disabled>Crop</button>
    <button id="revert" class="btn"
      title="Restore the image this tab opened with. Closing the tab discards this undo."
      disabled>Revert</button>
    <button id="save" class="btn">Save</button>
    <button id="reopen" class="btn">Open as Image</button>
    <span id="hint" class="hint"></span>
  </footer>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** The 'image' payload for what the tab currently holds. Derived rather than
 *  stored, so a write cannot update the entry and forget the message. */
function imageMessage(entry: CropEntry): CropExtensionMessage {
  return {
    type: 'image',
    bytes: toArrayBuffer(entry.current),
    width: entry.width,
    height: entry.height,
    name: basename(entry.uri),
    staged: entry.staged,
    cropped: entry.cropped,
  };
}

/**
 * The capture as a standalone `ArrayBuffer`, which is the only binary shape the
 * webview transport is documented to put back together.
 *
 * `Webview.postMessage` (vscode.d.ts) promises that an `ArrayBuffer` appearing
 * in a message is "correctly recreated inside of the webview" from 1.57 on, and
 * says of a TypedArray — which is exactly what `workspace.fs.readFile` returns
 * — that it "will be very inefficiently serialized and will also not be
 * recreated as a typed array inside the webview". Sending the `Uint8Array`
 * directly therefore delivers a plain index object; `new Blob([…])` stringifies
 * that to "[object Object]", and the tab dies reporting a file it cannot
 * decode, naming the file rather than the cause.
 *
 * The copy is not incidental either. `bytes.buffer` can be a window onto a
 * larger allocation — Node pools small buffers — so handing it over would send
 * whatever else shares the pool. `Buffer.prototype.slice` is no way out: unlike
 * `Uint8Array`'s, it returns a view rather than a copy.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** The shape guard the webview's own listener already applies to what we send
 *  it (media/cropEditor.ts). A bare `null` or a message with no discriminant
 *  would otherwise throw on `msg.type` inside a `void`-ed handler, where the
 *  rejection reaches neither a toast nor the Output channel. */
function isWebviewMessage(msg: CropWebviewMessage): boolean {
  return !!msg && typeof msg.type === 'string';
}

/** One generic toast, the step that failed in the Output channel — the posture
 *  the rest of the extension already takes towards webview payloads. */
function refuseCrop(detail: string): void {
  logger().error(`crop: refused — ${detail}.`);
  void vscode.window.showWarningMessage(
    'Remote VNC: the crop editor returned no usable PNG data.'
  );
}

/** File bytes, or undefined when they cannot be read: the missing file is a
 *  state this editor renders, so absence travels as a value, not a throw. */
async function readBytes(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    logger().error(`crop: cannot read ${uri.fsPath} — ${describeError(err)}`);
    return undefined;
  }
}

/** The last path segment, taken from `path` rather than `fsPath` so a virtual
 *  filesystem provider answers the same as a local disk. */
function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
