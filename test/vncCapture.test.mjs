// Unit tests for VncSession's registry-facing methods (panelRegistry's
// screenshot/record/recordStop/reload for a VNC session), constructed
// directly rather than through VncSessionManager.connect() — connect() opens
// a real TCP bridge, which this harness cannot provide. VncSession itself
// only needs a fake webview panel, a fake bridge and a fake ExtensionContext,
// none of which touch the network.
import { load } from './bundle.mjs';

function fakePanel() {
  let messageHandler;
  const webview = {
    html: '',
    cspSource: 'vscode-webview:',
    asWebviewUri: (uri) => uri,
    postMessage: async () => true,
    onDidReceiveMessage: (cb) => {
      messageHandler = cb;
      return { dispose() {} };
    },
  };
  const disposeCallbacks = [];
  const panel = {
    webview,
    title: '',
    iconPath: undefined,
    reveal: () => {},
    onDidDispose: (cb) => {
      disposeCallbacks.push(cb);
      return { dispose() {} };
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    dispose: () => {
      for (const cb of disposeCallbacks.splice(0)) cb();
    },
  };
  // send() simulates the webview posting a message back to the extension
  // host — the inverse direction of postMessage above.
  return { panel, send: (msg) => messageHandler(msg) };
}

function fakeContext() {
  return {
    extensionUri: { scheme: 'file', authority: '', path: '/ext' },
    globalStorageUri: { scheme: 'file', authority: '', path: '/storage' },
  };
}

function makeSession(VncSession) {
  const { panel, send } = fakePanel();
  const session = new VncSession({
    request: { host: '127.0.0.1', port: 5900, label: 'kiosk', autoReconnect: false, parkServerCursor: false },
    panel,
    connector: async () => {
      throw new Error('connector should not be called in this test');
    },
    bridge: { onClosed: () => {}, dispose: () => {} },
    clientUrl: 'ws://127.0.0.1:5555/',
    options: {},
    context: fakeContext(),
    onStatus: () => {},
    onRecordingChange: () => {},
  });
  return { session, send };
}

export default async function ({ ok, eq }) {
  const { VncSession } = await load('vncPanel.ts');
  const { controlErrorStatus } = await load('controlRoutes.ts');
  const pngDataUrl = (byte) => `data:image/png;base64,${Buffer.from([byte]).toString('base64')}`;
  const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

  // reset injectable stub state between sections
  globalThis.__config = undefined;
  globalThis.__fsWrites = [];

  // --- Ruling 1: a session's reload() rejects; it must never reconnect ---
  {
    const { session } = makeSession(VncSession);
    try {
      await session.reload();
      ok(false, 'session.reload() should reject, not resolve');
    } catch (err) {
      eq(err.message, 'reload applies to page targets only', 'session reload rejects with the exact message');
      // Asking a session to reload is the caller's category error, so the
      // control server answers 400, not 500. Asserted against the message the
      // session actually throws (not a copy of it) so a reword cannot silently
      // drop this back to a "retry me" 500.
      eq(controlErrorStatus(err.message), 400, "a session's reload rejection maps to HTTP 400");
    }
  }

  // --- Ruling 2: screenshot() never opens a dialog ---
  // The stub's vscode.window.showSaveDialog/showInformationMessage/
  // showWarningMessage all THROW unless a test opts in via
  // globalThis.__dialogsEnabled (see test/bundle.mjs) — untouched here, so if
  // the code under test tried to call one, this would throw instead of
  // silently resolving. A clean resolve is itself proof no dialog was
  // attempted.
  {
    const { session, send } = makeSession(VncSession);
    globalThis.__config = undefined; // no remoteVnc.screenshotDirectory configured
    globalThis.__fsWrites = [];

    const shot = session.captureScreenshot();
    send({ type: 'screenshot', dataUrl: pngDataUrl(1) });
    const path = await shot;

    ok(path.startsWith('/storage/captures/'), `unset screenshotDirectory lands under globalStorage/captures (got ${path})`);
    ok(path.endsWith('.png'), 'screenshot path ends in .png');
    eq(globalThis.__fsWrites.length, 1, 'exactly one file written for the screenshot');
  }

  // configured screenshotDirectory is honoured, still with no dialog
  {
    const { session, send } = makeSession(VncSession);
    globalThis.__config = { remoteVnc: { screenshotDirectory: '/configured/shots' } };
    globalThis.__fsWrites = [];

    const shot = session.captureScreenshot();
    send({ type: 'screenshot', dataUrl: pngDataUrl(2) });
    const path = await shot;

    ok(path.startsWith('/configured/shots/'), `configured screenshotDirectory is honoured (got ${path})`);
  }

  // a failed capture rejects instead of hanging
  {
    const { session, send } = makeSession(VncSession);
    globalThis.__config = undefined;
    const shot = session.captureScreenshot();
    send({ type: 'screenshot', error: 'webview capture failed' });
    try {
      await shot;
      ok(false, 'a failed screenshot should reject');
    } catch (err) {
      eq(err.message, 'webview capture failed', 'screenshot rejection carries the webview error');
    }
  }

  // --- Ruling 2: recordStop() never opens a dialog either ---
  {
    const { session, send } = makeSession(VncSession);
    globalThis.__config = undefined;
    globalThis.__fsWrites = [];

    const started = session.captureStartRecording();
    send({ type: 'record-status', recording: true });
    await started;

    const stopped = session.captureStopRecording();
    send({
      type: 'recording',
      format: 'webm',
      data: Uint8Array.from([...WEBM_MAGIC, 1, 2, 3, 4]),
      durationMs: 1500,
      reason: 'stopped',
    });
    const path = await stopped;

    ok(path.startsWith('/storage/captures/'), `unset screenshotDirectory lands under globalStorage/captures (got ${path})`);
    ok(path.endsWith('.webm'), 'recording path ends in .webm');
    eq(globalThis.__fsWrites.length, 1, 'exactly one file written for the recording');
  }

  globalThis.__config = undefined;
  globalThis.__fsWrites = undefined;
}
