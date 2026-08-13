// How the mirrored browser is spawned, and how it is reaped.
//
// This exists for two measured failures. The kill one: a mirrored page's
// Chrome is eleven processes, and SIGTERM to the browser process left TEN of
// them running three seconds later, holding 1.7 GB — the kill has to address
// Chrome's whole process group, which only exists because launchChrome spawns
// `detached`, and both halves of that are invisible from anywhere else. The
// launch-timeout one: 15s was a plan-time guess that missed on an ordinary
// open on a memory-constrained machine, and it was also hardcoded, so nobody
// could raise it without a code change.
//
// `launchChrome` itself is not reachable here (it spawns a real browser), but
// every piece that was actually wrong is: the spawn options are a plain
// exported value, killer() takes a fake child, pipeSocket and waitForChrome
// take a fake one too (so framing and the readiness timeout can be exercised
// without spawning anything), and clampLaunchTimeoutMs is pure.
import { EventEmitter } from 'node:events';
import { load } from './bundle.mjs';

/** A ChildProcess stand-in: records direct kills, can announce its own exit. */
function fakeChild(pid) {
  const direct = [];
  let onExit;
  return {
    pid,
    direct,
    kill: (signal) => direct.push(signal),
    once: (event, cb) => {
      if (event === 'exit') {
        onExit = cb;
      }
    },
    exit: () => onExit?.(),
  };
}

/** A `send` seam that records, and can be made to fail like the OS would. */
function recorder(fail) {
  const calls = [];
  return {
    calls,
    send: (pid, signal) => {
      calls.push({ pid, signal });
      if (fail) {
        throw fail;
      }
    },
  };
}

const errno = (code) => Object.assign(new Error(code), { code });

/**
 * Enough of a pipe-spawned ChildProcess: `stdio[3]` is the writable half we
 * send CDP on and `stdio[4]` the readable half Chrome answers on, both plain
 * emitters so a test can drive chunk boundaries by hand. Those boundaries are
 * the entire point — a WebSocket used to guarantee whole messages and a pipe
 * does not.
 */
function fakeChildForPipe() {
  const child = new EventEmitter();
  const written = [];
  const toChrome = { write: (d) => written.push(d), end: () => { child.ended = true; } };
  const fromChrome = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdio = [null, null, child.stderr, toChrome, fromChrome];
  child.written = written;
  child.fromChrome = fromChrome;
  return child;
}

