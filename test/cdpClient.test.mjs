import { load } from './bundle.mjs';

function fakeSocket() {
  const sent = [];
  let onMsg = () => {};
  let onClose = () => {};
  return {
    sent,
    send: (d) => sent.push(JSON.parse(d)),
    close: () => onClose(),
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onClose = cb; },
    deliver: (obj) => onMsg(JSON.stringify(obj)),
  };
}

export default async function ({ ok, eq }) {
  const { CdpConnection, CDP_REQUEST_TIMEOUT_MS } = await load('cdpClient.ts');

  const sock = fakeSocket();
  const cdp = new CdpConnection(sock);

  // requests get incrementing ids and resolve on the matching response
  const p = cdp.send('Page.enable', { a: 1 }, 'S1');
  eq(sock.sent[0].method, 'Page.enable', 'method sent');
  eq(sock.sent[0].params.a, 1, 'params sent');
  eq(sock.sent[0].sessionId, 'S1', 'sessionId sent');
  const id = sock.sent[0].id;
  ok(typeof id === 'number', 'id is a number');

  sock.deliver({ id, result: { ok: true } });
  eq((await p).ok, true, 'resolves with result');

  // a second request gets a distinct, incrementing id
  const p1b = cdp.send('Page.disable');
  ok(sock.sent[1].id > id, 'second request id increments');
  sock.deliver({ id: sock.sent[1].id, result: {} });
  await p1b;

  // an error response rejects
  const p2 = cdp.send('Bad.method');
  sock.deliver({ id: sock.sent[2].id, error: { code: -32601, message: 'nope' } });
  let rejected = false;
  try { await p2; } catch (e) { rejected = String(e).includes('nope'); }
  ok(rejected, 'error response rejects with its message');

  // events reach the registered handler
  let seen;
  cdp.on('Page.screencastFrame', (params, sessionId) => { seen = { params, sessionId }; });
  sock.deliver({ method: 'Page.screencastFrame', params: { data: 'X' }, sessionId: 'S1' });
  eq(seen.params.data, 'X', 'event params delivered');
  eq(seen.sessionId, 'S1', 'event sessionId delivered');

  // a malformed/unrecognised frame is dropped, not thrown: an object with
  // neither `id` nor `method` matches no pending request and no handler.
  let malformedThrew = false;
  try { sock.deliver({ garbage: true }); } catch { malformedThrew = true; }
  ok(!malformedThrew, 'malformed frame did not throw');

  // a response whose id matches nothing pending (already resolved, or never
  // sent) is ignored rather than thrown on — Chrome can be chatty after a
  // request has settled, and a stray reply must not crash the connection.
  let unknownIdThrew = false;
  try { sock.deliver({ id: 999999, result: { ok: true } }); } catch { unknownIdThrew = true; }
  ok(!unknownIdThrew, 'response with unknown id did not throw');

  // two handlers registered for the same method both fire — registering the
  // second must append, not displace the first (a Map.set of a fresh array
  // would silently drop earlier subscribers).
  let seenA, seenB;
  cdp.on('Page.screencastFrame', (params) => { seenA = params.data; });
  cdp.on('Page.screencastFrame', (params) => { seenB = params.data; });
  sock.deliver({ method: 'Page.screencastFrame', params: { data: 'Y' } });
  eq(seenA, 'Y', 'first handler for a shared method still fires');
  eq(seenB, 'Y', 'second handler for a shared method also fires');

  // close rejects every request still in flight, not just the first
  const p3 = cdp.send('Page.enable');
  const p4 = cdp.send('Page.disable');
  sock.close();
  let p3Rejected = false;
  let p4Rejected = false;
  try { await p3; } catch { p3Rejected = true; }
  try { await p4; } catch { p4Rejected = true; }
  ok(p3Rejected && p4Rejected, 'all in-flight requests reject on close');

  // and a request made after close is rejected outright, not left hanging
  let afterCloseRejected = false;
  try { await cdp.send('Page.enable'); } catch { afterCloseRejected = true; }
  ok(afterCloseRejected, 'requests after close are rejected immediately');

  // dispose() rejects anything still in flight, exercised on a fresh
  // connection so it is not entangled with the close() path above.
  const sock2 = fakeSocket();
  const cdp2 = new CdpConnection(sock2);
  const p5 = cdp2.send('Page.enable');
  cdp2.dispose();
  let p5Rejected = false;
  try { await p5; } catch { p5Rejected = true; }
  ok(p5Rejected, 'dispose() rejects an in-flight request');

  // dispose() again, with nothing pending, must not throw or double-reject
  // an already-settled promise.
  let disposeAgainThrew = false;
  try { cdp2.dispose(); } catch { disposeAgainThrew = true; }
  ok(!disposeAgainThrew, 'calling dispose() again does not throw');

  // a socket that throws synchronously — `ws` does exactly this on a socket
  // that is closing — must not leave its entry in `pending`. No response will
  // ever carry that id, so nothing else deletes it: over a long mirroring
  // session the map grows without bound. `pending` is a TypeScript `private`,
  // which is an ordinary property at runtime, and reading it here is the only
  // way to see the leak at all — invisible through the public API is precisely
  // how it grew unnoticed.
  const sock3 = fakeSocket();
  const cdp3 = new CdpConnection(sock3);
  const neverAnswered = cdp3.send('Page.enable');
  eq(cdp3.pending.size, 1, 'an unanswered request is held in `pending` — the map the leak grows in');
  sock3.send = () => { throw new Error('WebSocket is not open'); };
  let sendThrowRejected = false;
  try {
    await cdp3.send('Page.navigate');
  } catch (e) {
    sendThrowRejected = String(e).includes('WebSocket is not open');
  }
  ok(sendThrowRejected, 'a synchronous send failure rejects with the socket\'s own cause');
  eq(cdp3.pending.size, 1, 'and leaves nothing behind — still only the request genuinely in flight');
  eq(cdp3.inFlight, 1, 'and the depth is readable from outside, which is how the leak went unnoticed');
  cdp3.dispose();
  await neverAnswered.catch(() => {});

  // --- a request Chrome never answers must not sit in `pending` forever ----
  // The map had no timeout, no cap, and nothing read its size. That is not
  // hypothetical: Input.dispatchKeyEvent's response is deferred by Chromium
  // until the page's RENDERER acknowledges the key, and a ~78 second session
  // typed into a mirrored page tore down with 128 of them still unanswered.
  {
    const sock4 = fakeSocket();
    const cdp4 = new CdpConnection(sock4);
    const started = Date.now();
    // Raced rather than awaited: without a timeout this promise never settles
    // at all, and a plain `await` would hang the whole run instead of failing
    // the one assertion that regressed.
    const timedOut = await Promise.race([
      cdp4.send('Input.dispatchKeyEvent', { key: 'a' }, 'S1', 20).then(
        () => 'resolved, which it should not have',
        (e) => e
      ),
      new Promise((resolve) => setTimeout(() => resolve('still pending after 300ms'), 300)),
    ]);
    ok(
      timedOut instanceof Error,
      `an unanswered request rejects instead of hanging forever (got: ${timedOut})`
    );
    ok(
      /Input\.dispatchKeyEvent/.test(String(timedOut)) && /20ms/.test(String(timedOut)),
      `and names the method and the budget it blew (got: ${String(timedOut)})`
    );
    ok(Date.now() - started < 5_000, 'and does it on its own schedule, not the default one');
    eq(cdp4.inFlight, 0, 'the entry is REMOVED, not merely rejected — the entry is what leaks');

    // The response arriving late must not throw or re-settle anything: by
    // then nothing is listening for that id.
    let lateThrew = false;
    try { sock4.deliver({ id: sock4.sent[0].id, result: { ok: true } }); } catch { lateThrew = true; }
    ok(!lateThrew, 'a response arriving after the timeout is ignored, not thrown on');
  }

  // A request that IS answered leaves nothing armed behind it — a timer that
  // outlived its request would fire into a settled promise (harmless) and
  // hold the host awake for its full duration (not).
  {
    const sock5 = fakeSocket();
    const cdp5 = new CdpConnection(sock5);
    const answered = cdp5.send('Page.enable', {}, undefined, 20);
    sock5.deliver({ id: sock5.sent[0].id, result: { done: true } });
    eq((await answered).done, true, 'an answered request resolves normally with a timeout set');
    eq(cdp5.inFlight, 0, 'and is gone from the map');
    await new Promise((r) => setTimeout(r, 40)); // past its own timeout
    eq(cdp5.inFlight, 0, 'and the elapsed timer changes nothing after the fact');
  }

  // The DEFAULT has to stay generous. Page.captureScreenshot encodes a
  // full-resolution PNG in the browser process and Target.createTarget waits
  // on a cold dev server; a watchdog tight enough for a keystroke would break
  // both, which is why the tight one is passed per call (pagePanel.ts's
  // INPUT_DISPATCH_TIMEOUT_MS) instead of imposed here.
  eq(CDP_REQUEST_TIMEOUT_MS, 30_000, 'the default request timeout is 30s');
  {
    const sock6 = fakeSocket();
    const cdp6 = new CdpConnection(sock6);
    const slow = cdp6.send('Page.captureScreenshot', { format: 'png' }, 'S1');
    await new Promise((r) => setTimeout(r, 30));
    eq(cdp6.inFlight, 1, 'a slow capture is still waiting after 30ms, not cut off by the default');
    sock6.deliver({ id: sock6.sent[0].id, result: { data: 'AAA' } });
    eq((await slow).data, 'AAA', 'and resolves when the screenshot finally arrives');
  }
}
