// Which layer of a setting a window is allowed to obey.
//
// `remoteVnc.connections` and `remoteVnc.pages` already drop their workspace
// and folder layers in an untrusted window (collectConnections/collectPages).
// The capture settings did not, and they are the pair that decides where screen
// content lands: `screenshotAction: 'save'` removes the save dialog and
// `screenshotDirectory` names the destination, so a `.vscode/settings.json` in
// a cloned repository could route screenshots of a VNC session into a folder
// inside that same repository, silently, with nothing shown to the user.
//
// The rule is VS Code's own precedence — folder, then workspace, then user,
// then the declared default — with the first two layers removed when the
// workspace is not trusted.
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { trustedSetting } = await load('trustedSetting.ts');

  const all = {
    defaultValue: 'open',
    globalValue: 'user',
    workspaceValue: 'ws',
    workspaceFolderValue: 'folder',
  };

  eq(trustedSetting(all, true).value, 'folder', 'trusted: the folder layer wins, as VS Code would resolve it');
  eq(trustedSetting(all, true).ignored, false, 'trusted: nothing was dropped');
  eq(trustedSetting({ ...all, workspaceFolderValue: undefined }, true).value, 'ws', 'trusted: workspace is next');

  eq(trustedSetting(all, false).value, 'user', 'untrusted: both workspace layers are dropped, the user value stands');
  eq(trustedSetting(all, false).ignored, true, 'untrusted: and the drop is reported so it can be logged');
  eq(
    trustedSetting({ defaultValue: 'open', workspaceValue: 'ws' }, false).value,
    'open',
    'untrusted with no user value: the declared default, never the workspace one'
  );
  eq(
    trustedSetting({ defaultValue: 'open', workspaceFolderValue: 'folder' }, false).value,
    'open',
    'a folder value is workspace-supplied too — the same drop applies'
  );

  // Nothing to drop is not the same as something dropped: a window with only a
  // user value must not log an "ignored" line every time a capture is saved.
  eq(
    trustedSetting({ defaultValue: 'open', globalValue: 'user' }, false).ignored,
    false,
    'untrusted with no workspace value: nothing was ignored'
  );

  // A missing inspect() is the "setting was never declared" case, and an
  // undefined value must survive rather than becoming a string.
  eq(trustedSetting(undefined, true).value, undefined, 'no inspection yields no value');
  eq(trustedSetting(undefined, false).ignored, false, 'and nothing to ignore');

  // Falsy values must survive the layering — `screenshotDirectory` defaults to
  // '' and a user who blanks it in their own settings means it.
  eq(trustedSetting({ defaultValue: 'x', globalValue: '' }, true).value, '', 'an empty user value is a value, not a miss');
  ok(trustedSetting({ defaultValue: true, globalValue: false }, true).value === false, 'false is a value too');
}
