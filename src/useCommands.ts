/**
 * Pre/post-use shell commands attached to a saved page or connection.
 *
 * The problem they solve: a saved page can point at a server that does not
 * exist until something starts it. The kiosk mockup this was written for
 * serves `http://localhost:8777/` from the app itself, so the tab was only
 * ever usable while a supervisor loop was kept alive all day for it. With
 * `preUseCommand` nothing runs until the entry is clicked, and `postUseCommand`
 * takes the stack down again when the last tab for it closes.
 *
 * Everything here is pure — no `vscode`, no `child_process`, no DOM — so the
 * decisions that matter (what counts as a command, how long it may run, and
 * above all WHETHER IT MAY RUN AT ALL) are provable in test/useCommands.test.mjs
 * without spawning anything. The spawning half is src/useCommandRunner.ts.
 */

/** The three fields as they arrive from settings: untrusted, unvalidated JSON. */
export interface UseCommandsSource {
  preUseCommand?: unknown;
  postUseCommand?: unknown;
  preUseTimeout?: unknown;
}

/** The same three fields once validated, clamped and trust-gated. */
export interface UseCommands {
  /** Runs before the tab loads its URL; a non-zero exit aborts the load. */
  preUseCommand?: string;
  /** Runs when the last panel holding this command closes. */
  postUseCommand?: string;
  /** Already in milliseconds and already clamped — see clampPreUseTimeoutMs. */
  preUseTimeoutMs: number;
}

/**
 * Sixty seconds, because that is the honest middle of the two things this
 * waits for: a container/daemon coming up (seconds) and a first build (minutes).
 * Long enough that the common case never trips it, short enough that a command
 * which will never succeed does not hold a tab in "running…" while the user
 * wonders whether to wait.
 */
export const DEFAULT_PRE_USE_TIMEOUT_MS = 60_000;
/**
 * Bounds for `preUseTimeout` (declared in SECONDS in package.json, like
 * `remoteVnc.mirrorLaunchTimeout`).
 *
 * Floor at 5s — the same floor as MIN_LAUNCH_TIMEOUT_MS (src/chromeProcess.ts),
 * and for the same reason: below that the number stops describing a wait
 * anybody meant and starts looking like a seconds/milliseconds mix-up, and a
 * timeout that can never be met turns every open of the entry into a failure.
 *
 * Ceiling at 15 minutes. This is a budget for bringing a stack up, not a
 * network timeout, so it has to cover a cold build — but a command that never
 * exits must not be able to pin a tab in "running…" for the rest of the
 * window's life, which is what an unbounded value would allow. 15 minutes
 * clears the slowest thing this was written for (a container image build on a
 * memory-constrained machine) with room to spare, and still ends.
 */
export const MIN_PRE_USE_TIMEOUT_MS = 5_000;
export const MAX_PRE_USE_TIMEOUT_MS = 900_000;

/**
 * Clamp a configured `preUseTimeout` (seconds) to milliseconds within
 * [MIN_PRE_USE_TIMEOUT_MS, MAX_PRE_USE_TIMEOUT_MS]. Mirrors
 * `clampLaunchTimeoutMs` (src/chromeProcess.ts): the value comes from settings,
 * so it can be a string, a null or a NaN, and a non-finite number would produce
 * a timer that fires immediately — killing every command before it starts.
 */
export function clampPreUseTimeoutMs(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return DEFAULT_PRE_USE_TIMEOUT_MS;
  }
  return Math.min(
    MAX_PRE_USE_TIMEOUT_MS,
    Math.max(MIN_PRE_USE_TIMEOUT_MS, Math.round(seconds * 1000))
  );
}

/** Where a settings entry was defined, as far as this gate is concerned. */
export interface UseCommandTrust {
  /** True for a workspace- or folder-scoped entry, false for a user/global one. */
  fromWorkspace: boolean;
  /** `vscode.workspace.isTrusted`. */
  isTrusted: boolean;
}

