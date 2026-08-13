// Where a capture is allowed to land when the workspace is not trusted.
//
// `screenshotAction: 'save'` removes the save dialog and `screenshotDirectory`
// names the destination. Both were plain window-scoped settings, so a
// `.vscode/settings.json` in a cloned repository could set them and have every
// screenshot of a live VNC session written, silently and with no dialog, into a
// directory of that repository's choosing — inside the repository itself, say,
// where the next commit would carry it away.
//
// The entries in `remoteVnc.connections` and `remoteVnc.pages` already refuse
// to come from an untrusted workspace. These two decide what leaves the screen,
// so they refuse the same way.
import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { saveCaptureBytes } = await load('captureSave.ts');
  const bytes = Uint8Array.from([1, 2, 3]);

  const reset = () => {
    globalThis.__config = undefined;
    globalThis.__configWorkspace = undefined;
    globalThis.__configFolder = undefined;
    globalThis.__fsWrites = [];
    globalThis.__dialogsEnabled = true;
    globalThis.__dialogCalls = [];
    globalThis.__dialogAnswers = {};
    globalThis.__isTrusted = true;
  };

  // --- the attack: a workspace names the destination, the window is untrusted
  {
    reset();
    globalThis.__isTrusted = false;
    globalThis.__configWorkspace = { remoteVnc: { screenshotDirectory: '/repo/exfil' } };
    // No dialog answer, so the save is cancelled — what matters is where it did
    // NOT go on the way there.
    await saveCaptureBytes(bytes, 'shot.png', {}, 'screenshot', 'hmi');
    const wrote = (globalThis.__fsWrites ?? []).map((w) => w.path);
    eq(wrote, [], 'nothing is written to a directory an untrusted workspace chose');
    ok(
      globalThis.__dialogCalls.some((c) => c.name === 'showSaveDialog'),
      'the user is asked instead — the silent path is exactly what the workspace was buying'
    );
  }

  // --- the same setting from the user's own settings is still obeyed ---------
  // The gate is about where the value came from, not about the value. Breaking
  // this would make an untrusted workspace disable a setting the user set for
  // themselves, which is a different bug in the other direction.
  {
    reset();
    globalThis.__isTrusted = false;
    globalThis.__config = { remoteVnc: { screenshotDirectory: '/home/me/shots' } };
    await saveCaptureBytes(bytes, 'shot.png', {}, 'screenshot', 'hmi');
    const wrote = (globalThis.__fsWrites ?? []).map((w) => w.path);
    eq(wrote, ['/home/me/shots/shot.png'], "a user-level directory is honoured even in an untrusted window");
    ok(
      !globalThis.__dialogCalls.some((c) => c.name === 'showSaveDialog'),
      'and no dialog is raised, because nothing was ignored'
    );
  }

  // --- a trusted workspace keeps its per-project directory ------------------
  // Declaring the setting "scope": "machine" would also stop the attack, by
  // taking this away. Trust is the axis that matters, so trust is the gate.
  {
    reset();
    globalThis.__isTrusted = true;
    globalThis.__configWorkspace = { remoteVnc: { screenshotDirectory: '/project/shots' } };
    await saveCaptureBytes(bytes, 'shot.png', {}, 'screenshot', 'hmi');
    const wrote = (globalThis.__fsWrites ?? []).map((w) => w.path);
    eq(wrote, ['/project/shots/shot.png'], 'a trusted workspace still gets its own capture directory');
  }

  reset();
  globalThis.__fsWrites = undefined;
  globalThis.__dialogsEnabled = false;
  globalThis.__isTrusted = true;
}
