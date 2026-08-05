/* eslint-disable */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

/** Read a dependency's version straight off disk. `require`ing its package.json
 *  fails on packages whose `exports` map does not expose that path. */
const depVersion = (name) =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, 'node_modules', name, 'package.json'), 'utf8')
  ).version;

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Attribution for the third-party code compiled into each bundle. esbuild only
// preserves comments carrying @license/@preserve (or opening with `/*!`), and
// neither dependency marks its headers that way — so minification strips every
// copyright notice. Re-adding them as banners is the only thing that survives.
// Versions are read at build time so the banner versions cannot drift from
// what ships; the notice TEXTS are hand-written and pinned to the installed
// packages by test/thirdPartyNotices.test.mjs instead.
const novncBanner = `/*! Bundles noVNC ${depVersion('@novnc/novnc')} (core library)
 * Copyright (C) The noVNC authors — Mozilla Public License 2.0
 * Source: https://github.com/novnc/noVNC — license: https://mozilla.org/MPL/2.0/
 *
 * noVNC carries two components that are not MPL 2.0 and travel with it here:
 *   pako — Copyright (C) 2014-2016 by Vitaly Puzrin — MIT
 *   DES cipher — Copyright (c) 1996 Widget Workshop, Inc.;
 *                Copyright (C) 1999 AT&T Laboratories Cambridge;
 *                Copyright (C) 1996 Jef Poskanzer (BSD terms)
 *
 * Also bundles gifenc ${depVersion('gifenc')} — (c) 2017 Matt DesLauriers — MIT
 * Source: https://github.com/mattdesl/gifenc
 *
 * Full notices: THIRD-PARTY-NOTICES.md, shipped with this extension.
 */`;
const wsBanner = `/*! Bundles ws ${depVersion('ws')}
 * Copyright (c) 2011 Einar Otto Stangvik, 2013 Arnout Kazemier and contributors,
 * 2016 Luigi Pinca and contributors — MIT License
 * Source: https://github.com/websockets/ws
 * Full notices: THIRD-PARTY-NOTICES.md, shipped with this extension.
 */`;

/** Shared problem-matcher friendly logging for watch mode. */
const watchPlugin = {
  name: 'watch-plugin',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

/** Extension host bundle (Node.js / CommonJS). */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  banner: { js: wsBanner },
  external: [
    'vscode',
    // Optional native acceleration deps of `ws` — never required at runtime.
    'bufferutil',
    'utf-8-validate',
  ],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** Webview bundle (browser context, runs inside the panel). */
const webviewConfig = {
  entryPoints: ['media/webview.ts'],
  bundle: true,
  // noVNC uses top-level await (WebCodecs feature detection), which can only be
  // represented in an ES module output — so the panel loads it as a module.
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'media/webview.js',
  banner: { js: novncBanner },
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  const configs = [extensionConfig, webviewConfig];
  if (watch) {
    const contexts = await Promise.all(
      configs.map((c) => esbuild.context({ ...c, plugins: [watchPlugin] }))
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[watch] watching for changes…');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
