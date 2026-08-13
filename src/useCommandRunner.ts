import { spawn, type SpawnOptions } from 'child_process';
import * as vscode from 'vscode';

import { logger } from './log';
import { groupKiller, type GroupKillOptions } from './processGroup';
import {
  PostUseTracker,
  expandWorkspaceFolders,
  useCommandFailureMessage,
  useCommandSucceeded,
  type FolderPath,
  type UseCommandOutcome,
  type UseCommands,
} from './useCommands';

/**
 * Running a saved entry's `preUseCommand`/`postUseCommand`.
 *
 * The spawning half of src/useCommands.ts, kept apart from it so the decisions
 * (validation, the timeout clamp, the trust gate) stay testable without a
 * process. What lives here is everything a fake child cannot prove: the shell,
 * the timeout, the process-group kill, and the guarantee that this function
 * ALWAYS settles — a pre-use command that never exits would otherwise leave a
 * tab saying "running…" for the rest of the window's life, which is the exact
 * failure mode this feature exists to remove, not to introduce.
 */

/**
 * How the command is spawned.
 *
 * `shell: true` because the field is documented as a shell command line —
 * pipes, `&&` and quoting are the whole point, and a user writing
 * `barto-mac up && barto-mac wait` means it.
 *
 * `detached: true` is the load-bearing one, for the same reason it is in
 * CHROME_SPAWN_OPTIONS (src/chromeProcess.ts): it makes the shell a process
 * group leader, which is the only thing that lets the timeout kill what the
 * shell STARTED rather than just the shell. A `sh -c 'make && serve'` that is
 * SIGTERM'd without it leaves the build running with nobody waiting on it.
 * The group kill in src/processGroup.ts is incorrect without this flag, so the
 * two must stay together.
 *
 * stdin is closed rather than inherited: nothing can answer a prompt here, and
 * a command that blocks reading stdin would otherwise hit the timeout instead
 * of failing at once.
 */
export const USE_COMMAND_SPAWN_OPTIONS: SpawnOptions = {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  shell: true,
};

/**
 * How much of a command's output is kept. Only a tail is ever shown, and the
 * full text goes to the output channel line by line as it arrives, so this
 * bounds the memory a chatty build can cost while it runs — not what the user
 * can read afterwards.
 */
const MAX_OUTPUT_CHARS = 16_384;

/**
 * How long after `exit` to wait for the stdio pipes to close.
 *
 * Node does not promise that stdout has been fully drained by the time `exit`
 * fires, so resolving there can lose the last lines — precisely the lines that
 * say why the command failed. Waiting for `close` instead is not an option on
 * its own: `close` also waits for every INHERITED copy of the pipe, and a
 * pre-use command whose whole job is to leave a daemon running (`barto-mac up`)
 * hands that daemon its stdout. Waiting for close alone would hang the tab
 * forever on a command that succeeded. So: settle on `exit`, but give `close`
 * a short window to arrive first.
 */
const EXIT_FLUSH_GRACE_MS = 300;

/**
 * How long after the timeout kill to give up waiting for `exit` and answer
 * anyway. The group has been SIGTERM'd and then SIGKILL'd by this point, so
 * reaching this timer means something is unkillable (a process stuck in an
 * uninterruptible syscall). Answering regardless is what keeps the promise's
 * "always settles" guarantee true rather than nearly true.
 */
const KILL_RESOLVE_GRACE_MS = 6_000;

export interface RunUseCommandOptions {
  timeoutMs: number;
  /** Working directory — the first workspace folder, when there is one. */
  cwd?: string;
  /** Prefix for the output-channel lines, e.g. `pre-use "kiosk"`. */
  label: string;
  /** Seams for test/useCommandRunner.test.mjs; see src/processGroup.ts. */
  send?: GroupKillOptions['send'];
  graceMs?: number;
  resolveGraceMs?: number;
  /** The exit→close window. A seam because the interesting case — a command
   *  that exits 0 leaving a daemon holding stdout — is only observable while
   *  the window is open, and 300ms is too short to aim a test at reliably. */
  flushGraceMs?: number;
}

/**
 * Run one command to completion and describe how it went.
 *
 * Never rejects. Every way this can go wrong — a shell that will not start, a
 * non-zero exit, a timeout — is a thing the caller has to show the user, and a
 * rejection would let one of them fall into a `.catch(() => {})` somewhere and
 * become the silent failure this feature is not allowed to have.
 */
