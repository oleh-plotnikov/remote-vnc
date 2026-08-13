// The mirrored panel's run state, driven directly with a fake CDP session.
//
// This exists for one bug and its whole family. `running` is the flag every
// ensureStreaming early-returns on, so anything that leaves it claimed when no
// stream was actually started freezes the tab for its entire life — and does it
// silently, because the screencast simply never delivers a frame. The failure
// looks like a slow page, not like an error, which is why it has to be a test
// rather than something anyone would notice.
//
// openPagePanel is not reachable here (it needs a real WebviewPanel and spawns
// Chrome), but startScreencast and ensureStreaming touch only `entry.mirror`
// and `entry.panel.visible`, so a plain object stands in for the panel.
import { load } from './bundle.mjs';

/** A CDP session that fails its first N sends, recording every method tried. */
function fakeCdp(failures = 0) {
  const sent = [];
  let left = failures;
  return {
    sent,
    send: async (method, params, sessionId) => {
      sent.push({ method, params, sessionId });
      if (left > 0) {
        left--;
        throw new Error('CDP connection closed');
      }
      return {};
    },
  };
}

/**
 * A CDP session whose `Input.dispatch*` calls never settle until the test says
 * so — which is precisely what a Chrome renderer that has fallen behind does,
 * since Chromium defers the response to those calls until the renderer
 * acknowledges the event. Everything else answers immediately, the way the
 * browser process really does keep answering while the renderer is stuck.
 */
function deferredInputCdp() {
  const sent = [];
  const waiting = [];
  return {
    sent,
    waiting,
    send: (method, params, sessionId, timeoutMs) => {
      sent.push({ method, params, sessionId, timeoutMs });
      if (method.startsWith('Input.')) {
        return new Promise((resolve) => waiting.push(resolve));
      }
      return Promise.resolve({});
    },
    /** The renderer catches up: every outstanding dispatch is answered. */
    settle: () => {
      for (const resolve of waiting.splice(0)) {
        resolve({});
      }
    },
    inputs: (type) =>
      sent.filter((s) => s.method.startsWith('Input.') && s.params?.type === type).length,
  };
}

const keyDown = { type: 'input', kind: 'key', event: 'keyDown', key: 'a' };
const mouseMoved = { type: 'input', kind: 'mouse', event: 'mouseMoved', x: 4, y: 5 };

function fakeEntry(cdp, over = {}) {
  const { panel: panelOver, ...rest } = over;
  const posted = [];
  return {
    // Merged rather than replaced, so a case that only cares about
    // visible/active still gets a webview to post to — markMirrorDegraded and
    // restartMirrorWebview both talk to one.
    panel: {
      visible: true,
      active: true,
      title: 'page',
      webview: {
        posted,
        postMessage: (m) => {
          posted.push(m);
          return Promise.resolve(true);
        },
        asWebviewUri: (u) => u,
        html: '',
      },
      ...panelOver,
    },
    extensionUri: { scheme: 'file', authority: '', path: '/ext' },
    recordStartWaiters: [],
    recordStopWaiters: [],
    mirrored: true,
    webviewLive: true,
    // Real OpenPage entries always start 'idle' — set explicitly rather than
    // left undefined, because ensureStreaming's focus gate now treats
    // `recording !== 'idle'` as a reason to stream regardless of focus, and
    // `undefined !== 'idle'` would make every fake entry here look like it
    // is recording by accident.
    recording: 'idle',
    mirror: {
      cdp,
      sessionId: 'S1',
      targetId: 'T1',
      unacked: [],
      size: { width: 800, height: 600 },
      running: false,
      everyNthFrame: 0,
      pendingEveryNthFrame: 0,
      inFlightInput: 0,
      peakInFlightInput: 0,
      droppedMoves: 0,
      degraded: false,
      warnedDegraded: false,
    },
    ...rest,
  };
}

