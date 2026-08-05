// Attribution drift check. The notice texts and banner copyright lines are
// hand-written; only the version numbers are generated at build time. This
// test pins them to the packages actually installed, so a dependency upgrade
// that changes upstream terms fails the suite instead of silently shipping
// stale attribution.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
/** Collapse whitespace so line-wrapping differences cannot mask (or fake) a match. */
const squash = (s) => s.replace(/\s+/g, ' ').trim();

export default async function ({ ok }) {
  const notices = squash(read('THIRD-PARTY-NOTICES.md'));
  const banners = read('esbuild.js');

  // MIT dependencies that ship: the upstream license text must be reproduced
  // in the notices verbatim (modulo wrapping) — MIT's one condition.
  for (const [name, licensePath] of [
    ['ws', 'node_modules/ws/LICENSE'],
    ['gifenc', 'node_modules/gifenc/LICENSE.md'],
  ]) {
    ok(
      notices.includes(squash(read(licensePath))),
      `${name}: upstream license text is reproduced in THIRD-PARTY-NOTICES.md`
    );
  }

  // noVNC's des.js header carries three license blocks (AT&T, Widget
  // Workshop, and Jef Poskanzer's BSD terms — the last explicitly requires
  // its notice to accompany binary redistribution). Every copyright line in
  // that header must appear in the notices, and every holder in the banner.
  const desHeader = read('node_modules/@novnc/novnc/core/crypto/des.js').slice(0, 4000);
  const copyrightLines = [...desHeader.matchAll(/Copyright \([Cc]\) \d{4}[^\n]*/g)].map((m) =>
    squash(m[0].replace(/\s*\*\s*$/, ''))
  );
  ok(
    copyrightLines.length >= 3,
    `des.js header lists at least three copyright lines (found ${copyrightLines.length})`
  );
  for (const line of copyrightLines) {
    ok(notices.includes(line), `notices carry the des.js copyright line: ${line}`);
  }
  for (const holder of ['Widget Workshop', 'AT&T Laboratories', 'Jef Poskanzer']) {
    ok(banners.includes(holder), `webview banner names the DES holder: ${holder}`);
  }

  // Banner copyright lines for the other bundled projects.
  for (const holder of ['Vitaly Puzrin', 'Matt DesLauriers', 'The noVNC authors']) {
    ok(banners.includes(holder), `webview banner names: ${holder}`);
  }
  for (const holder of ['Einar Otto Stangvik', 'Arnout Kazemier', 'Luigi Pinca']) {
    ok(banners.includes(holder), `ws banner names: ${holder}`);
  }

  // The notices' MPL pointer must reference a file that actually exists in
  // the installed package (LICENSE.txt does NOT contain the MPL text).
  ok(
    notices.includes('docs/LICENSE.MPL-2.0'),
    'notices point at the file that really holds the MPL text'
  );
  ok(
    read('node_modules/@novnc/novnc/docs/LICENSE.MPL-2.0').includes('Mozilla Public License Version 2.0'),
    'the referenced MPL file exists and holds the license'
  );
}
