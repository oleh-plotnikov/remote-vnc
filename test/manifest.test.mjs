// Manifest inspection. Everything asserted here is a fact that only
// package.json states and that nothing checks: TypeScript never reads the
// manifest, so a viewType typo, a priority left at its most obvious value or a
// `when` clause copied from the entry above it all compile, package and
// install cleanly — and then fail at runtime as a menu item that never appears
// or a command that opens nothing, with no error in any log. Read as text, the
// way test/thirdPartyNotices.test.mjs reads the notices.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from './bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

export default async function ({ ok, eq }) {
  // The one place this file compares the manifest against a NUMBER the code
  // also holds. Everything else here is a fact only package.json states.
  const { DEFAULT_PRE_USE_TIMEOUT_MS, MIN_PRE_USE_TIMEOUT_MS, MAX_PRE_USE_TIMEOUT_MS } =
    await load('useCommands.ts');
  // A manifest that does not parse is not a broken feature, it is an extension
  // that never loads, so this is the first assertion and it throws rather than
  // counting a failure.
  const manifest = JSON.parse(read('package.json'));

  const editors = manifest.contributes.customEditors;
  eq(editors.length, 1, 'exactly one custom editor is contributed');
  const crop = editors[0];

  // The one field here that is a correctness decision rather than a taste.
  ok(
    crop.priority === 'option',
    'the crop editor is contributed at priority "option": VS Code ranks editor candidates ' +
      'default=4, builtin=3, text=2, option=1, and the built-in image preview registers ' +
      '*.png at builtin=3 — at "default" this editor would outrank it and silently hijack ' +
      'every PNG in every workspace, while vscode.openWith bypasses ranking for our own flow'
  );

  // Nothing links these two literals at compile time, and vscode.openWith fails
  // at runtime on a mismatch — with a tab that simply never opens.
  const declared = /export const CROP_VIEW_TYPE = '([^']+)'/.exec(read('src/cropEditor.ts'));
  ok(declared, 'src/cropEditor.ts exports a CROP_VIEW_TYPE string literal');
  eq(
    crop.viewType,
    declared?.[1],
    'the manifest viewType equals CROP_VIEW_TYPE in src/cropEditor.ts'
  );

  // Widening this selector is how the extra Reopen Editor With… row starts
  // appearing on files the crop editor cannot read.
  eq(
    crop.selector,
    [{ filenamePattern: '*.png' }],
    'the crop editor is offered for *.png and nothing else'
  );

  const titles = manifest.contributes.menus['editor/title'];
  const entry = titles.find((item) => item.command === 'remoteVnc.cropImage');
  ok(entry, 'remoteVnc.cropImage has an editor/title entry');
  // The three entries beside this one all key off activeWebviewPanelId, which
  // is the trap: the image preview is a custom editor and never sets that key,
  // so copying the neighbouring idiom yields a button that silently never
  // shows.
  ok(
    entry?.when.includes('activeCustomEditorId'),
    'the crop button keys off activeCustomEditorId, the only key the image preview sets'
  );
  ok(
    !entry?.when.includes('activeWebviewPanelId'),
    'the crop button does not key off activeWebviewPanelId, which the image preview never sets'
  );

  const setting = manifest.contributes.configuration.properties['remoteVnc.screenshotCropEditor'];
  ok(setting, 'remoteVnc.screenshotCropEditor is declared, so it reaches the Settings UI');
  eq(setting?.type, 'boolean', 'remoteVnc.screenshotCropEditor is a boolean');
  eq(
    setting?.default,
    true,
    'remoteVnc.screenshotCropEditor defaults to true, so a capture lands in the crop editor'
  );

  // remoteVnc.chromePath names a binary the extension SPAWNS (launchChrome,
  // via resolveChromeBinary). At the default "window" scope a cloned repo's
  // .vscode/settings.json could name it, so opening any mirrored page — even
  // a user-level one, even in an untrusted workspace, where nothing else in
  // the config is honoured — would execute a binary the repo chose. Only the
  // manifest decides this: resolveChromeBinary reads the setting with a plain
  // get() and cannot tell where the value came from.
  const chromePath = manifest.contributes.configuration.properties['remoteVnc.chromePath'];
  ok(chromePath, 'remoteVnc.chromePath is declared');
  eq(
    chromePath?.scope,
    'machine',
    'remoteVnc.chromePath is machine-scoped, so only user/remote settings can name the binary — ' +
      'not "machine-overridable", which a workspace can override, and not the default "window"'
  );
  // Every OTHER setting stays where it is: this is the only one that names an
  // executable, and blanket-machine-scoping the rest would break per-repo
  // saved pages, which are workspace settings by design (src/pages.ts).
  const machineScoped = Object.entries(manifest.contributes.configuration.properties)
    .filter(([, v]) => v.scope === 'machine')
    .map(([k]) => k);
  eq(
    machineScoped,
    ['remoteVnc.chromePath'],
    'chromePath is the only machine-scoped setting — the workspace-configurable ones stay that way'
  );

  // remoteVnc.mirrorFrameRate bounds what a mirrored tab costs while it is
  // open. src/pagePanel.ts clamps the value it reads (clampFps, 1..30), so a
  // manifest without the matching minimum/maximum would not be a bug so much as
  // a Settings UI that silently disagrees with the code — and a missing
  // declaration would keep the setting out of that UI altogether, which is the
  // only place a user could turn the cost down.
  const mirrorFps = manifest.contributes.configuration.properties['remoteVnc.mirrorFrameRate'];
  ok(mirrorFps, 'remoteVnc.mirrorFrameRate is declared, so it reaches the Settings UI');
  eq(
    mirrorFps?.type,
    'integer',
    'remoteVnc.mirrorFrameRate is an integer — it maps to a whole-number frame divisor'
  );
  // 30, not 10: a mirror is a live, clickable page, not only something
  // reviewed — a user typing into one at 10 fps saw a 100ms+ keystroke lag
  // that read as the page hanging. See DEFAULT_MIRROR_FPS in src/pagePanel.ts.
  eq(mirrorFps?.default, 30, 'remoteVnc.mirrorFrameRate defaults to 30 fps, tuned for typing/clicking, not just reviewing');
  eq(
    [mirrorFps?.minimum, mirrorFps?.maximum],
    [1, 30],
    "the declared range matches clampFps's own 1..30, so the UI cannot offer a value the code discards"
  );
  ok(
    /CPU/i.test(mirrorFps?.markdownDescription ?? mirrorFps?.description ?? ''),
    'and its description says what raising it costs, which is the entire reason it is settable'
  );

  // remoteVnc.mirrorLaunchTimeout: the hardcoded 15s guess (src/chromeProcess.ts)
  // did not survive contact with a memory-constrained machine, so it had to
  // become both bigger and user-settable — a manifest without this declared
  // would leave the second half of that fix unreachable from the Settings UI.
  const launchTimeout = manifest.contributes.configuration.properties['remoteVnc.mirrorLaunchTimeout'];
  ok(launchTimeout, 'remoteVnc.mirrorLaunchTimeout is declared, so it reaches the Settings UI');
  eq(launchTimeout?.type, 'integer', 'remoteVnc.mirrorLaunchTimeout is an integer number of seconds');
  eq(launchTimeout?.default, 45, 'remoteVnc.mirrorLaunchTimeout defaults to 45s — three times the 15s guess that missed on an ordinary open');
  eq(
    [launchTimeout?.minimum, launchTimeout?.maximum],
    [5, 120],
    "the declared range matches clampLaunchTimeoutMs's own bounds, so the UI cannot offer a value the code silently reclamps"
  );
  ok(
    /DevTools endpoint/i.test(launchTimeout?.markdownDescription ?? launchTimeout?.description ?? ''),
    'and its description names the actual failure this setting works around'
  );

  // preUseCommand/postUseCommand run ARBITRARY SHELL COMMANDS out of settings,
  // and unlike remoteVnc.chromePath they cannot be fixed with machine scope —
  // the legitimate case is a workspace entry (this is a per-repo dev server),
  // so the gate is Workspace Trust and it lives in src/useCommands.ts. What
  // only the manifest can do is TELL the user, in the Settings UI and on the
  // Marketplace page, that these execute shell commands and when they will be
  // ignored. A description that omits either is how a user ends up trusting a
  // workspace without knowing what trusting it turns on.
  const { properties } = manifest.contributes.configuration;
  for (const setting of ['remoteVnc.pages', 'remoteVnc.connections']) {
    const fields = properties[setting].items.properties;
    for (const field of ['preUseCommand', 'postUseCommand']) {
      const declared = fields[field];
      ok(declared, `${setting} declares ${field}, so it reaches the Settings UI at all`);
      eq(declared?.type, 'string', `${setting}.${field} is a string`);
      const text = declared?.markdownDescription ?? declared?.description ?? '';
      ok(
        /shell command/i.test(text),
        `${setting}.${field}'s description says plainly that it runs a shell command`
      );
      ok(
        /trusted/i.test(text) && /ignored/i.test(text),
        `${setting}.${field}'s description says it is ignored unless the workspace is trusted`
      );
    }
    // Bounds that disagree with clampPreUseTimeoutMs would not be a bug so much
    // as a Settings UI that silently offers values the code reclamps. Taken
    // from the constants rather than written down again here: a literal agrees
    // with the manifest and stops agreeing with the CODE the moment a bound
    // moves, which is the one thing this assertion exists to catch.
    const timeout = fields.preUseTimeout;
    ok(timeout, `${setting} declares preUseTimeout`);
    eq(timeout?.type, 'integer', `${setting}.preUseTimeout is a whole number of seconds`);
    eq(
      timeout?.default,
      DEFAULT_PRE_USE_TIMEOUT_MS / 1000,
      `${setting}.preUseTimeout's default is DEFAULT_PRE_USE_TIMEOUT_MS, in seconds`
    );
    eq(
      [timeout?.minimum, timeout?.maximum],
      [MIN_PRE_USE_TIMEOUT_MS / 1000, MAX_PRE_USE_TIMEOUT_MS / 1000],
      `${setting}.preUseTimeout's declared range matches clampPreUseTimeoutMs's own bounds`
    );
    ok(
      /process group/i.test(timeout?.markdownDescription ?? timeout?.description ?? ''),
      `${setting}.preUseTimeout says what a timeout actually kills — the group, not just the shell`
    );
  }
  // The trust declaration is what puts this window in Restricted Mode in the
  // first place; "supported": true would mean the extension claims it needs no
  // gating, and every strip in src/useCommands.ts would then be unreachable.
  eq(
    manifest.capabilities.untrustedWorkspaces.supported,
    'limited',
    'the extension declares limited untrusted-workspace support, which is what makes the trust gate mean anything'
  );
  ok(
    /shell command/i.test(manifest.capabilities.untrustedWorkspaces.description ?? ''),
    'and the trust dialog text names the shell commands as the reason trust matters'
  );

  // The focus-chord dispatchers: a typo in either the command id or the
  // when-clause here compiles and packages cleanly, then silently produces a
  // hotkey that never fires or one that fires everywhere (including while
  // typing in a source file) — nothing but reading the manifest catches it.
  const commandIds = manifest.contributes.commands.map((c) => c.command);
  ok(
    commandIds.includes('remoteVnc.screenshotFocused'),
    'remoteVnc.screenshotFocused is a declared command'
  );
  ok(
    commandIds.includes('remoteVnc.recordFocusedToggle'),
    'remoteVnc.recordFocusedToggle is a declared command'
  );

  // The mirror's escape hatch. `restartMirrorWebview` was the documented
  // recovery for a stuck mirrored tab and had no user-reachable entry point at
  // all — the only way in was reopen()'s `!webviewLive` branch, which the
  // frozen-with-a-live-webview case never takes. A command declared here is
  // what makes it reachable; a command NOT declared here is a registerCommand
  // call nobody can run.
  ok(
    commandIds.includes('remoteVnc.restartMirror'),
    'remoteVnc.restartMirror is a declared command, so the mirror recovery is reachable at all'
  );
  ok(
    read('src/extension.ts').includes("registerCommand('remoteVnc.restartMirror'"),
    'and src/extension.ts registers that exact id — a declared command with no handler is a palette entry that errors'
  );
  const restart = manifest.contributes.commands.find((c) => c.command === 'remoteVnc.restartMirror');
  eq(restart?.category, 'Remote VNC', 'it is grouped with the rest under "Remote VNC" in the palette');

  // Every OTHER page command is hidden from the palette, because each needs a
  // tree item to act on. This one must NOT be: the user it exists for is
  // looking at a stuck tab, not at the sidebar, and it falls back to the
  // focused panel precisely so the palette can reach it.
  const hiddenFromPalette = manifest.contributes.menus.commandPalette
    .filter((e) => e.when === 'false')
    .map((e) => e.command);
  eq(
    hiddenFromPalette.includes('remoteVnc.restartMirror'),
    false,
    'the restart is NOT gated out of the Command Palette — discoverability is half the fix'
  );

  // And it is on the Web Pages row too, because clicking the page there is
  // what a user tries first on anything that looks stuck.
  const restartRows = manifest.contributes.menus['view/item/context'].filter(
    (e) => e.command === 'remoteVnc.restartMirror'
  );
  eq(restartRows.length, 1, 'the restart has exactly one Web Pages row entry');
  ok(
    restartRows[0]?.when.includes('remoteVnc.pagesView'),
    'and it is contributed to the Web Pages view, not to a tree that has no pages in it'
  );

  const keybindings = manifest.contributes.keybindings;
  ok(Array.isArray(keybindings) && keybindings.length === 2, 'exactly two keybindings are contributed');
  for (const [command, key] of [
    ['remoteVnc.screenshotFocused', 's'],
    ['remoteVnc.recordFocusedToggle', 'r'],
  ]) {
    const binding = keybindings.find((k) => k.command === command);
    ok(binding, `${command} has a keybinding`);
    eq(binding?.key, `ctrl+alt+${key}`, `${command}'s Windows/Linux key is ctrl+alt+${key}`);
    eq(binding?.mac, `cmd+alt+${key}`, `${command}'s mac key is cmd+alt+${key}`);
    eq(
      binding?.when,
      'remoteVnc.panelFocused',
      `${command} only fires while a panel is focused, so it cannot hijack the chord in a source file`
    );
  }
}
