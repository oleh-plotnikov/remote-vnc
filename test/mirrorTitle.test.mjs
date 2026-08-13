// What a mirrored tab is allowed to leave unsaid.
//
// A mirrored page is a real browser tab with no URL bar. The page can navigate
// itself — a redirect, a meta refresh, a link the user clicked inside the
// mirror — and every keystroke the user types keeps being forwarded to
// whatever is there now. Nothing in the tab said where "there" is: the title
// was the saved entry's name, from open until close.
//
// This does not block the navigation. A dev server that redirects, or an OAuth
// round trip, is ordinary and legitimate; refusing it would break more than it
// protects. What it does is stop the tab from being silent about it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default async function ({ ok, eq }) {
  const { mirrorTabTitle } = await load('pagePanel.ts');
  const saved = 'http://localhost:5173/app';

  // Same origin: the name alone, because a path change is what a page DOES.
  // A title that rewrote itself on every route change would be noise, and
  // noise is what makes the one meaningful change unnoticeable.
  eq(mirrorTabTitle('dev', saved, 'http://localhost:5173/app'), 'dev', 'the page it was opened at');
  eq(mirrorTabTitle('dev', saved, 'http://localhost:5173/settings/theme'), 'dev', 'a route change is not a departure');
  eq(mirrorTabTitle('dev', saved, 'http://localhost:5173/app?q=1#top'), 'dev', 'nor is a query or a fragment');

  // A different origin is the whole point: it is named, and named in the one
  // place the user is already looking.
  eq(
    mirrorTabTitle('dev', saved, 'https://accounts.example.com/login'),
    'dev — https://accounts.example.com',
    'another origin is named in the title'
  );
  eq(
    mirrorTabTitle('dev', saved, 'http://localhost:5174/app'),
    'dev — http://localhost:5174',
    'a different port is a different origin, which is exactly the case a glance would miss'
  );
  eq(
    mirrorTabTitle('dev', saved, 'https://localhost:5173/app'),
    'dev — https://localhost:5173',
    'and so is a different scheme'
  );

  // Transient and opaque states must not flap the title. `about:blank` is what
  // a tab shows mid-navigation, and a title that flickered through it on every
  // redirect would train the user to ignore the very signal this adds.
  for (const quiet of ['about:blank', '', undefined, 'not a url', 'data:text/html,<h1>x']) {
    eq(mirrorTabTitle('dev', saved, quiet), 'dev', `no origin to report: ${JSON.stringify(quiet)}`);
  }

  // A saved URL that cannot be parsed leaves nothing to compare against, so
  // there is no "departure" to claim.
  eq(mirrorTabTitle('dev', 'nonsense', 'https://evil.example.com/'), 'dev', 'an unparseable saved URL reports nothing');

  ok(
    !mirrorTabTitle('dev', saved, 'https://accounts.example.com/login?token=SECRET').includes('SECRET'),
    'only the origin is shown — the path and query of a page we do not control are not ours to print'
  );

  // And the wiring. startMirror needs a real WebviewPanel and a real browser,
  // so what is reachable here is that the three pieces exist: the Page domain
  // has to be enabled for the event to be delivered at all (the mirror
  // previously subscribed to nothing but Page.screencastFrame), the event has
  // to be subscribed, and the handler has to put the result on the tab.
  const src = readFileSync(join(ROOT, 'src/pagePanel.ts'), 'utf8');
  ok(/'Page\.enable'/.test(src), 'the Page domain is enabled — without it frameNavigated is never delivered');
  ok(/cdp\.on\('Page\.frameNavigated'/.test(src), 'the navigation event is subscribed');
  ok(/panel\.title = mirrorTabTitle\(/.test(src), 'and what it computes reaches the tab title');
}