export default async function ({ ok, eq }) {
  const {
    CHROME_SPAWN_OPTIONS,
    killer,
    clampLaunchTimeoutMs,
    DEFAULT_LAUNCH_TIMEOUT_MS,
    chromeArgs,
    pipeSocket,
    waitForChrome,
  } = await load('chromeProcess.ts');

  // --- the prerequisite ------------------------------------------------------
  // Without this, the child shares the extension host's process group and the
  // group kill below would be aimed at VS Code itself. It is not a tuning knob:
  // it is what makes -pid mean "Chrome's processes" rather than "ours".
  eq(
    CHROME_SPAWN_OPTIONS.detached,
    true,
    'Chrome is spawned detached, so it leads a process group of its own'
  );
  eq(
    CHROME_SPAWN_OPTIONS.stdio,
    ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    'and fd 3/4 are piped for CDP — stderr stays piped for launch diagnostics'
  );

  // --- the debugging surface is a pipe, not a TCP port -----------------------
  // `--remote-debugging-port` opens an HTTP/WebSocket server on loopback with
  // no credential of any kind: an ephemeral port is obscurity, not
  // authentication, and it is republished in DevToolsActivePort inside the
  // user-data-dir anyway. Any local process under any uid could read
  // /json/version and drive the browser — Runtime.evaluate, Page.navigate to
  // file://, the profile's cookies. CDP has no auth to switch on, so the fix
  // is to not have a socket: the pipe is reachable only through fds this
  // process handed the child.
  const args = chromeArgs('/tmp/profile');
  ok(args.includes('--remote-debugging-pipe'), 'CDP travels over the inherited fd pair');
  ok(
    !args.some((a) => a.startsWith('--remote-debugging-port')),
    'and no debugging port is opened — this is the assertion the whole change exists for'
  );
  ok(args.includes('--user-data-dir=/tmp/profile'), 'the profile directory is passed through');

  // --- pipeSocket: a byte stream made to look like the socket CdpConnection wants
  {
    const NUL = String.fromCharCode(0);
    const child = fakeChildForPipe();
    const socket = pipeSocket(child);

    socket.send('{"id":1,"method":"Browser.getVersion"}');
    eq(
      child.written,
      ['{"id":1,"method":"Browser.getVersion"}' + NUL],
      'a request is NUL-terminated on the way to fd 3'
    );

    const seen = [];
    socket.onMessage((m) => seen.push(m));
    child.fromChrome.emit('data', Buffer.from('{"id":1}' + NUL + '{"me'));
    eq(seen, ['{"id":1}'], 'a complete frame is delivered and the partial one is held back');
    child.fromChrome.emit('data', Buffer.from('thod":"x"}' + NUL));
    eq(seen, ['{"id":1}', '{"method":"x"}'], 'the held partial completes on the next chunk');

    let closed = 0;
    socket.onClose(() => closed++);
    child.emit('exit', 0);
    eq(closed, 1, "the browser exiting closes the socket — otherwise every in-flight request waits out its full timeout");
  }

  // --- waitForChrome: the launch either answers, dies, or times out ----------
  {
    const ok1 = await waitForChrome(fakeChildForPipe(), { send: async () => ({}) }, 1000)
      .then(() => 'resolved', (e) => `rejected: ${e.message}`);
    eq(ok1, 'resolved', 'a browser that answers the probe is up');

    const dead = fakeChildForPipe();
    const exited = waitForChrome(dead, { send: () => new Promise(() => {}) }, 1000)
      .then(() => 'resolved', (e) => e.message);
    dead.emit('exit', 9);
    ok(/exited with code 9/.test(await exited), 'a browser that dies first rejects naming its exit code, not after the full timeout');

    const bad = fakeChildForPipe();
    const errored = waitForChrome(bad, { send: () => new Promise(() => {}) }, 1000)
      .then(() => 'resolved', (e) => e.message);
    bad.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    ok(/ENOENT/.test(await errored), 'a spawn failure surfaces its cause rather than crashing the extension host');

  }

  // --- SIGTERM reaches the group, not just the browser process ---------------
  {
    const child = fakeChild(4242);
    const { calls, send } = recorder();
    const kill = killer(child, { send, graceMs: 20 });

    kill();
    eq(calls.length, 1, 'one signal is sent');
    eq(
      calls[0],
      { pid: -4242, signal: 'SIGTERM' },
      'SIGTERM goes to the NEGATIVE pid — the whole process group, not the browser process alone'
    );
    eq(child.direct.length, 0, 'and not additionally to the process on its own');

    // --- and so does the escalation -----------------------------------------
    // A Chrome slow to handle SIGTERM is the case this timer exists for, and
    // SIGKILL to the browser alone reaps no more helpers than SIGTERM did.
    await new Promise((r) => setTimeout(r, 60));
    eq(calls.length, 2, 'the unexited process is escalated');
    eq(
      calls[1],
      { pid: -4242, signal: 'SIGKILL' },
      'the escalation is aimed at the group too'
    );
  }

  // --- a process that goes on its own is not escalated -----------------------
  {
    const child = fakeChild(7);
    const { calls, send } = recorder();
    const kill = killer(child, { send, graceMs: 20 });
    kill();
    child.exit();
    await new Promise((r) => setTimeout(r, 60));
    eq(calls.length, 1, 'a Chrome that took SIGTERM is not SIGKILLed after it exited');
    // Idempotency, unchanged by the widening: the dispose path can run twice.
    kill();
    eq(calls.length, 1, 'and killing an already-exited process sends nothing at all');
  }

  // --- a second kill while the escalation is armed does nothing --------------
  {
    const child = fakeChild(9);
    const { calls, send } = recorder();
    const kill = killer(child, { send, graceMs: 20 });
    kill();
    kill();
    kill();
    eq(calls.length, 1, 'repeated kills while escalating do not re-signal');
    await new Promise((r) => setTimeout(r, 60));
    eq(calls.length, 2, 'and exactly one escalation follows');
  }

  // --- ESRCH is the ordinary case, not an error ------------------------------
  // The group is already gone: the escalation timer racing a clean exit, or a
  // caller killing twice. Nothing should be thrown, and nothing should fall
  // back to the single process — there is no process.
  {
    const child = fakeChild(11);
    const { send } = recorder(errno('ESRCH'));
    const kill = killer(child, { send, graceMs: 20 });
    let threw = false;
    try {
      kill();
    } catch {
      threw = true;
    }
    ok(!threw, 'signalling a group that is already gone is not an error');
    eq(child.direct.length, 0, 'and does not fall back to killing a process that does not exist');
  }

  // --- anything else falls back to the single process ------------------------
  // Windows has no POSIX process groups for process.kill to address, so the
  // negative form fails outright there. Falling back keeps the platform this
  // defect does not exist on behaving exactly as it did.
  {
    const child = fakeChild(13);
    const { calls, send } = recorder(errno('EINVAL'));
    const kill = killer(child, { send, graceMs: 20 });
    kill();
    eq(calls[0]?.pid, -13, 'the group form is tried first');
    eq(child.direct, ['SIGTERM'], 'and a platform without process groups still kills the browser');
  }

  // --- no pid means no signal ------------------------------------------------
  // A spawn that failed (ENOENT on a bad chromePath) has no process. `-0` is
  // not "nothing", it is OUR OWN process group — the extension host — so this
  // guard is the difference between a no-op and killing VS Code.
  {
    const child = fakeChild(undefined);
    const { calls, send } = recorder();
    const kill = killer(child, { send, graceMs: 20 });
    kill();
    eq(calls.length, 0, 'a child that never spawned is not signalled — least of all as group 0');
    eq(child.direct.length, 0, 'and is not killed directly either');
  }

  // --- the launch timeout is a parameter, not a hardcoded constant -----------
  // The original bug: a 15s guess baked into the readiness wait, which a cold
  // headless start under swap pressure did not reliably fit in. The wait moved
  // from "read the endpoint off stderr" to "ask Browser.getVersion", so the
  // property is now that waitForChrome FORWARDS its timeout to the CDP call
  // rather than letting the connection's own 30s default apply — which is the
  // same bug wearing different clothes, and this catches it: the fake answers
  // with whatever timeout it was actually handed.
  //
  // The companion "kills exactly once" assertion is gone with endpointFrom,
  // which took a kill callback. launchChrome now kills in a single catch that
  // covers every failure path rather than each path killing for itself, and
  // launchChrome spawns a real browser, so that is not reachable from here.
  {
    // Derived from what the rejection actually said, not pushed
    // unconditionally — an assertion that cannot fail regardless of what the
    // code under test does is itself a defect on this branch.
    const timeoutsSeenInRejection = [];
    for (const timeoutMs of [30, 90]) {
      let caught;
      try {
        await waitForChrome(
          fakeChildForPipe(),
          { send: (_method, _params, _session, ms) => Promise.reject(new Error(`no response in ${ms}ms`)) },
          timeoutMs
        );
      } catch (err) {
        caught = err;
      }
      ok(caught, `a Chrome that never answers rejects (timeout ${timeoutMs}ms)`);
      const match = /no response in (\d+)ms/.exec(caught?.message ?? '');
      eq(
        match ? Number(match[1]) : undefined,
        timeoutMs,
        'the rejection names the timeout it was actually given, not a fixed 15000'
      );
      if (match) {
        timeoutsSeenInRejection.push(Number(match[1]));
      }
    }
    eq(
      timeoutsSeenInRejection,
      [30, 90],
      'both timeouts were exercised and each rejection actually carried its own number'
    );
  }

  // The default is the same object every launchChrome would fall back to —
  // pinned separately from the clamp below so a change to one cannot silently
  // hide a regression in the other.
  eq(DEFAULT_LAUNCH_TIMEOUT_MS, 45_000, 'the default is 45s — three times the 15s guess that missed on an ordinary open');

  // --- remoteVnc.mirrorLaunchTimeout (seconds) clamped to milliseconds -------
  eq(clampLaunchTimeoutMs(45), 45_000, 'the default value round-trips to 45s in milliseconds');
  eq(clampLaunchTimeoutMs(1), 5_000, 'below the floor is raised to the 5s minimum, not honoured verbatim');
  eq(clampLaunchTimeoutMs(999), 120_000, 'above the ceiling is capped at 120s, not left to hang a tab open indefinitely');
  eq(clampLaunchTimeoutMs(NaN), DEFAULT_LAUNCH_TIMEOUT_MS, 'a non-finite setting falls back to the default rather than producing a timer that fires immediately');
  eq(clampLaunchTimeoutMs(undefined), DEFAULT_LAUNCH_TIMEOUT_MS, 'a missing setting falls back the same way');
}