export function runUseCommand(
  command: string,
  opts: RunUseCommandOptions
): Promise<UseCommandOutcome> {
  return new Promise((resolve) => {
    const log = logger();
    log.info(`${opts.label}: running ${command}`);
    const child = spawn(command, { ...USE_COMMAND_SPAWN_OPTIONS, cwd: opts.cwd });
    // The command must not be what keeps the extension host's event loop
    // alive: a window closing mid-run would otherwise wait on it.
    child.unref();
    const kill = groupKiller(child, {
      label: opts.label,
      send: opts.send,
      graceMs: opts.graceMs,
    });

    let output = '';
    let timedOut = false;
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let flush: NodeJS.Timeout | undefined;
    let fallback: NodeJS.Timeout | undefined;

    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Straight to the output channel as it arrives, so a long-running
      // command can be watched rather than only autopsied.
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          log.info(`${opts.label}: ${line}`);
        }
      }
      output = (output + text).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn(`${opts.label}: no exit after ${opts.timeoutMs}ms — killing the process group`);
      kill();
      fallback = setTimeout(
        () => finish({ code: null, signal: null }),
        opts.resolveGraceMs ?? KILL_RESOLVE_GRACE_MS
      );
    }, opts.timeoutMs);

    function finish(
      status: { code: number | null; signal: NodeJS.Signals | null },
      spawnError?: string
    ): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (flush) {
        clearTimeout(flush);
      }
      if (fallback) {
        clearTimeout(fallback);
      }
      // Release our end of the pipes. A successful pre-use command is allowed
      // to leave a daemon holding the other end; nothing here should stay
      // subscribed to it for the life of the window.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const outcome: UseCommandOutcome = {
        code: status.code,
        signal: status.signal,
        timedOut,
        ...(spawnError !== undefined ? { spawnError } : {}),
        output,
      };
      log.info(
        `${opts.label}: ${useCommandSucceeded(outcome) ? 'succeeded' : 'failed'} ` +
          `(code=${outcome.code}, signal=${outcome.signal}, timedOut=${outcome.timedOut}` +
          `${spawnError !== undefined ? `, spawnError=${spawnError}` : ''})`
      );
      resolve(outcome);
    }

    child.on('exit', (code, signal) => {
      // Disarmed here and not only in finish(): the flush window below is
      // 300ms wide, and a command that exits 0 inside it would otherwise be
      // reported as having timed out — the entry refused for succeeding, in a
      // race that would reproduce roughly never and be unexplainable when it
      // did.
      clearTimeout(timer);
      exit = { code, signal };
      flush = setTimeout(() => finish({ code, signal }), opts.flushGraceMs ?? EXIT_FLUSH_GRACE_MS);
    });
    child.on('close', () => {
      if (exit) {
        finish(exit);
      }
    });
    // A shell that cannot be started (no /bin/sh, an unreadable cwd) surfaces
    // here and NOT as an exit — and Node treats an unhandled 'error' as an
    // uncaught exception, so this also keeps a bad command from taking the
    // extension host down.
    child.on('error', (err) => {
      finish({ code: null, signal: null }, err instanceof Error ? err.message : String(err));
    });
  });
}

/**
 * Start a command and walk away, for extension deactivation.
 *
 * Different from a fire-and-forget `runUseCommand` in the one way that matters
 * at shutdown: the pipes are not ours at all. The extension host is about to
 * exit, so a child writing into a pipe nobody will ever read again would take
 * an EPIPE partway through the very teardown it was asked to perform. `stdio:
 * 'ignore'` plus the detached group means it finishes on its own.
 */
export function spawnDetachedUseCommand(command: string, cwd: string | undefined, label: string): void {
  try {
    const child = spawn(command, { stdio: 'ignore', detached: true, shell: true, cwd });
    child.on('error', (err) => logger().warn(`${label}: could not start — ${String(err)}`));
    child.unref();
    logger().info(`${label}: started ${command} (detached, not awaited)`);
  } catch (err) {
    logger().warn(`${label}: could not start — ${String(err)}`);
  }
}

/** The open folders, as `expandWorkspaceFolders` wants to see them. */
function openFolders(): FolderPath[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    path: f.uri.fsPath,
  }));
}

/**
 * Where a command runs. The first workspace folder, which is what a relative
 * path in one of these commands can only sensibly mean; undefined in a window
 * with no folder, where `spawn` falls back to the extension host's own cwd.
 */
export function useCommandCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Either the entry may be opened, or here is what to tell the user instead. */
export type PreUseResult = { ok: true } | { ok: false; message: string };

/**
 * Expand and run one entry's `preUseCommand`, and say whether the entry may
 * now be opened.
 *
 * The single funnel for both callers (a page tab and a VNC session), so the
 * rule that matters cannot drift between them: the URL/connection is loaded
 * ONLY on a clean exit. A non-zero exit, a timeout, a shell that would not
 * start and an unresolvable `${workspaceFolder}` all come back the same way —
 * as a message naming the entry — because from the user's side they are the
 * same event: the thing they clicked did not open, and here is why.
 */
export async function runPreUseCommand(
  entryName: string,
  commands: UseCommands
): Promise<PreUseResult> {
  const command = commands.preUseCommand;
  if (!command) {
    return { ok: true };
  }
  const expanded = expandWorkspaceFolders(command, openFolders());
  if ('error' in expanded) {
    const message =
      `Remote VNC: the preUseCommand for "${entryName}" was not run — ${expanded.error}.`;
    logger().error(message);
    return { ok: false, message };
  }
  const outcome = await runUseCommand(expanded.command, {
    timeoutMs: commands.preUseTimeoutMs,
    cwd: useCommandCwd(),
    label: `pre-use "${entryName}"`,
  });
  if (useCommandSucceeded(outcome)) {
    return { ok: true };
  }
  return {
    ok: false,
    message: useCommandFailureMessage(entryName, outcome, commands.preUseTimeoutMs),
  };
}

