// Task 7 + fix round 1: capture for mirrored pages. Unit tests for the
// registry-facing functions pagePanel.ts exports — capturePageScreenshot,
// startPageRecording, stopPageRecording, registerPageEntry's exact-message
// contract, the chord routing handleMirrorMessage does for a mirrored tab's
// webview — AND, since fix round 1, the INTERACTIVE dispatcher functions
// (takePageScreenshot, toggleRecordPage) that the focused-panel hotkeys and
// the Web Pages tree commands actually call. That second half is the
// regression test the review asked for: routing a chord into the (silent,
// no-dialog) registry methods is the exact defect this codebase already
// shipped and fixed once, on the VNC side — see the class-level comment on
// src/extension.ts's screenshotFocused for the history.
//
// openPagePanel itself is not reachable here (it needs a real WebviewPanel
// and spawns Chrome — see test/pageMirrorStream.test.mjs's own note), so a
// plain object stands in for the panel and its webview, the same idiom
// test/vncCapture.test.mjs uses for VncSession.
import { load } from './bundle.mjs';

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** A CDP session recording every method it is sent, answering with `data` for
 *  Page.captureScreenshot. */
function fakeCdp(data = PNG_BASE64) {
  const sent = [];
  return {
    sent,
    send: async (method, params, sessionId) => {
      sent.push({ method, params, sessionId });
      return method === 'Page.captureScreenshot' ? { data } : {};
    },
  };
}

function fakeEntry(cdp, over = {}) {
  const posted = [];
  return {
    panel: {
      title: 'kiosk',
      webview: {
        postMessage: async (msg) => {
          posted.push(msg);
          return true;
        },
      },
    },
    posted,
    mirror: cdp && {
      cdp,
      sessionId: 'S1',
      targetId: 'T1',
      unacked: [],
      size: { width: 800, height: 600 },
      running: false,
    },
    globalStorageUri: { scheme: 'file', authority: '', path: '/storage' },
    // A tab whose webview is loaded and listening — the only state in which
    // postMessage is delivered at all. Every case below that is not ABOUT a
    // hidden tab needs this, or it would reject on the visibility guard
    // instead of reaching the behaviour it means to assert.
    webviewLive: true,
    recording: 'idle',
    recordStartWaiters: [],
    recordStopWaiters: [],
    ...over,
  };
}

/** What a promise did, without ever awaiting it unguarded: the rejection it
 *  produced, the string 'resolved', or the string 'hung' if it had not settled
 *  by the next timer tick. A registry call that hangs forever is the failure
 *  under test, and `await`ing one directly stalls the runner itself — no
 *  assertion, no output, just a process that stops. */
const HANG_MS = 50;
function outcome(promise) {
  return Promise.race([
    promise.then(() => 'resolved', (err) => err),
    new Promise((resolve) => setTimeout(() => resolve('hung'), HANG_MS)),
  ]);
}

const describe = (result) => (result instanceof Error ? `"${result.message}"` : result);

/** Reset every injectable stub global to its safe default — called between
 *  sections and once at the top/bottom of the file, since globalThis persists
 *  across every test/*.test.mjs the runner imports in one process. */
function resetStubs() {
  globalThis.__config = undefined;
  globalThis.__fsWrites = [];
  globalThis.__executedCommands = [];
  globalThis.__dialogsEnabled = false;
  globalThis.__dialogCalls = [];
  globalThis.__dialogAnswers = undefined;
}