export interface UseCommandsResolution {
  commands: UseCommands;
  /**
   * Field names dropped by the trust gate — empty when nothing was dropped.
   * Non-empty is a thing the user has to be TOLD about (src/pages.ts and
   * src/connections.ts log it): a command that is silently ignored is
   * indistinguishable from one that ran and did nothing, and this extension has
   * shipped that class of defect before.
   *
   * Where it actually fires today, so the notice is not mistaken for the whole
   * defence: `collectPages`/`collectConnections` drop the workspace and folder
   * LAYERS entirely in an untrusted window, so an entry that reaches
   * `resolveUseCommands` from either of them is already a trusted one. The one
   * live path is `readConnection` (src/extension.ts), which re-reads a single
   * named entry from a single scope for the edit menu and can therefore hand a
   * workspace record to an untrusted window. Everywhere else this is defence in
   * depth: the gate has to hold for a caller that has not dropped the layer,
   * because the alternative is a caller one refactor away from executing a
   * repository's command.
   */
  stripped: string[];
}

/** A command is usable only when it is a non-empty string once trimmed. */
function commandOf(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Validate, clamp and TRUST-GATE the three fields of one saved entry.
 *
 * SECURITY. `preUseCommand`/`postUseCommand` are arbitrary shell commands read
 * out of settings, and `remoteVnc.pages`/`remoteVnc.connections` are
 * workspace-settable by design (this user keeps theirs in a `.code-workspace`,
 * so machine scope — the fix `remoteVnc.chromePath` got for exactly this class
 * of defect — is not available here). Without this gate, cloning a repository
 * and opening one of its saved pages would execute whatever that repository
 * chose to put in the field. So a command carried by a workspace- or
 * folder-scoped entry is honoured ONLY in a trusted workspace, the same
 * mechanism that gates `tasks.json`. The entry itself is untouched: the page
 * still opens, the connection still connects, only the commands are dropped.
 *
 * Do not "simplify" this away by taking the fields straight off the record.
 * The scope is the only thing that distinguishes a command the user wrote from
 * one a repository shipped, and it is available at exactly one point — where
 * `collectPages`/`collectConnections` already know which layer an entry came
 * from — which is why the call sits there.
 */
export function resolveUseCommands(
  source: UseCommandsSource | undefined,
  trust: UseCommandTrust
): UseCommandsResolution {
  const pre = commandOf(source?.preUseCommand);
  const post = commandOf(source?.postUseCommand);
  const preUseTimeoutMs = clampPreUseTimeoutMs(source?.preUseTimeout);

  if (trust.fromWorkspace && !trust.isTrusted) {
    const stripped = [
      ...(pre ? ['preUseCommand'] : []),
      ...(post ? ['postUseCommand'] : []),
    ];
    return { commands: { preUseTimeoutMs }, stripped };
  }
  return {
    commands: {
      ...(pre ? { preUseCommand: pre } : {}),
      ...(post ? { postUseCommand: post } : {}),
      preUseTimeoutMs,
    },
    stripped: [],
  };
}

/**
 * Remembers which strip notices have already been said out loud.
 *
 * A stripped command has to be reported — an ignored command is
 * indistinguishable from one that ran and did nothing, and that is its own
 * trap — but `collectPages`/`collectConnections` run on every tree refresh and
 * every quick pick, so reporting it each time would bury the notice in its own
 * repetitions. First occurrence only, per entry and per field set, for the
 * life of the window.
 */
export class StripNoticeLog {
  private readonly seen = new Set<string>();

  /** The line to log, or undefined when this exact notice was already given. */
  notice(kind: string, name: string, stripped: readonly string[]): string | undefined {
    if (stripped.length === 0) {
      return undefined;
    }
    // NUL as the separator, so a name that contains the separator cannot
    // forge another entry's key — and written as an ESCAPE, never as the byte
    // itself: a literal NUL in the source makes git treat this whole file as
    // binary, and every future diff of this security gate would then read
    // "Binary files differ" instead of showing what changed.
    const key = `${kind}\u0000${name}\u0000${stripped.join(',')}`;
    if (this.seen.has(key)) {
      return undefined;
    }
    this.seen.add(key);
    return (
      `ignoring ${stripped.join(' and ')} on the workspace ${kind} "${name}": these run ` +
      'arbitrary shell commands, so they are only honoured in a trusted workspace. ' +
      'Use "Workspaces: Manage Workspace Trust" to trust this workspace, or move the ' +
      'entry to your user settings.'
    );
  }
}

/** Whether an entry has anything for the runner to do at all. */
export function hasUseCommands(commands: UseCommands | undefined): boolean {
  return Boolean(commands?.preUseCommand || commands?.postUseCommand);
}

/**
 * No commands at all — the answer for an entry this window cannot vouch for.
 *
 * Frozen because it is shared: a caller that mutated it would be handing every
 * later caller a command nobody configured.
 */
export const NO_USE_COMMANDS: UseCommands = Object.freeze({
  preUseTimeoutMs: DEFAULT_PRE_USE_TIMEOUT_MS,
});

/**
 * The trust-gated commands for `name`, taken from the entries THIS window
 * resolved — never from an entry an outside caller supplied.
 *
 * SECURITY. Tree commands like `remoteVnc.openPageItem` are registered with
 * `vscode.commands.registerCommand`, which is a public surface: any other
 * extension in the window, and any keybinding's `args`, can invoke them with an
 * object of its own making. Such an object never passed through
 * `collectPages`/`collectConnections`, so its `use` never met the Workspace
 * Trust gate above — and executing it would hand the whole gate away at the one
 * point it is not looking. Looking the name back up costs a settings read and
 * closes that; an entry that is not in settings runs nothing at all, which is
 * also the right answer for a tree item left over from before a delete.
 */
export function useCommandsFor(
  entries: readonly { name: string; use: UseCommands }[],
  name: string
): UseCommands {
  return entries.find((e) => e.name === name)?.use ?? NO_USE_COMMANDS;
}

/** One open workspace folder, as `expandWorkspaceFolders` needs to see it. */
export interface FolderPath {
  name: string;
  path: string;
}

/**
 * Substitute `${workspaceFolder}` and `${workspaceFolder:NAME}`.
 *
 * VS Code does NOT expand variables in arbitrary settings — only in
 * `tasks.json`, `launch.json` and settings whose owning extension does the
 * expansion itself. This is that expansion. It is worth having because the
 * command that motivated the feature lives in a sibling repository of a
 * multi-root workspace, and no shell can work out where that repository is
 * checked out.
 *
 * Only the `workspaceFolder` family is recognised, and every other `${…}` is
 * left exactly as written: the string is about to be handed to a shell, where
 * `${PATH}` and `${HOME:-/tmp}` are ordinary and correct. Rewriting or
 * rejecting those would break commands that have nothing to do with us.
 *
 * An unresolvable `${workspaceFolder…}` is an error rather than an empty
 * string, because the empty string is the dangerous answer: `rm -rf ${wf}/out`
 * with nothing to substitute is not a command anybody meant to run.
 */
export function expandWorkspaceFolders(
  command: string,
  folders: readonly FolderPath[]
): { command: string } | { error: string } {
  let failure: string | undefined;
  /** Substitute a resolved path, or refuse it — see SHELL_SAFE_PATH. */
  const substitute = (whole: string, path: string): string => {
    if (!SHELL_SAFE_PATH.test(path)) {
      failure ??=
        `${whole} cannot be resolved — the folder path contains characters a shell ` +
        `would interpret as syntax rather than as part of a name: ${path}`;
      return whole;
    }
    return path;
  };
  const expanded = command.replace(
    /\$\{workspaceFolder(?::([^}]*))?\}/g,
    (whole, name: string | undefined) => {
      if (name === undefined) {
        const first = folders[0];
        if (!first) {
          failure ??= `${whole} cannot be resolved — no folder is open in this window`;
          return whole;
        }
        return substitute(whole, first.path);
      }
      const match = folders.find((f) => f.name === name);
      if (!match) {
        const known = folders.map((f) => f.name).join(', ') || 'none';
        failure ??= `${whole} cannot be resolved — the open folders are: ${known}`;
        return whole;
      }
      return substitute(whole, match.path);
    }
  );
  return failure ? { error: failure } : { command: expanded };
}

