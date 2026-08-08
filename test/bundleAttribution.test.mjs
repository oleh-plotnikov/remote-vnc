// Attribution reachability check: what actually ends up inside each shipped
// bundle, against what that bundle's banner claims is inside it.
//
// test/thirdPartyNotices.test.mjs is the other half of this. It reads the
// *text* of esbuild.js and THIRD-PARTY-NOTICES.md and pins the wording to the
// installed packages, so a dependency bump cannot leave a stale notice behind.
// What it cannot see is whether that wording describes reality: it never builds
// anything, so a bundle that quietly acquired a new dependency — or a banner
// that stopped being emitted at all — passes it untouched.
//
// So this file builds the real configs (imported from esbuild.js, never copied:
// a copy is the one thing certain to drift) and asks two questions of each
// output. Which packages are genuinely compiled into it? And does the text at
// the top of the minified artefact name every one of them?
//
// Minified on purpose. Minification is what strips the original copyright
// headers in the first place — AGENTS.md records that esbuild's `legalComments`
// does not save them, because neither noVNC nor ws marks its headers
// @license/@preserve — so the banner is the only attribution that survives into
// a release, and the release build is the one worth testing.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What each bundled package must be called in a banner, and in the notices.
 *
 * A package missing from this map is a FAILURE rather than a skip, and that is
 * the whole point of the file: adding a dependency that reaches a bundle cannot
 * pass until somebody has decided what its attribution says. The names differ
 * from the package ids on purpose — the banner calls `@novnc/novnc` "noVNC",
 * which is what its own authors call it.
 */
const ATTRIBUTION = {
  '@novnc/novnc': 'noVNC',
  gifenc: 'gifenc',
  ws: 'ws',
};

/** The npm package an input path belongs to, or undefined for first-party code.
 *  Handles the `node_modules.nosync` symlink this repo uses to keep
 *  dependencies out of cloud sync, and scoped names. */
function packageOf(input) {
  const m = /node_modules(?:\.nosync)?\/((?:@[^/]+\/)?[^/]+)/.exec(input);
  return m ? m[1] : undefined;
}

export default async function ({ ok, eq }) {
  const { configs } = require(join(ROOT, 'esbuild.js'));

  ok(configs.length >= 3, `esbuild.js exports its bundles (${configs.length} found)`);

  for (const config of configs) {
    const name = config.outfile;
    // write: false — the test must never leave a production build sitting where
    // the developer's dev build was, and must not race `npm run watch`.
    const result = await build({
      ...config,
      minify: true,
      sourcemap: false,
      metafile: true,
      write: false,
      logLevel: 'silent',
    });

    const packages = [
      ...new Set(Object.keys(result.metafile.inputs).map(packageOf).filter(Boolean)),
    ].sort();
    const output = result.outputFiles[0].text;

    for (const pkg of packages) {
      ok(
        pkg in ATTRIBUTION,
        `${name} bundles ${pkg}, which test/bundleAttribution.test.mjs has no ` +
          'attribution name for — add it to ATTRIBUTION, to the bundle banner ' +
          'and to THIRD-PARTY-NOTICES.md'
      );
      const label = ATTRIBUTION[pkg];
      if (!label) {
        continue; // already reported above; nothing sensible left to check
      }
      // The head of the file, not the whole of it: a match anywhere would be
      // satisfied by the string appearing inside the dependency's own minified
      // code, which proves nothing about attribution.
      ok(
        output.slice(0, 4000).includes(label),
        `${name} carries a banner naming ${label}`
      );
      ok(
        readFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8').includes(label),
        `THIRD-PARTY-NOTICES.md documents ${label}, bundled into ${name}`
      );
    }

    // A bundle with nothing third-party inside it needs no banner, and this is
    // where that stays true rather than being remembered: the moment such a
    // bundle gains a node_modules input, the loop above runs for the first time
    // and fails on a banner that was never written.
    if (packages.length === 0) {
      ok(
        !output.startsWith('/*!'),
        `${name} has no third-party inputs and no banner claiming otherwise`
      );
    }
  }

  // Pin today's answer as well as the rule. The rule alone would stay green if
  // a bundle silently lost a dependency it is supposed to contain — noVNC
  // dropping out of the viewer would be a broken extension, not an attribution
  // improvement.
  const bundled = {};
  for (const config of configs) {
    const result = await build({ ...config, metafile: true, write: false, logLevel: 'silent' });
    bundled[config.outfile] = [
      ...new Set(Object.keys(result.metafile.inputs).map(packageOf).filter(Boolean)),
    ].sort();
  }
  eq(
    bundled,
    {
      'dist/extension.js': ['ws'],
      'media/webview.js': ['@novnc/novnc', 'gifenc'],
      'media/cropEditor.js': [],
    },
    'each bundle contains exactly the third-party packages it is expected to'
  );
}
