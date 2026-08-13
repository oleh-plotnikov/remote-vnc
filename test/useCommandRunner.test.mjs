// Everything about running a preUseCommand that a fake child cannot prove:
// the shell, the exit code, the timeout, and — the one that costs real money
// when it is wrong — that the timeout reaps what the shell STARTED, not just
// the shell. Real processes, all of them harmless: /bin/echo, sh -c 'exit 3'
// and sleep. Nothing here launches a browser or a kiosk.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load } from './bundle.mjs';

const isWindows = process.platform === 'win32';

export default async function ({ ok, eq }) {
  const {
    runUseCommand,
    USE_COMMAND_SPAWN_OPTIONS,
    holdPostUseCommand,
    releasePostUseCommandAfter,
  } = await load('useCommandRunner.ts');

  // --- the spawn options are load-bearing, not taste -------------------------
  // `detached` is the prerequisite for the group kill below: without it the
  // shell joins the extension host's OWN process group, and signalling the
  // group would be signalling VS Code. Pinned for the same reason
  // CHROME_SPAWN_OPTIONS is (test/chromeProcess.test.mjs): nothing else can
  // observe it, and the kill is incorrect the moment it changes.
  eq(USE_COMMAND_SPAWN_OPTIONS.detached, true, 'use commands are spawned detached, so there is a process group to kill');
  eq(USE_COMMAND_SPAWN_OPTIONS.shell, true, 'and through a shell, because the field is documented as a command line');
  eq(
    USE_COMMAND_SPAWN_OPTIONS.stdio[0],
    'ignore',
    'with stdin closed — nothing can answer a prompt, and a command waiting on one would burn the whole timeout'
  );

  if (isWindows) {
    return; // the rest depends on POSIX shells, signals and process groups
  }

  // --- a command that works --------------------------------------------------
  {
    const outcome = await runUseCommand('/bin/echo hello-from-pre-use', {
      timeoutMs: 5_000,
      label: 'test',
    });
    eq(outcome.code, 0, 'a successful command exits 0');
    eq(outcome.timedOut, false, 'and did not time out');
    eq(outcome.spawnError, undefined, 'and started cleanly');
    ok(/hello-from-pre-use/.test(outcome.output), 'and its stdout is captured');
  }

  // --- a command that fails --------------------------------------------------
  // Both streams, because a failing command says why on stderr and that is the
  // text the user is shown.
  {
    const outcome = await runUseCommand('echo out-line; echo err-line 1>&2; exit 3', {
      timeoutMs: 5_000,
      label: 'test',
    });
    eq(outcome.code, 3, 'a non-zero exit is reported as itself, not as a generic failure');
    eq(outcome.timedOut, false, 'and is not mistaken for a timeout');
    ok(/out-line/.test(outcome.output), 'stdout is captured');
    ok(/err-line/.test(outcome.output), 'and so is stderr, which is where a failing command explains itself');
  }

  // --- a shell that cannot start --------------------------------------------
  // Surfaces as an 'error' event, not an exit — and Node treats an unhandled
  // one as an uncaught exception, so this is also the guard against a bad
  // command taking the extension host down.
  {
    const outcome = await runUseCommand('/bin/echo hi', {
      timeoutMs: 5_000,
      label: 'test',
      cwd: '/nonexistent-directory-for-remote-vnc-tests',
    });
    ok(outcome.spawnError !== undefined, 'a spawn failure is reported as one');
    eq(outcome.code, null, 'with no exit code, because there was no process to exit');
  }

  // --- the timeout kills the whole process group -----------------------------
  // The defect this exists to prevent: a command like `barto-mac up` is a shell
  // that starts other things. SIGTERM to the shell alone leaves them running
  // with nobody waiting on them — the exact all-day resident process this
  // feature was written to get rid of. So the shell backgrounds a `sleep 30`,
  // prints its pid, and waits; after the timeout that pid must be gone.
  {
    const started = Date.now();
    const outcome = await runUseCommand('sleep 30 & echo $!; wait', {
      timeoutMs: 400,
      label: 'test',
    });
    const grandchild = Number((outcome.output.match(/\d+/) ?? [])[0]);
    ok(Number.isInteger(grandchild) && grandchild > 0, 'the backgrounded process announced its pid');
    eq(outcome.timedOut, true, 'the timeout fired');
    ok(Date.now() - started < 10_000, 'and settled long before the 30s sleep would have');

    // The signal is delivered asynchronously; give it a moment to land rather
    // than racing it.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(grandchild, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    ok(!alive, 'the process the shell STARTED is dead too — the group was killed, not just the shell');
  }

  // --- the kill is addressed at the group, and the promise always settles ----
  // Two things at once, because one seam shows both: with `send` recording
  // instead of signalling, nothing actually dies, so what the code TRIED to
  // signal is visible AND the "unkillable process" path is exercised. A
  // promise that did not settle here would be a tab stuck on "running…" for
  // the rest of the window's life.
  {
    const signals = [];
    const started = Date.now();
    const outcome = await runUseCommand('sleep 1', {
      timeoutMs: 100,
      label: 'test',
      send: (pid, signal) => signals.push({ pid, signal }),
      graceMs: 20,
      resolveGraceMs: 200,
    });
    eq(outcome.timedOut, true, 'an unkillable command still reports a timeout');
    ok(
      Date.now() - started < 900,
      'and settles on its own rather than waiting for a process that is not going to exit'
    );
    eq(
      signals.map((s) => s.signal),
      ['SIGTERM', 'SIGKILL'],
      'SIGTERM first, then SIGKILL once the grace has passed'
    );
    ok(
      signals.every((s) => s.pid < 0),
      'and both are addressed at the negative pid — the process GROUP, not the shell alone'
    );
  }

  // --- a command that succeeds by leaving a daemon running -------------------
  // The shape of the real thing: `barto-mac up` starts the kiosk and exits 0,
  // and the kiosk inherits the shell's stdout. Two ways to get this wrong meet
  // here.
  //
  // Waiting for `close` alone would never settle, because `close` waits for
  // every inherited copy of the pipe and the daemon holds one for as long as it
  // runs — the tab would say "running…" forever after a command that worked.
  // Hence settling on `exit`, with a short window for `close` to bring the last
  // lines in.
  //
  // And leaving the timeout armed across that window would fire it against a
  // process that has already exited 0: the command reported as timed out, the
  // entry refused, and — worst — the group kill landing on the daemon the
  // command had just successfully started. The window is widened here only
  // because 300ms is too short to aim a test at reliably; the race is the same.
  {
    const outcome = await runUseCommand('sleep 5 & echo daemon $!; exit 0', {
      timeoutMs: 700,
      flushGraceMs: 1_500,
      label: 'test',
    });
    eq(outcome.code, 0, 'a command that exits 0 leaving a daemon behind is a success');
    eq(
      outcome.timedOut,
      false,
      'and is not reported as timed out by a timer left armed across the exit→close window'
    );
    const daemon = Number((outcome.output.match(/daemon (\d+)/) ?? [])[1]);
    ok(Number.isInteger(daemon) && daemon > 0, 'the daemon announced its pid');
    let survived = true;
    try {
      process.kill(daemon, 0);
    } catch {
      survived = false;
    }
    ok(survived, 'and the daemon the command started is still running — it was not killed by its own success');
    try {
      process.kill(daemon, 'SIGKILL'); // this test's own cleanup
    } catch {
      /* already gone */
    }
  }

  // --- the claim: a stop command must never run under a start command --------
  // The defect this section exists for: a tab closed WHILE its preUseCommand is
  // still running fires its dispose handler at once, and releasing the claim
  // there ran `barto-mac stop` first and let `barto-mac up` finish afterwards.
  // The stack was then up with no holder left to release it and no tab left to
  // close — a permanent orphan, reached by the one thing a user does when a tab
  // is slow to open.
  //
  // Real processes and a real file, because the whole assertion is an ORDER
  // between two spawns; a fake would only assert the fake. Both commands append
  // one line to the same file, so the file IS the order.
  {
    const log = join(mkdtempSync(join(tmpdir(), 'rv-claim-')), 'order.log');
    const token = holdPostUseCommand('kiosk', {
      postUseCommand: `printf 'stop\\n' >> ${log}`,
      preUseTimeoutMs: 5_000,
    });
    ok(token, 'an entry with a postUseCommand yields a claim token');

    // The start command, still running…
    const pending = runUseCommand(`sleep 0.4; printf 'start\\n' >> ${log}`, {
      timeoutMs: 5_000,
      label: 'test pre-use',
    });
    // …and the tab is closed NOW, mid-command.
    releasePostUseCommandAfter(pending, token);
    await pending;
    eq(
      await linesOf(log, 2),
      ['start', 'stop'],
      'the stop command runs after the start command finishes, never under it'
    );
  }

  // The same call with nothing in flight must not defer: a tab closed after its
  // command has settled — the ordinary case, and every tab that has no pre-use
  // command at all — has to release immediately, or a stop command would sit
  // waiting on a promise that is never coming.
  {
    const log = join(mkdtempSync(join(tmpdir(), 'rv-claim-')), 'idle.log');
    const token = holdPostUseCommand('kiosk-idle', {
      postUseCommand: `printf 'stop\\n' >> ${log}`,
      preUseTimeoutMs: 5_000,
    });
    releasePostUseCommandAfter(undefined, token);
    eq(await linesOf(log, 1), ['stop'], 'with nothing in flight the stop command runs straight away');
  }

  // --- an unresolvable ${workspaceFolder} in a STOP command ------------------
  // The one failure in this feature whose consequence arrives hours later and
  // looks like nothing at all: no claim is taken, so the stack the start command
  // brought up is never taken down, and the user finds out from a machine that
  // will not idle. The pre-use half already shows its own failure; a silent
  // post-use half next to it is what makes a missing stop command
  // unattributable.
  {
    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];
    const token = holdPostUseCommand('kiosk', {
      postUseCommand: 'barto-mac stop ${workspaceFolder:nope}',
      preUseTimeoutMs: 5_000,
    });
    eq(token, undefined, 'a stop command that cannot be resolved yields no claim');
    const warned = globalThis.__dialogCalls.filter((c) => c.name === 'showWarningMessage');
    eq(warned.length, 1, 'and the user is told, not just the log');
    ok(
      /postUseCommand for "kiosk"/.test(warned[0]?.args[0] ?? ''),
      'the warning names the entry, so the user knows which one will not be stopped'
    );
    ok(
      /by hand/i.test(warned[0]?.args[0] ?? ''),
      'and says what is now theirs to do — the stack is up and nothing will take it down'
    );
    globalThis.__dialogCalls = undefined;
    globalThis.__dialogsEnabled = false;
  }
}

/**
 * The lines of `path` once it has at least `want` of them.
 *
 * A post-use command is fire-and-forget by design — `releasePostUseCommand`
 * returns nothing to await, because a closing tab must not wait on a shutdown
 * script — so polling is the only honest way to observe that it ran.
 */
async function linesOf(path, want, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lines = [];
    try {
      lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
    } catch {
      /* not created yet */
    }
    if (lines.length >= want || Date.now() > deadline) {
      return lines; // on a timeout, let the assertion report what did arrive
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
