import type { ChildProcess } from 'child_process';

import { logger } from './log';

/**
 * Killing a spawned child AND everything it spawned.
 *
 * Lifted out of src/chromeProcess.ts, where it was written for Chrome's
 * eleven-process tree, because the pre/post-use shell commands
 * (src/useCommandRunner.ts) have the identical problem and must not solve it a
 * second, subtly different way: a `sh -c` that starts a build and is then
 * SIGTERM'd leaves the build running exactly as SIGTERM to Chrome's browser
 * process left its renderers running. The ESRCH handling and the no-pid guard
 * below are the parts that are easy to get wrong and expensive to get wrong,
 * so there is one copy of them.
 *
 * Both callers must spawn with `detached: true`. That is not a companion
 * tidiness, it is the prerequisite: without it the child joins the extension
 * host's OWN process group, and the negative-pid signal below would then be
 * addressed at VS Code.
 */

/** How long SIGTERM gets before SIGKILL follows. */
export const KILL_GRACE_MS = 2_500;

export interface GroupKillOptions {
  /** Seam for tests: the group form has no observable effect on a fake child. */
  send?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  /** Prefix for the one diagnostic this can emit (`mirror`, `use-command`). */
  label?: string;
}

/**
 * SIGTERM to the child's whole process group, then SIGKILL to the same group
 * if anything is still there after `graceMs`.
 *
 * Safe to call more than once (a dispose path may run twice) and safe to call
 * after the process has already exited on its own: `exited` tracks the direct
 * child — the only one there is a handle for, and the one whose departure
 * means the group is done.
 */
export function groupKiller(child: ChildProcess, opts: GroupKillOptions = {}): () => void {
  const send = opts.send ?? ((pid, signal) => process.kill(pid, signal));
  const graceMs = opts.graceMs ?? KILL_GRACE_MS;
  const label = opts.label ?? 'process';
  let exited = false;
  let escalate: NodeJS.Timeout | undefined;
  child.once('exit', () => {
    exited = true;
    if (escalate) {
      clearTimeout(escalate);
      escalate = undefined;
    }
  });
  return () => {
    if (exited || escalate) {
      return; // already gone, or already escalating — nothing new to do
    }
    signalGroup(child, 'SIGTERM', send, label);
    escalate = setTimeout(() => {
      escalate = undefined;
      if (!exited) {
        signalGroup(child, 'SIGKILL', send, label);
      }
    }, graceMs);
  };
}

/**
 * Signal every process in the child's group, falling back to the child alone.
 *
 * Three things can go wrong, and each has to be told apart:
 *  - no pid at all: the spawn itself failed (ENOENT on a bad path), so there
 *    is no process, let alone a group. Signalling pid `-0` would address OUR
 *    OWN process group — the extension host — so the early return is not
 *    defensive, it is the difference between a no-op and killing VS Code.
 *  - ESRCH: the group is already gone. Ordinary — the escalation timer fires
 *    against a child that took SIGTERM correctly, and callers may kill twice.
 *  - anything else: Windows has no POSIX process groups for `process.kill` to
 *    address (`detached` there means "no console window"), so the negative-pid
 *    form fails outright and the single-process kill is all there is. Falling
 *    back rather than throwing keeps the platform where this defect does not
 *    exist working exactly as it did.
 */
function signalGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  send: (pid: number, signal: NodeJS.Signals) => void,
  label: string
): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    send(-pid, signal);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return;
    }
    logger().warn(`${label}: could not signal the process group — ${String(err)}`);
  }
  child.kill(signal);
}