/**
 * What a folder path may contain before it stops being safe to splice into a
 * command line that `spawn(..., { shell: true })` hands to `sh -c`.
 *
 * A directory name may legally contain `$( )`, backticks, `;` and `|` on macOS
 * and Linux, so a cloned repo or an unpacked archive can put shell code where a
 * path is expected. Workspace Trust does not close this: it gates where the
 * *command* came from, and a user-level `preUseCommand` — which is trusted by
 * design — is exactly what would carry such a path into a shell.
 *
 * An allowlist, and deliberately a Unicode-aware one: `\w` is ASCII-only, and a
 * home directory named in Cyrillic, Japanese or with an accent is an ordinary
 * setup, not an attack. Spaces and backslashes stay in for the same reason —
 * `/Users/me/My Project` and `C:\\Users\\me` must keep working.
 *
 * Refusing beats quoting. `$( )` and backticks are still expanded inside double
 * quotes, and single quotes are not portable to `cmd.exe`, so there is no
 * quoting rule that is both correct and cross-platform here.
 */
const SHELL_SAFE_PATH = /^[\p{L}\p{N}_@%+=:,./\\ -]*$/u;

/** The last `count` non-empty lines of a command's output, for a notification. */
export function lastLines(output: string, count: number): string {
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(-count).join('\n');
}

