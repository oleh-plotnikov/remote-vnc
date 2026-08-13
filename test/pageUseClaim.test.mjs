// The page tab's half of the post-use claim: fix round 2 for the defect that
// closing a tab mid-`preUseCommand` ran the stop command under the start
// command and orphaned the stack (the ordering itself is proved in
// test/useCommandRunner.test.mjs, with real processes).
//
// `openPagePanel` needs a real WebviewPanel and cannot be driven from a test —
// test/pageCapture.test.mjs says the same of its own subjects — so what is
// reachable here is the seam the dispose handler calls, plus the shape of the
// call it makes. Both matter: the seam can be right while the dispose handler
// still calls the old, immediate release, which is exactly the state this
// branch shipped in.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from './bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default async function ({ ok, eq }) {
  const { releaseUseClaim } = await load('pagePanel.ts');

  // A claim is given up exactly once. The tracker ignores a token nobody
  // holds, so a second release is harmless there — but a panel that kept its
  // token would hand the same one to every later dispose, and "harmless
  // because the tracker forgives it" is not the same as "cannot happen".
  const entry = { useToken: 'use-1', preUsePending: undefined };
  releaseUseClaim(entry);
  eq(entry.useToken, undefined, 'releasing a claim clears the panel’s token');
  releaseUseClaim(entry); // must not throw, and must not release anything twice
  eq(entry.useToken, undefined, 'and a second dispose of the same panel has nothing left to give up');

  // A page with no postUseCommand never took a claim; the dispose path still
  // runs for it, on every tab in the window that has no use commands at all.
  let threw = false;
  try {
    releaseUseClaim({});
  } catch {
    threw = true;
  }
  ok(!threw, 'a panel that never held a claim releases nothing and does not throw');

  // The token is cleared BEFORE the release is scheduled, so an in-flight
  // pre-use command cannot leave a panel holding a token it has already
  // promised away.
  const pending = new Promise(() => {}); // never settles: the tab was closed mid-command
  const midCommand = { useToken: 'use-2', preUsePending: pending };
  releaseUseClaim(midCommand);
  eq(
    midCommand.useToken,
    undefined,
    'a panel closed mid-command gives its token up immediately, even though the release itself waits'
  );

  // And the wiring: the dispose handler must go through the deferring release.
  // Nothing else can catch this — `releasePostUseCommand` and
  // `releasePostUseCommandAfter` have the same effect on every test that does
  // not close a tab mid-command, which is every test but one.
  const src = readFileSync(join(ROOT, 'src/pagePanel.ts'), 'utf8');
  ok(
    /releasePostUseCommandAfter\(entry\.preUsePending, token\)/.test(src),
    'pagePanel releases a claim through releasePostUseCommandAfter, carrying the in-flight pre-use command'
  );
  ok(
    !/[^A-Za-z]releasePostUseCommand\(/.test(src),
    'and never through the immediate release — that call is what runs a stop command under a running start command'
  );
  ok(
    /entry\.preUsePending = pending/.test(src),
    'and the pre-use command is published on the entry while it runs, or the dispose path would have nothing to wait on'
  );
}