/**
 * The one tracker for the window. Module-level because "the last panel using
 * this command" is a window-wide question and two trackers would each think
 * they held the last one.
 */
const tracker = new PostUseTracker();

let tokenSeq = 0;

/**
 * Take out a claim on an entry's `postUseCommand`, returning the token that
 * releases it — or undefined when the entry has no post-use command to hold.
 *
 * The command is expanded HERE rather than at close time, and that is
 * deliberate on both counts. It makes the tracker's key the resolved command,
 * so two entries pointing at the same stack really do share one claim; and it
 * puts an unresolvable `${workspaceFolder}` in front of the user while they
 * are opening the entry, instead of at window close where nothing is watching.
 */
export function holdPostUseCommand(entryName: string, commands: UseCommands): string | undefined {
  const command = commands.postUseCommand;
  if (!command) {
    return undefined;
  }
  const expanded = expandWorkspaceFolders(command, openFolders());
  if ('error' in expanded) {
    // Said out loud, not only logged. This is the one failure in the feature
    // whose consequence arrives much later and looks like nothing at all: the
    // stack the preUseCommand starts is never taken down, and the user finds
    // out hours afterwards from a machine that will not idle. The pre-use half
    // already shows its own failure (runPreUseCommand → showErrorMessage), and
    // a silent post-use half next to it is exactly the asymmetry that makes a
    // missing stop command unattributable.
    const message =
      `Remote VNC: the postUseCommand for "${entryName}" will not run — ${expanded.error}. ` +
      'Whatever the preUseCommand starts will have to be stopped by hand.';
    logger().error(message);
    void vscode.window.showWarningMessage(message);
    return undefined;
  }
  const token = `use-${++tokenSeq}`;
  tracker.acquire(expanded.command, token);
  return token;
}

/**
 * Release `token`'s claim and, if it was the last one, run the command.
 *
 * Fire-and-forget by design: a closing tab must not wait on a shutdown script,
 * and there is nowhere left to report to. The outcome is logged, and a failure
 * warned about, so "the stack did not come down" is discoverable rather than
 * invisible.
 */
export function releasePostUseCommand(token: string): void {
  const cwd = useCommandCwd();
  const command = tracker.release(token);
  if (command === undefined) {
    return;
  }
  const label = 'post-use';
  void runUseCommand(command, { timeoutMs: POST_USE_TIMEOUT_MS, cwd, label }).then((outcome) => {
    if (!useCommandSucceeded(outcome)) {
      logger().warn(
        `${label}: "${command}" did not exit cleanly (code=${outcome.code}, timedOut=${outcome.timedOut})`
      );
    }
  });
}

/**
 * Release `token`'s claim, but only once `pending` — the pre-use command that
 * claim was taken for — has settled.
 *
 * THE ORDER IS THE WHOLE POINT. A tab can be closed while its `preUseCommand`
 * is still running, and its dispose handler fires immediately. Releasing there
 * runs the stop command UNDER the start command: `barto-mac stop` finishes
 * first, `barto-mac up` finishes second, and the stack is left standing with no
 * holder left to release it and no tab left to close — a permanent orphan, the
 * exact all-day cost this feature exists to remove. Waiting costs nothing: the
 * claim is released either way, only in an order that cannot invert.
 *
 * `pending` never rejects (`runUseCommand` resolves every failure as an
 * outcome), but the rejection path is wired anyway: a claim that leaks because
 * some future caller's promise threw would be the same orphan, arrived at from
 * the other side.
 */
export function releasePostUseCommandAfter(
  pending: Promise<unknown> | undefined,
  token: string
): void {
  if (!pending) {
    releasePostUseCommand(token);
    return;
  }
  void pending.then(
    () => releasePostUseCommand(token),
    () => releasePostUseCommand(token)
  );
}

/**
 * A post-use command gets the same budget as the default pre-use one. It is
 * bounded for the same reason the group kill exists: a stop script that hangs
 * must not leave a process group running for the rest of the session.
 */
const POST_USE_TIMEOUT_MS = 60_000;

/**
 * Run every outstanding post-use command, for window close.
 *
 * Panels do not reliably get their `onDidDispose` on shutdown, so without this
 * closing the window would leave the stack up — the state the feature exists
 * to avoid. Detached and not awaited: `deactivate` runs under VS Code's own
 * shutdown timeout, and a stop script is not worth spending it on.
 */
export function drainPostUseCommands(): void {
  const cwd = useCommandCwd();
  for (const command of tracker.drain()) {
    spawnDetachedUseCommand(command, cwd, 'post-use (window close)');
  }
}