export default async function ({ ok, eq }) {
  const {
    capturePageScreenshot,
    startPageRecording,
    stopPageRecording,
    handleMirrorMessage,
    registerPageEntry,
    takePageScreenshot,
    toggleRecordPage,
    openPanelsById,
    getPanel,
    pageId,
  } = await load('pagePanel.ts');

  resetStubs();

  // --- screenshot: Page.captureScreenshot, not the screencast -------------
  {
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp);
    globalThis.__fsWrites = [];

    const path = await capturePageScreenshot(entry);

    eq(cdp.sent.length, 1, 'exactly one CDP call for a screenshot');
    eq(cdp.sent[0].method, 'Page.captureScreenshot', 'the full-resolution capture, not the screencast');
    eq(cdp.sent[0].params.format, 'png', 'requested as PNG');
    eq(cdp.sent[0].sessionId, 'S1', "addressed to the panel's own session");
    ok(path.startsWith('/storage/captures/'), `unset screenshotDirectory lands under globalStorage/captures (got ${path})`);
    ok(path.endsWith('.png'), 'screenshot path ends in .png');
    eq(globalThis.__fsWrites.length, 1, 'exactly one file written');
    eq(
      Buffer.from(globalThis.__fsWrites[0].bytes).toString('base64'),
      PNG_BASE64,
      'the written bytes are exactly what Chrome returned, base64-decoded'
    );
  }

  // configured screenshotDirectory is honoured
  {
    const entry = fakeEntry(fakeCdp());
    globalThis.__config = { remoteVnc: { screenshotDirectory: '/configured/shots' } };
    globalThis.__fsWrites = [];

    const path = await capturePageScreenshot(entry);
    ok(path.startsWith('/configured/shots/'), `configured screenshotDirectory is honoured (got ${path})`);
    globalThis.__config = undefined;
  }

  // a mirror still launching rejects, but not with the non-mirrored page's
  // reserved message — that string is what a NON-mirrored page rejects with,
  // and widening it to also cover "not ready yet" would make the two
  // indistinguishable to a caller trying to tell them apart.
  {
    const entry = fakeEntry(undefined);
    try {
      await capturePageScreenshot(entry);
      ok(false, 'a screenshot with no attached mirror should reject');
    } catch (err) {
      eq(err.message, 'mirror is not ready yet', 'the exact "not ready" reason, distinct from the non-mirrored one');
    }
  }

  // Chrome returning no usable data rejects instead of writing a garbage file
  {
    const entry = fakeEntry(fakeCdp(null));
    globalThis.__fsWrites = [];
    try {
      await capturePageScreenshot(entry);
      ok(false, 'no image data should reject');
    } catch (err) {
      ok(/no usable image data/.test(err.message), 'the rejection names the actual problem');
    }
    eq(globalThis.__fsWrites.length, 0, 'nothing written when there is nothing to write');
  }

  // --- recording (registry path): media/recorder.ts unchanged, driven -----
  // through the webview, saved with no dialog.
  {
    const entry = fakeEntry(fakeCdp());
    globalThis.__fsWrites = [];

    const started = startPageRecording(entry);
    eq(entry.posted.length, 1, 'record-start is posted to the webview');
    eq(entry.posted[0].type, 'record-start', 'the message the webview answers');
    eq(entry.recording, 'starting', 'recording state flips before the webview confirms');

    // the webview answers, exactly the shape media/pageMirror.ts posts
    await handleMirrorMessage(entry, { type: 'record-status', recording: true });
    await started; // must resolve, not hang or reject
    eq(entry.recording, 'recording', 'confirmed recording state');

    // starting again while already recording is refused before a second
    // record-start is ever posted
    try {
      await startPageRecording(entry);
      ok(false, 'starting a second recording should reject');
    } catch (err) {
      eq(err.message, 'already recording', 'the exact reason');
    }
    eq(entry.posted.length, 1, 'no second record-start was posted');

    const stopped = stopPageRecording(entry);
    eq(entry.posted.length, 2, 'record-stop is posted to the webview');
    eq(entry.posted[1].type, 'record-stop', 'the message the webview answers');

    await handleMirrorMessage(entry, {
      type: 'recording',
      format: 'webm',
      data: Uint8Array.from([...WEBM_MAGIC, 9, 9, 9]),
      durationMs: 2500,
      reason: 'stopped',
    });
    const path = await stopped;

    ok(path.startsWith('/storage/captures/'), `recording lands under globalStorage/captures (got ${path})`);
    ok(path.endsWith('.webm'), 'recording path ends in .webm');
    eq(entry.recording, 'idle', 'recording state resets once the file is saved');
    eq(globalThis.__fsWrites.length, 1, 'exactly one file written for the recording');
  }

  // --- CRITICAL regression: a record request on a visible-but-UNFOCUSED tab
  // --- must start the screencast, not just post record-start ---------------
  // The control server's record() (src/controlServer.ts) is exactly the case
  // this exists for: it drives a tab nobody has clicked into, which is why
  // the stream may be stopped when the request arrives at all. media/
  // recorder.ts's `captureStream` draws whatever the canvas last had, and the
  // canvas only repaints on a screencast frame — so without this, the
  // recording was a full-length video of one frozen frame, with no error
  // anywhere.
  {
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp);
    entry.panel.visible = true;
    entry.panel.active = false; // visible, but not the focused tab
    void startPageRecording(entry);
    ok(
      cdp.sent.some((s) => s.method === 'Page.startScreencast'),
      'startPageRecording starts the screencast itself rather than assuming one is already running'
    );
  }

  // --- the SAME regression, through the Web Pages tree's record button -----
  // (startPageRecordingInteractive) — a real gap, not a duplicate: deleting
  // just the ensureStreaming call in startPageRecordingInteractive left this
  // suite at 675/675 until this test existed, because nothing else here
  // exercised the interactive dispatcher with a visible-but-unfocused panel
  // and a real fake CDP session to observe Page.startScreencast on.
  {
    const id = 'page-interactive-unfocused-record';
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true });
    entry.panel.visible = true;
    entry.panel.active = false; // e.g. the Web Pages tree's record button was just clicked
    openPanelsById.set(id, entry);

    toggleRecordPage(id); // idle -> start, via startPageRecordingInteractive
    ok(
      cdp.sent.some((s) => s.method === 'Page.startScreencast'),
      'the interactive record start also starts the screencast on a visible-but-unfocused tab'
    );
  }

  // --- IMPORTANT 4: a record-status reporting the recording ended must also
  // --- settle a PENDING stop waiter, not only recordStartWaiters -----------
  // Simulates the webview ending a take without ever posting the final
  // 'recording' message a pending stopPageRecording() call is waiting on (a
  // crash, a dropped connection, the tab having gone hidden mid-take).
  // Before this fix, this branch spliced only recordStartWaiters, so the
  // control server's recordStop hung forever (no response timeout —
  // src/controlServer.ts) and the interactive path produced no file, no
  // toast, no log.
  {
    const entry = fakeEntry(fakeCdp(), { recording: 'recording' });
    const stopped = stopPageRecording(entry);
    eq(entry.posted.length, 1, 'record-stop was posted');
    eq(entry.recordStopWaiters.length, 1, 'a stop waiter is now pending');

    // handleRecordMessage toasts every record-status error unconditionally
    // (by design); opt into the dialog stub for it.
    globalThis.__dialogsEnabled = true;
    await handleMirrorMessage(entry, {
      type: 'record-status',
      recording: false,
      error: 'the CDP connection was lost',
    });

    const result = await outcome(stopped);
    ok(result instanceof Error, `the pending stop rejects instead of hanging (got: ${describe(result)})`);
    ok(
      /CDP connection was lost/.test(result.message),
      `and carries the actual reason, not a generic one (got: ${describe(result)})`
    );
    eq(entry.recordStopWaiters.length, 0, 'the waiter list is drained, not left dangling for the next recording to inherit');
    resetStubs();
  }

  // --- RESIDUAL 3: a NORMAL recording finish re-evaluates the gate too -----
  // handleRecordMessage's 'recording' (finished-artifact) branch has its OWN
  // reapplyStreamingGate call, separate from the record-status branch's
  // (tested above via a FAILED start) — a reviewer found that deleting only
  // this one, on its own, left the whole suite green, because nothing here
  // exercised a normal finish on a visible-but-unfocused, actually-running
  // stream and checked what happened to it afterwards.
  {
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true });
    entry.panel.visible = true;
    entry.panel.active = false; // unfocused — the recording is the only reason streaming
    entry.mirror.running = true; // as if the recording had been keeping the stream alive
    globalThis.__dialogsEnabled = true;
    globalThis.__fsWrites = [];

    await handleMirrorMessage(entry, {
      type: 'recording',
      format: 'webm',
      data: Uint8Array.from([...WEBM_MAGIC, 4, 5, 6]),
      durationMs: 800,
      reason: 'stopped',
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget save + stop settle

    eq(entry.recording, 'idle', 'recording state reset by the finished message');
    eq(
      cdp.sent.some((s) => s.method === 'Page.stopScreencast'),
      true,
      'the screencast is stopped once the recording finishes — not left running on an unfocused tab forever'
    );
    resetStubs();
  }

  // stopping with nothing recording is refused before anything is posted
  {
    const entry = fakeEntry(fakeCdp());
    try {
      await stopPageRecording(entry);
      ok(false, 'stopping with no recording in progress should reject');
    } catch (err) {
      eq(err.message, 'no recording in progress', 'the exact reason');
    }
    eq(entry.posted.length, 0, 'nothing was posted to the webview');
  }

  // MINOR fix: stopping while the start is still in flight ('starting') must
  // not post record-stop at all — posting it used to be able to beat the
  // webview's own start handling, whose resulting record-status:false was
  // routed to recordStartWaiters (that call's own waiter) while this call's
  // recordStopWaiters entry sat pending until the panel tore down.
  {
    const entry = fakeEntry(fakeCdp(), { recording: 'starting' });
    try {
      await stopPageRecording(entry);
      ok(false, 'stopping mid-start should reject');
    } catch (err) {
      eq(
        err.message,
        'still starting the recording — try again in a moment',
        'the exact reason, distinct from "no recording in progress"'
      );
    }
    eq(entry.posted.length, 0, 'no record-stop (or anything else) was posted while starting');
    eq(entry.recordStopWaiters.length, 0, 'no waiter was left dangling');
  }

  // --- a hidden tab has no webview, so neither registry call may post -------
  // VS Code drops a message to a webview that is not listening, which is what
  // `webviewLive` tracks. Posting anyway pushed a waiter nothing would ever
  // settle: the control server (src/controlServer.ts) has no response timeout,
  // so the HTTP request hung until the tab was closed — and a hidden mirrored
  // tab is the ordinary case the control server exists to serve. A start also
  // stranded `recording: 'starting'`, from which BOTH stop paths then refuse
  // to proceed, so the answer to every later stop was "still starting the
  // recording", forever.
  //
  // Awaited through `outcome`, never directly: hanging IS the defect, so a
  // bare `await` here would stall the whole suite with no output at all —
  // which is exactly what the un-fixed code does, and it reports nothing.
  {
    const hidden = fakeEntry(fakeCdp(), { webviewLive: false });
    const startResult = await outcome(startPageRecording(hidden));
    ok(
      startResult instanceof Error && /reveal the tab/.test(startResult.message),
      `a start on a hidden tab rejects, saying what to do about it (got ${describe(startResult)})`
    );
    eq(hidden.posted.length, 0, 'nothing was posted to a webview that is not listening');
    eq(hidden.recordStartWaiters.length, 0, 'and no waiter was left for nobody to settle');
    eq(hidden.recording, 'idle', "the state is not stranded in 'starting'");

    // The stop half, from the state that actually produces the hang: a tab
    // hidden mid-recording still reads 'recording', so the state check alone
    // would wave it through.
    const midRecording = fakeEntry(fakeCdp(), { webviewLive: false, recording: 'recording' });
    const stopResult = await outcome(stopPageRecording(midRecording));
    ok(
      stopResult instanceof Error && /reveal the tab/.test(stopResult.message),
      `a stop on a hidden tab rejects too (got ${describe(stopResult)})`
    );
    eq(midRecording.posted.length, 0, 'no record-stop was posted into the void');
    eq(midRecording.recordStopWaiters.length, 0, 'and no stop waiter was left dangling');
  }

  // bytes that fail the magic-byte check (recordingBytes) reject instead of
  // writing whatever the webview happened to send
  {
    const entry = fakeEntry(fakeCdp(), { recording: 'recording' });
    globalThis.__fsWrites = [];
    const stopped = stopPageRecording(entry);
    await handleMirrorMessage(entry, {
      type: 'recording',
      format: 'webm',
      data: Uint8Array.from([1, 2, 3, 4]), // not the WebM magic
      durationMs: 100,
      reason: 'stopped',
    });
    try {
      await stopped;
      ok(false, 'invalid recording bytes should reject');
    } catch (err) {
      ok(/no usable webm data/.test(err.message), 'the rejection names the actual problem');
    }
    eq(globalThis.__fsWrites.length, 0, 'nothing written for invalid bytes');
  }

  // a failed start now ALWAYS logs+toasts (handleRecordMessage), not only
  // when a registry waiter happens to be pending — the same thing
  // VncSession.onMessage's 'record-status' case already does, and what lets
  // the interactive start stay fire-and-forget (see the dispatcher section
  // below). Also: a mirror that closes mid-recording must not leave a
  // registry caller hanging (rejectPendingPageCaptures, wired into
  // closeMirror/restartMirrorWebview) — exercised here through this same
  // record-status failure path, its more common trigger.
  {
    resetStubs();
    globalThis.__dialogsEnabled = true;
    const entry = fakeEntry(fakeCdp());
    const started = startPageRecording(entry);
    await handleMirrorMessage(entry, { type: 'record-status', recording: false, error: 'no canvas yet' });
    try {
      await started;
      ok(false, 'a failed start should reject');
    } catch (err) {
      eq(err.message, 'no canvas yet', "the webview's own reported error survives");
    }
    eq(entry.recording, 'idle', 'a failed start leaves recording state idle, not stuck in "starting"');
    ok(
      globalThis.__dialogCalls.some((c) => c.name === 'showWarningMessage' && c.args[0].includes('no canvas yet')),
      'the failure is also toasted, unconditionally — not only when a registry waiter is pending'
    );
    resetStubs();
  }

  // --- the capture chords, routed to the focused-panel commands -----------
  // media/pageMirror.ts posts {type:'chord'} for the two capture chords;
  // src/mirrorInput.ts now recognises it (test/mirrorInput.test.mjs), and
  // this is where the host routes it on — the same two commands
  // src/vncPanel.ts's onMessage runs for its own webview.
  {
    const entry = fakeEntry(fakeCdp());
    globalThis.__executedCommands = [];

    await handleMirrorMessage(entry, { type: 'chord', action: 'screenshot' });
    eq(globalThis.__executedCommands, [['remoteVnc.screenshotFocused']], 'the screenshot chord runs the focused-screenshot command');

    await handleMirrorMessage(entry, { type: 'chord', action: 'record' });
    eq(
      globalThis.__executedCommands,
      [['remoteVnc.screenshotFocused'], ['remoteVnc.recordFocusedToggle']],
      'the record chord runs the focused-record-toggle command'
    );
  }

  // a message this file does not recognise (mirrorInput's allowlist rejects
  // it) executes nothing and touches no CDP call
  {
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp);
    globalThis.__executedCommands = [];
    await handleMirrorMessage(entry, { type: 'chord', action: 'sudo' });
    eq(globalThis.__executedCommands, [], 'an unrecognised chord action runs nothing');
    eq(cdp.sent.length, 0, 'and reaches no CDP call either');
  }

  // --- the registry contract: exact rejection for a NON-mirrored page -----
  // registerPageEntry must keep the non-mirrored rejection message exactly
  // 'page is not mirrored' — a script (and the control server's HTTP mapping,
  // test/controlRoutes.test.mjs) depends on that literal string, and widening
  // it to also cover a mirrored-but-not-ready page would break both.
  {
    const url = 'http://example.test/not-mirrored';
    registerPageEntry(url, fakeEntry(undefined, { mirrored: false }), 'not mirrored');
    const panel = getPanel(pageId(url));
    ok(panel, 'the panel is registered');
    eq(panel.mirrored, false, 'reported as not mirrored');
    for (const call of [() => panel.screenshot(), () => panel.record(), () => panel.recordStop()]) {
      try {
        await call();
        ok(false, 'a non-mirrored page capture call should reject');
      } catch (err) {
        eq(err.message, 'page is not mirrored', 'the exact reserved message');
      }
    }
  }

  // --- the registry contract: a DIFFERENT rejection for a page whose mirror
  // --- FAILED to launch, as opposed to one that never asked ------------------
  // Both end up with `mirrored: false`, but they are not the same situation:
  // one never wanted a mirror (the case above, 'page is not mirrored' —
  // correct as is), the other asked and Chrome would not start (this case).
  // Before this fix both produced the exact same string, so a user hitting
  // the failed-launch case saw "page is not mirrored" and read it as "you
  // didn't ask for this" — which is not what happened.
  //
  // The recovery advice matters too, and had its own bug: `reopen()` — what
  // an already-open URL's `openPagePanel` call actually routes to — only
  // rebuilds the iframe HTML for `mirrored: false`; it never re-enters
  // `startMirror`. So "reopen the tab to retry" described an action that does
  // not retry anything, no matter how many times it is done. Only closing the
  // panel and opening the URL again reaches the code path that retries the
  // launch — see MIRROR_LAUNCH_FAILED_MESSAGE's own doc comment.
  {
    const url = 'http://example.test/mirror-failed';
    registerPageEntry(
      url,
      fakeEntry(undefined, { mirrored: false, mirrorFailed: true }),
      'mirror failed'
    );
    const panel = getPanel(pageId(url));
    ok(panel, 'the panel is registered');
    eq(panel.mirrored, false, 'still reported as not mirrored — the fallback iframe is what is actually shown');
    for (const call of [() => panel.screenshot(), () => panel.record(), () => panel.recordStop()]) {
      try {
        await call();
        ok(false, 'a failed-launch page capture call should reject');
      } catch (err) {
        eq(
          err.message !== 'page is not mirrored',
          true,
          'must NOT reuse the reserved message — that means something different'
        );
        ok(/launch/i.test(err.message), `the message says what happened (got: ${err.message})`);
        ok(
          /close the tab/i.test(err.message) && /open it again/i.test(err.message),
          `the advice is to close and reopen, not merely reveal the same tab (got: ${err.message})`
        );
        eq(
          /reopen the tab to retry/i.test(err.message),
          false,
          'must not tell the user to "reopen" the tab — reopen() cannot retry a launch for an already-open, ' +
            'non-mirrored entry, so that advice does not work'
        );
      }
    }
  }

  // and a MIRRORED page's registry entry actually captures — the whole point
  // of Task 7, in contrast to the pre-Task-7 stub that rejected unconditionally.
  {
    const url = 'http://example.test/mirrored';
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true });
    globalThis.__fsWrites = [];
    registerPageEntry(url, entry, 'mirrored');
    const panel = getPanel(pageId(url));
    ok(panel, 'the panel is registered');
    eq(panel.mirrored, true, 'reported as mirrored');
    eq(panel.isRecording(), false, 'not recording initially');

    const path = await panel.screenshot();
    ok(path.endsWith('.png'), 'the registry screenshot works end to end');
    eq(cdp.sent[0]?.method, 'Page.captureScreenshot', 'via CDP, not the screencast');
  }

  // =========================================================================
  // Fix round 1: the INTERACTIVE dispatcher path — takePageScreenshot and
  // toggleRecordPage, which src/extension.ts's screenshotFocused/
  // recordFocusedToggle and the Web Pages tree's screenshotPage/
  // recordTogglePage now call for a mirrored page instead of the registry.
  // These resolve a live OpenPage from an id via openPanelsById (the same
  // seam VncSessionManager's own `sessions` map fills for a VNC session),
  // exported here for exactly this test.
  // =========================================================================
  resetStubs();

  // --- screenshot lands in the crop editor (screenshotAction defaults to
  // 'open'), never the registry's silent write to <globalStorage>/captures.
  {
    const id = 'page-interactive-1';
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true });
    openPanelsById.set(id, entry);
    globalThis.__dialogsEnabled = true;
    globalThis.__fsWrites = [];
    globalThis.__executedCommands = [];

    await takePageScreenshot(id);

    eq(cdp.sent[0]?.method, 'Page.captureScreenshot', 'still captured via CDP, exactly like the registry path');
    ok(
      globalThis.__executedCommands.some((c) => c[0] === 'vscode.openWith'),
      'the screenshot opens in the crop editor — proof this is the interactive path, not the silent one'
    );
    ok(
      globalThis.__dialogCalls.some((c) => c.name === 'showInformationMessage' && c.args[0].includes('screenshot opened, not saved')),
      'and the human sees the toast the registry path never shows'
    );
    eq(globalThis.__fsWrites.length, 1, 'exactly one file staged');
    ok(
      globalThis.__fsWrites[0].path.includes('/recordings/'),
      `staged under .../recordings/, not .../captures/ (got ${globalThis.__fsWrites[0].path})`
    );
    resetStubs();
  }

  // --- screenshotAction: 'save' takes the direct-to-directory branch, but
  // still toasts — interactiveSaveCapture, not the silent registry path.
  {
    const id = 'page-interactive-2';
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true });
    openPanelsById.set(id, entry);
    globalThis.__config = { remoteVnc: { screenshotAction: 'save', screenshotDirectory: '/kept/shots' } };
    globalThis.__dialogsEnabled = true;
    globalThis.__fsWrites = [];

    await takePageScreenshot(id);

    eq(globalThis.__fsWrites.length, 1, 'exactly one file written');
    ok(
      globalThis.__fsWrites[0].path.startsWith('/kept/shots/'),
      `remoteVnc.screenshotDirectory is honoured (got ${globalThis.__fsWrites[0].path})`
    );
    ok(
      globalThis.__dialogCalls.some((c) => c.name === 'showInformationMessage' && c.args[0].includes('screenshot saved')),
      'the "saved" toast still fires — this is saveCaptureBytes, never the registry write'
    );
    resetStubs();
  }

  // --- toggleRecordPage: start posts record-start with NO registry waiter
  // pushed (fire-and-forget, like VncSession.startRecording); the finished
  // recording lands via interactiveSaveCapture, not saveCaptureFile.
  {
    const id = 'page-interactive-3';
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true });
    openPanelsById.set(id, entry);
    globalThis.__dialogsEnabled = true;
    globalThis.__fsWrites = [];

    toggleRecordPage(id); // idle -> start
    eq(entry.posted.length, 1, 'record-start posted');
    eq(entry.recording, 'starting', 'state flips synchronously');
    eq(entry.recordStartWaiters.length, 0, 'fire-and-forget: no registry waiter pushed for an interactive start');

    await handleMirrorMessage(entry, { type: 'record-status', recording: true });
    eq(entry.recording, 'recording', 'confirmed by the webview');

    toggleRecordPage(id); // recording -> stop
    eq(entry.posted.length, 2, 'record-stop posted');
    eq(entry.recordStopWaiters.length, 0, 'fire-and-forget here too: no registry waiter pushed for an interactive stop');

    await handleMirrorMessage(entry, {
      type: 'recording',
      format: 'webm',
      data: Uint8Array.from([...WEBM_MAGIC, 1, 2, 3]),
      durationMs: 1200,
      reason: 'stopped',
    });
    // handleRecordMessage's interactive branch is `void`-ed, exactly as
    // VncSession.onMessage's own 'recording' case never awaits
    // handleRecording — fire-and-forget in production because nobody is
    // waiting on a promise. Flush the microtask queue before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    eq(globalThis.__fsWrites.length, 1, 'exactly one file staged for the finished recording');
    ok(
      globalThis.__fsWrites[0].path.includes('/recordings/'),
      `staged under .../recordings/ (interactive), not .../captures/ (registry) — got ${globalThis.__fsWrites[0].path}`
    );
    ok(
      globalThis.__dialogCalls.some((c) => c.name === 'showInformationMessage' && c.args[0].includes('recording opened, not saved')),
      'the human sees a toast for the finished recording too'
    );
    resetStubs();
  }

  // --- toggleRecordPage refuses to stop while still starting, same as the
  // registry's stopPageRecording, and with no dialog either (the message is
  // shown via showInformationMessage rather than thrown, so this proves the
  // guard fires before anything is posted, not merely that it eventually
  // resolves).
  {
    const id = 'page-interactive-4';
    const entry = fakeEntry(fakeCdp(), { mirrored: true, recording: 'starting' });
    openPanelsById.set(id, entry);
    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];

    toggleRecordPage(id);

    eq(entry.posted.length, 0, 'no record-stop posted while starting');
    ok(
      globalThis.__dialogCalls.some(
        (c) => c.name === 'showInformationMessage' && c.args[0].includes('still starting')
      ),
      'the human is told to wait, not left guessing why nothing happened'
    );
    resetStubs();
  }

  // --- toggleRecordPage on a hidden tab: the interactive twin of the
  // registry's "hidden tab" case above. The Web Pages tree's record button
  // has no visibility check of its own (unlike the focused-panel hotkey), so
  // this is the path that actually reaches a mirrored-but-hidden tab in
  // practice — and until this guard existed, a start here posted into a
  // webview VS Code silently drops, stranding `recording: 'starting'` with
  // nothing but a rebuild/close to ever clear it.
  {
    const id = 'page-interactive-hidden-start';
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true, webviewLive: false });
    openPanelsById.set(id, entry);
    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];

    toggleRecordPage(id); // idle -> would-be start

    eq(entry.posted.length, 0, 'nothing was posted to a webview that is not listening');
    eq(entry.recording, 'idle', "the state is not stranded in 'starting'");
    ok(
      globalThis.__dialogCalls.some(
        (c) => c.name === 'showInformationMessage' && c.args[0].includes('reveal the tab')
      ),
      'the human is told to reveal the tab, not left with a button that silently does nothing'
    );
    resetStubs();
  }

  // the stop half, from the state that actually produces the hang: a tab
  // hidden mid-recording still reads 'recording', so a state check alone
  // would wave it through into a post that drops silently.
  {
    const id = 'page-interactive-hidden-stop';
    const cdp = fakeCdp();
    const entry = fakeEntry(cdp, { mirrored: true, webviewLive: false, recording: 'recording' });
    openPanelsById.set(id, entry);
    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];

    toggleRecordPage(id); // recording -> would-be stop

    eq(entry.posted.length, 0, 'no record-stop was posted into the void');
    eq(entry.recording, 'recording', 'state is left alone rather than guessed at');
    ok(
      globalThis.__dialogCalls.some(
        (c) => c.name === 'showInformationMessage' && c.args[0].includes('reveal the tab')
      ),
      'the human is told to reveal the tab here too, not "no recording in progress"'
    );
    resetStubs();
  }

  // --- neither dispatcher does anything for an id that is not a mirrored,
  // open page (unknown id, or a non-mirrored one) — the caller in
  // src/extension.ts has already shown the "not open"/"not mirrored" toast
  // by the time either of these would be reached, so a second one here would
  // be a duplicate. `ok(true, …)` on a call that would otherwise throw is not
  // hollow: __dialogsEnabled is left false, so a stray dialog call fails loud.
  {
    resetStubs();
    await takePageScreenshot('no-such-id');
    toggleRecordPage('no-such-id');

    const notMirroredId = 'page-not-mirrored';
    openPanelsById.set(notMirroredId, fakeEntry(fakeCdp(), { mirrored: false }));
    await takePageScreenshot(notMirroredId);
    toggleRecordPage(notMirroredId);

    ok(true, 'neither dispatcher touched a dialog, a command, or the CDP session for an unknown/non-mirrored id');
  }

  resetStubs();
  globalThis.__config = undefined;
  globalThis.__fsWrites = undefined;
  globalThis.__executedCommands = undefined;
  globalThis.__dialogsEnabled = undefined;
  globalThis.__dialogCalls = undefined;
  globalThis.__dialogAnswers = undefined;
}