export default async function ({ ok, eq }) {
  const {
    startScreencast,
    stopScreencast,
    ensureStreaming,
    applyViewport,
    applyMirrorRate,
    handleMirrorMessage,
    disposePageMirrors,
    shouldMirrorStream,
    applyMirrorViewState,
    recoverMirror,
    reopenMirror,
    restartMirrorPage,
    openPanelsById,
    closeMirror,
  } = await load('pagePanel.ts');
  const { MAX_INFLIGHT_INPUT } = await load('mirrorInput.ts');

  // --- shouldMirrorStream: the single gate both ensureStreaming and the ----
  // --- onDidChangeViewState handler defer to, so the two cannot drift apart.
  // This is the extraction that makes the streaming DECISION testable at
  // all: the closure it used to live only inside is unreachable from this
  // suite (a `throw` as its first statement still leaves every other test
  // green), and before this fix that closure's own copy of the decision let
  // a hidden-but-recording tab keep "streaming" with no webview left to
  // paint into — the exact regression the CRITICAL case below pins.
  for (const [visible, active, recording, want, note] of [
    [true, true, 'idle', true, 'visible and focused: always stream'],
    [true, false, 'idle', false, 'visible, unfocused, not recording: do not stream'],
    [true, false, 'recording', true, 'visible, unfocused, recording: stream anyway'],
    [true, false, 'starting', true, 'visible, unfocused, starting: stream anyway — the ack has not arrived yet'],
    [true, true, 'recording', true, 'visible, focused, recording: stream (redundant, but still true)'],
    // CRITICAL 1: hidden always means false, regardless of recording — a
    // hidden tab has no webview and therefore no canvas for a recording to
    // capture into, and (unlike a visible-but-unfocused one) has no way to
    // recover once stuck: reopen() only rebuilds a webview that is not
    // already webviewLive, and hidden clears that flag, so no further
    // view-state event or capture UI can ever reach it again.
    [false, true, 'idle', false, 'hidden, even though "active" reports true: never stream'],
    [false, false, 'recording', false, 'hidden AND recording: never stream — the exact regression this pins'],
    [false, false, 'starting', false, 'hidden AND starting: never stream either'],
  ]) {
    eq(shouldMirrorStream(visible, active, recording), want, note);
  }

  // --- applyMirrorViewState: the whole onDidChangeViewState decision, once -
  // --- inline in a closure no test could reach at all ----------------------
  // RESIDUAL 2: a reviewer found that deleting just the hidden-tab stop call
  // from that closure left 717/0 green — nothing exercised the exact branch
  // with an actually-RUNNING stream to observe Page.stopScreencast on.
  {
    const cdp6 = fakeCdp();
    const hiding = fakeEntry(cdp6, { panel: { visible: false, active: false } });
    hiding.mirror.running = true; // as if it had been streaming while visible
    applyMirrorViewState(hiding);
    eq(
      cdp6.sent.some((s) => s.method === 'Page.stopScreencast'),
      true,
      'RESIDUAL 2: going hidden actually stops a running stream, not merely fails to start one'
    );
    eq(hiding.webviewLive, false, 'and clears webviewLive, since the webview is gone');
  }

  // A visible, focused tab is left alone — nothing to stop.
  {
    const cdp7 = fakeCdp();
    const staying = fakeEntry(cdp7, { panel: { visible: true, active: true } });
    applyMirrorViewState(staying);
    eq(cdp7.sent.some((s) => s.method === 'Page.stopScreencast'), false, 'a visible, focused tab is not stopped');
  }

  // --- RESIDUAL 1: hiding mid-recording resets state, settles waiters, and -
  // --- surfaces the loss — a hidden tab has no webview and no
  // --- retainContextWhenHidden, so the recording is destroyed with it and
  // --- nothing else will ever hear about it -------------------------------
  {
    const cdp8 = fakeCdp();
    const recordingHidden = fakeEntry(cdp8, {
      panel: { visible: false, active: false, title: 'kiosk' },
      recording: 'recording',
      recordStartWaiters: [],
      recordStopWaiters: [],
    });
    recordingHidden.mirror.running = true;
    // As stopPageRecording() would have pushed, had the control server
    // asked to stop just before the tab was hidden.
    let stopErr;
    recordingHidden.recordStopWaiters.push({ resolve: () => {}, reject: (e) => (stopErr = e) });

    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];
    applyMirrorViewState(recordingHidden);
    globalThis.__dialogsEnabled = false;

    eq(recordingHidden.recording, 'idle', 'recording state is reset, not left stuck — this is what re-show reads');
    ok(stopErr instanceof Error, 'a pending registry stop waiter is rejected, not left hanging');
    ok(/hidden/i.test(stopErr?.message ?? ''), `and the reason says the tab was hidden (got: ${stopErr?.message})`);
    ok(
      globalThis.__dialogCalls.some((c) => c.name === 'showWarningMessage' && /recording lost/i.test(c.args[0])),
      `a lost take is surfaced with a toast, not silent (got: ${JSON.stringify(globalThis.__dialogCalls)})`
    );
    eq(cdp8.sent.some((s) => s.method === 'Page.stopScreencast'), true, 'and the stream is stopped too');
  }

  // A pending START (not stop) waiter is rejected the same way — the
  // registry's own startPageRecording() call, still awaiting its ack.
  {
    const cdp9 = fakeCdp();
    const startingHidden = fakeEntry(cdp9, {
      panel: { visible: false, active: false, title: 'kiosk' },
      recording: 'starting',
      recordStartWaiters: [],
      recordStopWaiters: [],
    });
    let startErr;
    startingHidden.recordStartWaiters.push({ resolve: () => {}, reject: (e) => (startErr = e) });
    globalThis.__dialogsEnabled = true;
    applyMirrorViewState(startingHidden);
    globalThis.__dialogsEnabled = false;
    eq(startingHidden.recording, 'idle', "'starting' is reset too, not only 'recording' — an ack that will now never arrive sticks the same way");
    ok(startErr instanceof Error, 'a pending registry START waiter is rejected too, not left hanging');
  }

  // A hidden tab that was NOT recording gets none of this — an ordinary,
  // silent stop, exactly as before this fix.
  {
    globalThis.__dialogCalls = [];
    const plainHidden = fakeEntry(fakeCdp(), { panel: { visible: false, active: false } });
    applyMirrorViewState(plainHidden);
    eq(globalThis.__dialogCalls.length, 0, 'no toast for an ordinary hide with nothing recording');
  }

  // --- a failed start must not leave the stream claimed ---------------------
  const cdp = fakeCdp(1); // the first Page.startScreencast rejects
  const entry = fakeEntry(cdp);

  await startScreencast(entry);
  eq(cdp.sent.length, 1, 'the start was attempted');
  eq(cdp.sent[0].method, 'Page.startScreencast', 'and it was the screencast that was attempted');
  // The bug: `running` was claimed before the send and the rejection swallowed,
  // so it stayed true with no stream behind it and every later ensureStreaming
  // returned at the first guard.
  eq(entry.mirror.running, false, 'a rejected start leaves the stream unclaimed');

  // Which is what makes the next attempt possible at all.
  await ensureStreaming(entry);
  eq(cdp.sent.length, 2, 'a later ensureStreaming retries the start');
  // Optional chaining throughout: when this regresses there IS no second send,
  // and a TypeError here would crash the run and hide every assertion below
  // instead of reporting the one thing that broke.
  eq(cdp.sent[1]?.method, 'Page.startScreencast', 'the retry is a real Page.startScreencast');
  eq(entry.mirror.running, true, 'the successful retry claims the stream');
  eq(
    cdp.sent[1]?.sessionId,
    'S1',
    "the retry is addressed to the panel's own CDP session, not the browser"
  );
  eq(
    cdp.sent[1]?.params?.maxWidth,
    800,
    'the retry carries the emulated viewport, so frames are not sized to a stale panel'
  );

  // --- the stream is rate-limited, and follows recent activity --------------
  // Without everyNthFrame Chrome ships every frame it composites. Measured on
  // one mirrored tab running a continuous animation: 144% CPU across eleven
  // processes. An animated page never goes idle, so that is the RESTING cost of
  // having the tab open, and nothing in the mirror's own behaviour reveals it —
  // the tab just looks fine while the fan runs.
  //
  // `entry` has had no input forwarded to it at all, so this first start lands
  // on the IDLE rate — a third of the 30 fps ACTIVE default (see
  // src/mirrorRate.ts), i.e. 10 fps, every 6th frame of a 60 Hz compositor.
  // One fixed rate cannot serve both watching and typing (src/pagePanel.ts's
  // DEFAULT_MIRROR_FPS has the full measured account of why), so idle-by-
  // default is deliberate, not a leftover of the old single-rate design.
  eq(
    cdp.sent[1]?.params?.everyNthFrame,
    6,
    'idle by default — no input has been forwarded yet, so ~10 fps, not the 30 fps active rate'
  );

  // A recent input flips the SAME mirror onto the active rate the next time
  // the screencast (re)starts.
  entry.mirror.lastInputAt = Date.now();
  await startScreencast(entry);
  eq(
    cdp.sent[2]?.params?.everyNthFrame,
    2,
    'recent input: every 2nd frame, ~30 fps — the active rate, not the idle one'
  );

  // --- and the ACTIVE rate is configurable, through the same clamp the ------
  // --- recorder uses -----------------------------------------------------
  // everyNthFrame is a DIVISOR of the composite rate, not an fps value, so the
  // setting is mapped rather than passed through. Round-trip a few values to
  // pin that mapping (and its clamp) rather than the arithmetic in isolation.
  // Each of these simulates a recent input (lastInputAt = now) so the mapping
  // under test is `mirrorFrameRate` → active divisor, not the idle one that a
  // fresh, never-touched session would otherwise land on (see above).
  for (const [mirrorFrameRate, nth, note] of [
    [30, 2, 'the maximum halves the composite rate rather than asking for 30 in the parameter'],
    [15, 4, 'a mid setting divides exactly'],
    [1, 60, 'the minimum is one frame a second'],
    [1000, 2, 'a value above the maximum is clamped to 30 fps, not honoured'],
    [0, 60, 'a value below the minimum is clamped to 1 fps, never to a divisor of zero'],
    // clampFps's own non-finite fallback is a fixed 10 fps (src/recording.ts)
    // — independent of the mirror's DEFAULT_MIRROR_FPS (30), which only
    // applies when the setting is absent entirely, not merely unreadable.
    ['nonsense', 6, 'a non-numeric (but present) setting falls back to clampFps\'s own 10 fps, not the mirror default of 30'],
  ]) {
    globalThis.__config = { remoteVnc: { mirrorFrameRate } };
    const rated = fakeEntry(fakeCdp());
    rated.mirror.lastInputAt = Date.now(); // exercise the active mapping, not idle
    await startScreencast(rated);
    eq(rated.mirror.cdp.sent[0]?.params?.everyNthFrame, nth, `mirrorFrameRate ${mirrorFrameRate}: ${note}`);
  }
  globalThis.__config = undefined;

  // --- input marks activity through the real message path, and a rate ------
  // --- change restarts the stream exactly once, not on every keystroke -----
  {
    const cdp2 = fakeCdp();
    const typed = fakeEntry(cdp2);
    await startScreencast(typed); // idle: no input recorded yet
    eq(typed.mirror.everyNthFrame, 6, 'starts idle, same as the untouched case above');

    // A real keydown, routed the same way media/pageMirror.ts's webview sends
    // one — this is what proves noteMirrorInput is actually wired into
    // handleMirrorMessage, not just callable in isolation.
    await handleMirrorMessage(typed, { type: 'input', kind: 'key', event: 'keyDown', key: 'a' });
    ok(typeof typed.mirror.lastInputAt === 'number', 'forwarding input records when it happened');
    const startsAfterFirstKey = cdp2.sent.filter((s) => s.method === 'Page.startScreencast').length;
    eq(startsAfterFirstKey, 2, 'the rate changed (idle -> active), so the screencast restarted once');
    eq(typed.mirror.everyNthFrame, 2, 'now running at the active rate');

    // A second keystroke inside the same active window must NOT restart the
    // screencast again — the rate has not changed, and restarting anyway
    // would thrash the ack queue for nothing. This exact seam (running +
    // unacked kept consistent across a restart) has already produced two
    // silent stalls on this branch.
    await handleMirrorMessage(typed, { type: 'input', kind: 'key', event: 'keyDown', key: 'b' });
    eq(
      cdp2.sent.filter((s) => s.method === 'Page.startScreencast').length,
      startsAfterFirstKey,
      'a second keystroke at the same rate does not restart the screencast again'
    );
    eq(typed.mirror.unacked.length, 0, 'the ack queue is still consistent — nothing left over from the one real restart');
  }

  // --- applyMirrorRate: the active window elapsing drops back to idle, and --
  // --- an unchanged rate never restarts (the debounce timer's own logic, ---
  // --- exercised directly instead of waiting on a real 2s setTimeout) -------
  {
    const cdp3 = fakeCdp();
    const idling = fakeEntry(cdp3);
    idling.mirror.lastInputAt = Date.now() - 10_000; // already well past the active window
    await startScreencast(idling);
    eq(idling.mirror.everyNthFrame, 6, 'stale input (older than the active window) starts idle, not active');

    idling.mirror.lastInputAt = Date.now(); // "an input just landed"
    await applyMirrorRate(idling);
    eq(idling.mirror.everyNthFrame, 2, 'a fresh input flips a RUNNING stream onto the active rate');

    idling.mirror.lastInputAt = Date.now() - 10_000; // "the active window has now elapsed"
    await applyMirrorRate(idling);
    eq(idling.mirror.everyNthFrame, 6, 'and the window elapsing flips a running stream back to idle');

    const restartsSoFar = cdp3.sent.filter((s) => s.method === 'Page.startScreencast').length;
    await applyMirrorRate(idling); // still idle — nothing changed
    eq(
      cdp3.sent.filter((s) => s.method === 'Page.startScreencast').length,
      restartsSoFar,
      're-evaluating at an unchanged rate does not restart the screencast'
    );

    // A session that is not currently streaming (hidden, unfocused, still
    // launching) has nothing to re-rate — applyMirrorRate must not start one.
    const notRunning = fakeEntry(fakeCdp());
    notRunning.mirror.lastInputAt = Date.now();
    await applyMirrorRate(notRunning);
    eq(notRunning.mirror.cdp.sent.length, 0, 'applyMirrorRate never starts a stream that was not already running');
  }

  // --- IMPORTANT 7: a failed RESTART leaves `running` TRUE, not false -------
  // Chrome's PREVIOUS Page.startScreencast is not implicitly stopped by a
  // failed later one — the old cast may still be live at the stale rate.
  // Marking `running` false (as a fresh start's failure correctly does) would
  // be a second bug on top of the first: stopScreencast's own guard
  // (`!session.running`) would then refuse to ever issue Page.stopScreencast
  // again, so nothing — not a blur, not hiding the tab, not a webview
  // rebuild — could reach that still-live cast; only closing the tab could.
  // `running` stays true specifically so a later stop attempt can still try.
  {
    globalThis.__logWarnings = [];
    const cdp2 = fakeCdp();
    const entry2 = fakeEntry(cdp2);
    await startScreencast(entry2); // a normal, successful start (idle rate)
    ok(entry2.mirror.running, 'the initial start succeeded');
    const staleNth = entry2.mirror.everyNthFrame;

    // The NEXT Page.startScreencast — the rate restart below — fails.
    cdp2.send = async (method, params, sessionId) => {
      cdp2.sent.push({ method, params, sessionId });
      throw new Error('CDP connection closed');
    };
    entry2.mirror.lastInputAt = Date.now(); // forces idle -> active: a real rate change
    await applyMirrorRate(entry2);
    eq(
      entry2.mirror.running,
      true,
      'a failed RESTART leaves running TRUE — a fresh start failure is the only case that sets it false'
    );
    eq(
      entry2.mirror.everyNthFrame,
      staleNth,
      'the STALE rate is left recorded — the failed restart never got to overwrite it'
    );
    // A later stop must still be able to reach Chrome — this is the whole
    // point of leaving `running` true. stopScreencast's own guard would
    // refuse (no-op) if running had been left false here.
    await stopScreencast(entry2);
    eq(
      cdp2.sent.some((s) => s.method === 'Page.stopScreencast'),
      true,
      'and a later stop actually attempts Page.stopScreencast, instead of no-opping on a falsely-false running flag'
    );

    // The warning must not name a "rate change" specifically (this same path
    // is reached by applyViewport too — see below) and must not claim
    // hiding/blurring will resolve it on its own.
    const warning = globalThis.__logWarnings.find((w) => /restarting the screencast failed/i.test(w));
    ok(warning, `a failed restart is logged (got: ${JSON.stringify(globalThis.__logWarnings)})`);
    eq(/rate change/i.test(warning ?? ''), false, 'the warning must not claim it was specifically a rate change');
    eq(
      /will (fix|resolve)|self.?heal/i.test(warning ?? ''),
      false,
      'the warning must not claim hiding/showing will fix it on its own'
    );
    ok(/CDP connection|dropped/i.test(warning ?? ''), 'and should name the likelier cause: a dropped connection');
    globalThis.__logWarnings = undefined;
  }

  // --- and a genuinely FRESH start's failure still ends running:false -------
  // The distinction is entirely about wasRunning (session.running BEFORE the
  // call): a session that was never running has no live cast to protect, and
  // leaving `running` stuck true here would freeze the tab for good with
  // nothing left to retry it.
  {
    const cdp3 = fakeCdp(1); // the one and only Page.startScreencast rejects
    const fresh = fakeEntry(cdp3);
    await startScreencast(fresh);
    eq(fresh.mirror.running, false, "a fresh (never-running) session's failed start still ends running:false");
  }

  // --- MINOR: the SAME failure path, reached via applyViewport's own restart
  // --- (not applyMirrorRate), must not describe itself as a rate change ----
  {
    globalThis.__logWarnings = [];
    const cdp4 = fakeCdp();
    const resized = fakeEntry(cdp4, { viewport: { width: 1024, height: 768 } });
    await startScreencast(resized); // establishes a running stream first
    ok(resized.mirror.running, 'the initial start succeeded');

    cdp4.send = async (method, params, sessionId) => {
      cdp4.sent.push({ method, params, sessionId });
      // Only the restart itself fails — Emulation.setDeviceMetricsOverride
      // must still succeed, or applyViewport throws before ever reaching
      // startScreencast and this test would not exercise the path at all.
      if (method === 'Page.startScreencast') {
        throw new Error('CDP connection closed');
      }
      return {};
    };
    await applyViewport(resized); // a SIZE change, not a rate change, restarts the screencast
    eq(resized.mirror.running, true, 'a failed viewport-driven restart also leaves running true');
    const warning = globalThis.__logWarnings.find((w) => /restarting the screencast failed/i.test(w));
    ok(warning, `the viewport restart failure is logged too (got: ${JSON.stringify(globalThis.__logWarnings)})`);
    eq(
      /rate change/i.test(warning ?? ''),
      false,
      'a viewport-driven restart failure must not be described as a rate change either'
    );
    globalThis.__logWarnings = undefined;
  }

  // --- MINOR: an explicit everyNthFrame is honoured, not recomputed ----------
  // applyMirrorRate already computes it once to decide whether a restart is
  // even warranted; startScreencast must use that same value rather than
  // reading remoteVnc.mirrorFrameRate and Date.now() again for one restart,
  // which risked the active/idle boundary flipping between the two reads.
  {
    const cdp3 = fakeCdp();
    const explicit = fakeEntry(cdp3); // idle by default — config would give 6, not 42
    await startScreencast(explicit, 42);
    eq(cdp3.sent[0]?.params?.everyNthFrame, 42, 'an explicit everyNthFrame is sent as given, not recomputed');
    eq(explicit.mirror.everyNthFrame, 42, 'and recorded as given, once accepted');
  }

  // --- and a claimed stream is not started twice ---------------------------
  // 3, not 2: `entry`/`cdp` already picked up one extra restart above (idle ->
  // active, once a recent input was simulated on it).
  await ensureStreaming(entry);
  eq(cdp.sent.length, 3, 'a running stream is not started again');

  // --- the gates, each on its own ------------------------------------------
  // Each of these is a real state the panel passes through: launching (no
  // session yet), hidden (VS Code tore the webview down), re-shown but not
  // yet re-announced, and visible-but-unfocused. Streaming into any of them
  // means frames nobody acks — or, for the last one, frames nobody is even
  // looking at, which the CPU still pays for exactly the same.
  for (const [label, over] of [
    ['a panel with no session yet', { mirror: undefined }],
    // active: true here on purpose — otherwise this case tests nothing but
    // the focus gate a second time, since an omitted `active` is falsy and
    // both gates would fail regardless of which one the code actually checks
    // first.
    ['a hidden panel', { panel: { visible: false, active: true } }],
    ['a webview that has not announced itself', { webviewLive: false }],
    // Visible but not the FOCUSED tab — e.g. shown in a split view while a
    // source file in the other group has focus. Losing focus is enough on
    // its own to stop streaming; it does not also require losing visibility.
    ['a visible but unfocused panel', { panel: { visible: true, active: false } }],
  ]) {
    const quiet = fakeCdp();
    await ensureStreaming(fakeEntry(quiet, over));
    eq(quiet.sent.length, 0, `no stream is started for ${label}`);
  }

  // --- IMPORTANT 3: a FAILED record-start re-evaluates the gate immediately -
  // The sharper of the two cases the fix covers: ensureStreaming was already
  // called (see startPageRecording/startPageRecordingInteractive, BEFORE the
  // webview's ack arrives), so a failure here — recording flipping back to
  // 'idle' — can leave a stream running on a visible-but-unfocused tab that
  // nothing else will ever ask to stop, at the idle rate, for the rest of
  // the tab's life.
  {
    const cdp5 = fakeCdp();
    const unfocused = fakeEntry(cdp5, {
      panel: { visible: true, active: false },
      recording: 'starting', // as if startPageRecording had just called ensureStreaming
      recordStartWaiters: [],
      recordStopWaiters: [],
    });
    await startScreencast(unfocused); // the in-flight recording start is what kept this running
    ok(unfocused.mirror.running, 'streaming while unfocused, because a recording start is in flight');

    // handleRecordMessage toasts every record-status error unconditionally
    // (by design — see its own doc comment); the stub throws on an
    // un-opted-in dialog call as a tripwire, so opt in here.
    globalThis.__dialogsEnabled = true;
    await handleMirrorMessage(unfocused, {
      type: 'record-status',
      recording: false,
      error: 'no frame has been painted yet',
    });
    globalThis.__dialogsEnabled = false;
    await new Promise((resolve) => setTimeout(resolve, 0)); // let stopScreencast's CDP send settle

    eq(unfocused.recording, 'idle', 'recording state reset by the failed ack');
    eq(
      cdp5.sent.some((s) => s.method === 'Page.stopScreencast'),
      true,
      'the screencast is stopped immediately once the failed start ack arrives — not orphaned running'
    );
  }

  // --- and regaining focus starts the stream again ---------------------------
  {
    const refocusing = fakeCdp();
    const bg = fakeEntry(refocusing, { panel: { visible: true, active: false } });
    await ensureStreaming(bg);
    eq(refocusing.sent.length, 0, 'still unfocused: nothing starts');
    bg.panel.active = true;
    await ensureStreaming(bg);
    eq(refocusing.sent.length, 1, 'regaining focus is enough on its own to start the stream');
  }

  // --- CRITICAL: a recording tab is exempt from the focus gate ---------------
  // captureStream (media/recorder.ts) draws from the canvas, which only
  // repaints when a screencast frame arrives — so a visible-but-unfocused tab
  // that is recording still needs frames, unlike one that is merely visible.
  // Both non-chord ways to start a recording (the Web Pages tree's record
  // button, and the control server's record()) routinely run on exactly this
  // state, which is why this cannot be left to the ordinary focus gate.
  {
    const recording = fakeCdp();
    const bg = fakeEntry(recording, {
      panel: { visible: true, active: false },
      recording: 'recording',
    });
    await ensureStreaming(bg);
    eq(
      recording.sent.some((s) => s.method === 'Page.startScreencast'),
      true,
      'a visible-but-unfocused tab that is recording still starts the screencast'
    );
  }

  // --- a restart clears the ack queue --------------------------------------
  // Frame ids from a previous run mean nothing to Chrome; acking them would
  // walk the queue out of step with the frames actually in flight.
  const restarting = fakeEntry(fakeCdp());
  restarting.mirror.unacked.push(1, 1, 1);
  await startScreencast(restarting);
  eq(restarting.mirror.unacked.length, 0, 'starting a screencast drops stale frame ids');
  ok(restarting.mirror.running, 'and claims the stream when the start succeeds');

  // --- the same family, one level up: session.size is a cache of what Chrome
  // has ACCEPTED. Recorded before the send, a rejected override still reads as
  // applied, the next call at that size early-returns on the equality guard,
  // and the page is laid out for the wrong viewport for the life of the tab —
  // the same shape of silent, permanent failure as a stuck `running`.
  {
    const cdp = fakeCdp(1); // the first setDeviceMetricsOverride rejects
    const entry = fakeEntry(cdp, { viewport: { width: 1024, height: 768 } });
    entry.mirror.size = { width: 0, height: 0 };

    let threw = false;
    try {
      await applyViewport(entry);
    } catch {
      threw = true; // the caller logs it (logMirrorFailure); the point is what state is left
    }
    ok(threw, 'a rejected override is not swallowed here');
    eq(cdp.sent[0]?.method, 'Emulation.setDeviceMetricsOverride', 'the override was attempted');
    eq(
      entry.mirror.size,
      { width: 0, height: 0 },
      'a rejected override records nothing — the size Chrome never accepted is not cached'
    );

    // Which is the only reason the retry happens at all.
    await applyViewport(entry);
    eq(cdp.sent.length, 2, 'the next call at the same size retries instead of early-returning');
    eq(
      entry.mirror.size,
      { width: 1024, height: 768 },
      'and the accepted size IS recorded, so a third call at that size is skipped'
    );
    await applyViewport(entry);
    eq(cdp.sent.length, 2, 'an override already in force is not re-sent');
  }

  // --- BACKPRESSURE: the input path counts what it has outstanding ----------
  // Input.dispatch*'s CDP response is deferred by Chromium until the page's
  // RENDERER acknowledges the event, and nothing here ever capped, coalesced,
  // timed out or counted them — so a renderer that fell behind was fed faster
  // than it could drain, forever. Measured on the reporting machine: a ~78
  // second session typed into a mirrored page tore down with 128 dispatches
  // unanswered, a ~39 second one with 15, and a ~4.5 minute session that was
  // only WATCHED with none. The mirror went from laggy to accepting no input
  // at all, silently, while frames kept arriving (capture and encode are
  // browser-process work, independent of the renderer's input queue) — which
  // is why it read as broken rather than busy.
  {
    globalThis.__logWarnings = [];
    globalThis.__logInfos = [];
    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];

    const cdp = deferredInputCdp();
    const typing = fakeEntry(cdp); // not streaming: this block is the input path alone
    const outstanding = [];
    for (let i = 0; i < MAX_INFLIGHT_INPUT; i++) {
      // Deliberately NOT awaited: an awaited dispatch is a dispatch that has
      // been answered, which is the one state this cannot be tested in.
      outstanding.push(handleMirrorMessage(typing, keyDown));
    }
    eq(
      typing.mirror.inFlightInput,
      MAX_INFLIGHT_INPUT,
      'every unanswered Input.dispatch* is counted — the number the last investigation had to recover from a teardown dump'
    );
    eq(typing.mirror.peakInFlightInput, MAX_INFLIGHT_INPUT, 'and its high-water mark is kept');
    eq(
      cdp.sent[0]?.timeoutMs,
      10_000,
      'each dispatch carries its own watchdog, so one Chrome never answers cannot pin the count above the cap forever'
    );

    // The visible half. Frames keep arriving while this is true, so without
    // it the user's only evidence is a page ignoring them.
    eq(typing.mirror.degraded, true, 'the mirror marks itself degraded at the cap');
    eq(
      typing.panel.webview.posted.filter((m) => m.type === 'degraded' && m.degraded).length,
      1,
      'the canvas is told once, not once per event'
    );
    const warnings = globalThis.__logWarnings.filter((w) => /waiting on the/i.test(w));
    eq(warnings.length, 1, 'the Output channel is warned exactly once per session, not per keystroke');
    ok(
      /\b8\b/.test(warnings[0] ?? '') && /cap 8/.test(warnings[0] ?? ''),
      `and the warning carries the actual depth and cap (got: ${warnings[0]})`
    );
    const toasts = globalThis.__dialogCalls.filter((c) => c.name === 'showWarningMessage');
    eq(toasts.length, 1, 'and the user is told once, with a way out');
    ok(
      toasts[0]?.args.includes('Restart Mirror'),
      `the toast offers the restart, so the escape hatch is reachable from the failure itself (got: ${JSON.stringify(toasts[0]?.args)})`
    );

    // Motion is the only thing that may be dropped: the next move carries
    // absolute coordinates, so losing one leaves no trace.
    const movesBefore = cdp.inputs('mouseMoved');
    // Not awaited, and that is the assertion's whole shape: a move that is
    // REFUSED settles immediately, while one that was forwarded joins the
    // queue and never settles here — awaiting it would turn a regression into
    // a hung suite instead of a failed assertion.
    const refused = handleMirrorMessage(typing, mouseMoved);
    let refusedSettled = false;
    void refused.then(() => {
      refusedSettled = true;
    });
    outstanding.push(refused);
    await new Promise((resolve) => setTimeout(resolve, 0));
    eq(refusedSettled, true, 'a refused move returns at once instead of joining the queue');
    eq(cdp.inputs('mouseMoved'), movesBefore, 'over the cap, pointer motion is no longer forwarded');
    eq(typing.mirror.droppedMoves, 1, 'and the drop is counted rather than silently swallowed');
    eq(typing.mirror.inFlightInput, MAX_INFLIGHT_INPUT, 'a dropped move adds nothing to the queue');

    // Keys and clicks are not. A lost keystroke is a character the user typed
    // and never got — strictly worse than a late one.
    outstanding.push(handleMirrorMessage(typing, keyDown));
    eq(
      cdp.inputs('keyDown'),
      MAX_INFLIGHT_INPUT + 1,
      'keys are still forwarded over the cap — the whole point is that typing keeps landing'
    );
    outstanding.push(
      handleMirrorMessage(typing, { type: 'input', kind: 'mouse', event: 'mousePressed', x: 1, y: 2 })
    );
    eq(cdp.inputs('mousePressed'), 1, 'and so are clicks, which carry the point a drag starts at');
    eq(typing.mirror.inFlightInput, MAX_INFLIGHT_INPUT + 2, 'both were counted in');
    eq(typing.mirror.peakInFlightInput, MAX_INFLIGHT_INPUT + 2, 'the peak follows them up');

    // --- and it recovers, instead of degrading permanently ------------------
    cdp.settle();
    await Promise.all(outstanding);
    eq(typing.mirror.inFlightInput, 0, 'answered dispatches leave the queue');
    eq(typing.mirror.degraded, false, 'a drained queue clears the degraded state');
    eq(
      typing.panel.webview.posted.filter((m) => m.type === 'degraded' && !m.degraded).length,
      1,
      'and the canvas is told the banner can go'
    );
    const cleared = globalThis.__logInfos.find((l) => /backlog cleared/i.test(l));
    ok(cleared, `recovery is logged too (got: ${JSON.stringify(globalThis.__logInfos)})`);
    ok(
      /peak 10/.test(cleared ?? '') && /1 pointer moves dropped/.test(cleared ?? ''),
      `with the numbers the next investigation needs (got: ${cleared})`
    );

    // Motion flows again — the cap is a valve, not a latch.
    const movesBeforeRecovery = cdp.inputs('mouseMoved');
    outstanding.push(handleMirrorMessage(typing, mouseMoved));
    eq(cdp.inputs('mouseMoved'), movesBeforeRecovery + 1, 'once the queue drains, pointer motion is forwarded again');
    cdp.settle();
    await Promise.all(outstanding);

    // --- and the SECOND episode is silent in the log, loud on the canvas ----
    // The two halves are latched differently on purpose: the banner follows
    // the state (it must come back, or the user is once again left guessing),
    // while the warning and the toast fire once per session — this path runs
    // per keystroke, and a message per keystroke is not a message.
    const secondEpisode = [];
    for (let i = 0; i < MAX_INFLIGHT_INPUT; i++) {
      secondEpisode.push(handleMirrorMessage(typing, keyDown));
    }
    eq(typing.mirror.degraded, true, 'a second backlog degrades the mirror again');
    eq(
      typing.panel.webview.posted.filter((m) => m.type === 'degraded' && m.degraded).length,
      2,
      'and the canvas is told again — the banner has to come back or nobody knows'
    );
    eq(
      globalThis.__logWarnings.filter((w) => /waiting on the/i.test(w)).length,
      1,
      'but the Output channel is still warned exactly ONCE for the whole session'
    );
    eq(
      globalThis.__dialogCalls.filter((c) => c.name === 'showWarningMessage').length,
      1,
      'and the user is toasted once, not once per episode'
    );
    cdp.settle();
    await Promise.all(secondEpisode);

    // The teardown line: for a session that never recovers, this is the only
    // place the depth it reached is ever written down.
    globalThis.__logInfos = [];
    closeMirror(typing);
    const closing = globalThis.__logInfos.find((l) => /closing "page"/.test(l));
    ok(closing, `closing a mirror that was typed into records its input pressure (got: ${JSON.stringify(globalThis.__logInfos)})`);
    ok(/peak 10/.test(closing ?? ''), `including the peak depth (got: ${closing})`);

    // A mirror that was only WATCHED says nothing — which is itself the
    // signal: the count tracks input volume, not uptime.
    globalThis.__logInfos = [];
    closeMirror(fakeEntry(fakeCdp()));
    eq(
      globalThis.__logInfos.filter((l) => /closing/.test(l)).length,
      0,
      'a mirror nobody typed into logs no input pressure at close'
    );

    globalThis.__dialogsEnabled = false;
    globalThis.__logWarnings = undefined;
    globalThis.__logInfos = undefined;
  }

  // --- the divisor is claimed SYNCHRONOUSLY, before the round trip ----------
  // `running` was claimed before the await and `everyNthFrame` only after it,
  // so every input that arrived inside that window compared against the OLD
  // divisor and fired its own duplicate Page.startScreencast. Bounded at a few
  // per rate transition on a healthy machine — but the bound is "how many
  // events arrive while Chrome is answering", which is exactly the quantity
  // that grows when a mirror is already in trouble.
  {
    const hanging = {
      sent: [],
      send: (method, params, sessionId) => {
        hanging.sent.push({ method, params, sessionId });
        // Never settles: this IS the window the duplicates were fired in.
        return method === 'Page.startScreencast' ? new Promise(() => {}) : Promise.resolve({});
      },
    };
    const racing = fakeEntry(hanging);
    racing.mirror.running = true;
    racing.mirror.everyNthFrame = 6; // idle, as accepted by Chrome
    racing.mirror.pendingEveryNthFrame = 6;
    racing.mirror.lastInputAt = Date.now(); // wants the active divisor (2)

    void applyMirrorRate(racing);
    void applyMirrorRate(racing);
    void applyMirrorRate(racing);
    await new Promise((resolve) => setTimeout(resolve, 0));

    eq(
      hanging.sent.filter((s) => s.method === 'Page.startScreencast').length,
      1,
      'three inputs inside one in-flight restart produce ONE Page.startScreencast, not three'
    );
    eq(
      racing.mirror.everyNthFrame,
      6,
      'and the accepted divisor is still the old one — proving it was the CLAIM that deduped, not a resolved round trip'
    );
    eq(racing.mirror.pendingEveryNthFrame, 2, 'the claim itself records what was asked for');
  }

  // --- a restart that REJECTED must not restart once per input, forever -----
  // The accepted divisor stays stale when a restart fails (deliberately — see
  // IMPORTANT 7 above), so comparing against it made the "has the rate
  // changed?" test true on every single input event for as long as the
  // failure lasted. It has never fired on the reporting machine, but nothing
  // bounds it if it does.
  {
    globalThis.__logWarnings = [];
    const failing = {
      sent: [],
      send: (method, params, sessionId) => {
        failing.sent.push({ method, params, sessionId });
        return method === 'Page.startScreencast'
          ? Promise.reject(new Error('CDP connection closed'))
          : Promise.resolve({});
      },
    };
    const rejected = fakeEntry(failing);
    rejected.mirror.running = true;
    rejected.mirror.everyNthFrame = 6;
    rejected.mirror.pendingEveryNthFrame = 6;
    const starts = () => failing.sent.filter((s) => s.method === 'Page.startScreencast').length;

    // The first keystroke: idle -> active is a real rate change, so a restart
    // is attempted, and it fails.
    await handleMirrorMessage(rejected, keyDown);
    eq(starts(), 1, 'the rate change was attempted');
    eq(rejected.mirror.everyNthFrame, 6, 'and the failure left the accepted divisor stale, as it must');

    // Every keystroke after it is inside the same active window, so nothing
    // about the wanted rate has changed.
    for (const _ of [1, 2, 3, 4, 5]) {
      await handleMirrorMessage(rejected, keyDown);
    }
    eq(starts(), 1, 'five more keystrokes at the same rate attempt no further restarts');

    // But it is a claim, not a lockout: a genuinely different rate is still
    // asked for, which is how this self-heals when the active window elapses.
    rejected.mirror.lastInputAt = Date.now() - 10_000;
    await applyMirrorRate(rejected);
    eq(starts(), 2, 'a genuinely different divisor is still attempted — the claim is not a lockout');
    globalThis.__logWarnings = undefined;
  }

  // --- THE ESCAPE HATCH: a mirror frozen with a LIVE webview ----------------
  // restartMirrorWebview was the documented recovery and was gated on
  // `!webviewLive` — unreachable for exactly this case. The webview is fine:
  // its canvas paints, it acks, it reports its size. What is stuck is the
  // renderer's handling of input. So reopen() took the webviewLive === true
  // branch, where applyViewport early-returns (the size has not changed) and
  // ensureStreaming early-returns (`running` is still true): two awaits and
  // nothing happens, which is worse than no escape hatch at all.
  {
    globalThis.__logInfos = [];
    const cdp = fakeCdp();
    const frozen = fakeEntry(cdp);
    frozen.webviewLive = true; // the webview is alive — this is the whole point
    frozen.mirror.running = true; // and the host believes it is streaming
    frozen.mirror.inFlightInput = 12;
    frozen.mirror.peakInFlightInput = 12;
    frozen.mirror.droppedMoves = 40;
    frozen.mirror.degraded = true;
    frozen.mirror.warnedDegraded = true;
    const htmlBefore = frozen.panel.webview.html;

    await reopenMirror(frozen);

    eq(
      cdp.sent.some((s) => s.method === 'Page.stopScreencast'),
      true,
      're-opening a mirrored page actually restarts the stream instead of no-opping on two early returns'
    );
    eq(frozen.mirror.running, false, 'the stream is unclaimed, so the rebuilt webview can start one');
    eq(frozen.webviewLive, false, 'and the webview is marked gone until the fresh bundle announces itself');
    ok(
      frozen.panel.webview.html !== htmlBefore && /<canvas/.test(frozen.panel.webview.html),
      'the surface is genuinely rebuilt — a memoised nonce here would make this a silent no-op'
    );
    eq(frozen.mirror.inFlightInput, 0, 'the abandoned queue is reset');
    eq(frozen.mirror.degraded, false, 'and the mirror stops calling itself degraded');
    eq(
      frozen.mirror.warnedDegraded,
      false,
      'the once-per-session voice is rearmed too, so the user hears whether the restart actually helped'
    );
    ok(
      globalThis.__logInfos.some((l) => /restarting the surface/i.test(l) && /peak 12/.test(l)),
      `and the restart records the pressure it was restarted at (got: ${JSON.stringify(globalThis.__logInfos)})`
    );

    // A recording lives in the very canvas a rebuild throws away, so THAT
    // case keeps the old behaviour rather than silently ending someone's take.
    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];
    const recordingCdp = fakeCdp();
    const busy = fakeEntry(recordingCdp, { recording: 'recording' });
    busy.mirror.running = true;
    const busyHtml = busy.panel.webview.html;
    await reopenMirror(busy);
    eq(
      busy.panel.webview.html === busyHtml,
      true,
      'a tab that is recording is not rebuilt out from under the take'
    );
    ok(
      globalThis.__dialogCalls.some(
        (c) => c.name === 'showInformationMessage' && /recording is in progress/i.test(c.args[0])
      ),
      `and the user is told why nothing happened (got: ${JSON.stringify(globalThis.__dialogCalls)})`
    );
    globalThis.__dialogsEnabled = false;

    // The same recovery, addressed the way the command and the tree row hold
    // it: by registry id.
    const byId = fakeEntry(fakeCdp());
    byId.mirror.running = true;
    openPanelsById.set('page-id', byId);
    eq(restartMirrorPage('page-id'), true, 'the command finds an open mirrored page by id');
    await new Promise((resolve) => setTimeout(resolve, 0));
    eq(
      byId.mirror.cdp.sent.some((s) => s.method === 'Page.stopScreencast'),
      true,
      'and restarts it'
    );
    eq(
      restartMirrorPage('not-open'),
      false,
      'and reports "nothing to restart" rather than doing nothing quietly — the caller words that for the user'
    );
    openPanelsById.delete('page-id');

    // recoverMirror on a page whose Chrome never came up must not throw: the
    // tab exists, the session does not.
    const launching = fakeEntry(fakeCdp(), { mirror: undefined });
    let recoverThrew = false;
    try {
      await recoverMirror(launching);
    } catch {
      recoverThrew = true;
    }
    eq(recoverThrew, false, 'recovering a mirror that has no session yet rebuilds the surface without throwing');
    globalThis.__logInfos = undefined;
  }

  // --- deactivation must be awaitable ---------------------------------------
  // The browser handle itself is unreachable from here (only sharedBrowser
  // assigns it, and that spawns Chrome), so this pins the one thing a test CAN
  // see: the signature src/extension.ts's `await` depends on. Returning void
  // again would leave a pending launch's kill scheduled after the extension
  // host is gone — a headless Chrome that outlives the window.
  const disposal = disposePageMirrors();
  ok(typeof disposal?.then === 'function', 'disposePageMirrors returns a promise for deactivate to await');
  await disposal;
}