/** How a command finished, as far as the message builder cares. */
export interface UseCommandOutcome {
  /** Exit code, or null when the process was signalled or never started. */
  code: number | null;
  /** Signal that terminated it, if any. */
  signal: string | null;
  /** The timeout fired and the process group was killed. */
  timedOut: boolean;
  /** The spawn itself failed (a bad interpreter, an unreadable script). */
  spawnError?: string;
  /** stdout and stderr, interleaved, tail-bounded. */
  output: string;
}

/** True only for a clean exit — the single condition that lets a URL load. */
export function useCommandSucceeded(outcome: UseCommandOutcome): boolean {
  return outcome.code === 0 && !outcome.timedOut && outcome.spawnError === undefined;
}

/**
 * The notification text for a pre-use command that did not exit 0.
 *
 * Built here, not at the call site, so that the three things a user needs in
 * order to act — WHICH entry, HOW it failed, and WHAT the command actually
 * said — cannot be dropped one refactor later without a test noticing. The
 * full output goes to the `Remote VNC` output channel; only a tail fits in a
 * notification, so the message says where the rest is.
 */
export function useCommandFailureMessage(
  name: string,
  outcome: UseCommandOutcome,
  timeoutMs: number
): string {
  let why: string;
  if (outcome.spawnError !== undefined) {
    why = `could not start — ${outcome.spawnError}`;
  } else if (outcome.timedOut) {
    why = `timed out after ${Math.round(timeoutMs / 1000)}s and was killed`;
  } else if (outcome.signal) {
    why = `was killed by ${outcome.signal}`;
  } else {
    why = `exited with code ${outcome.code}`;
  }
  const tail = lastLines(outcome.output, 3);
  return (
    `Remote VNC: the preUseCommand for "${name}" ${why}, so the entry was not opened.` +
    (tail ? ` Last output:\n${tail}` : '') +
    '\nSee the "Remote VNC" output channel for the full log.'
  );
}

/**
 * Who is currently relying on a `postUseCommand`, so the last one out runs it.
 *
 * Keyed by the COMMAND, not by the entry. What must not be torn down early is
 * the stack the command controls, and the command string is the identity of
 * that stack: two saved entries that manage the same one — the kiosk page and
 * a VNC connection to the same device, both `barto-mac up`/`barto-mac stop` —
 * then share a key automatically, and closing the first tab does not stop the
 * stack out from under the second. Keying by entry name would run the stop
 * command while another entry's tab was still using it.
 *
 * Holders are identified by an opaque token rather than counted, and that is
 * the same hazard `pagePanel.ts`'s `onDidDispose` guards with an identity
 * check: a stale dispose must not decrement a count a newer panel incremented.
 * With tokens it cannot — a release names exactly which holder went away, a
 * token released twice is a no-op, and a token nobody holds is ignored.
 */
export class PostUseTracker {
  private readonly holders = new Map<string, Set<string>>();
  private readonly commandOfToken = new Map<string, string>();

  /** Record that `token` now depends on `command`. */
  acquire(command: string, token: string): void {
    this.commandOfToken.set(token, command);
    const tokens = this.holders.get(command) ?? new Set<string>();
    tokens.add(token);
    this.holders.set(command, tokens);
  }

  /** Release a holder; returns the command to run when it was the last one. */
  release(token: string): string | undefined {
    const command = this.commandOfToken.get(token);
    if (command === undefined) {
      return undefined; // never acquired, or already released
    }
    this.commandOfToken.delete(token);
    const tokens = this.holders.get(command);
    tokens?.delete(token);
    if (tokens && tokens.size === 0) {
      this.holders.delete(command);
      return command;
    }
    return undefined;
  }

  /**
   * Every outstanding command, dropping all holders — for window close, where
   * the panels' own dispose handlers are not guaranteed to run.
   */
  drain(): string[] {
    const commands = [...this.holders.keys()];
    this.holders.clear();
    this.commandOfToken.clear();
    return commands;
  }

  /** Commands with at least one holder — for tests and diagnostics. */
  get pending(): number {
    return this.holders.size;
  }
}
