import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { screenshotFilename, pngBytesFromDataUrl, expandHome } = await load('screenshot.ts');

  // Filenames: label + timestamp only (no product prefix), filesystem-safe,
  // unicode labels kept.
  const at = new Date(2026, 7, 3, 18, 15, 30); // months are 0-based → August
  eq(screenshotFilename('hmi', at), 'hmi-20260803-181530.png', 'plain label');
  eq(screenshotFilename('панель', at), 'панель-20260803-181530.png', 'unicode label survives');
  eq(screenshotFilename('a b/c:d', at), 'a-b-c-d-20260803-181530.png', 'separators collapse to dashes');
  eq(screenshotFilename('///', at), 'session-20260803-181530.png', 'empty-after-sanitising falls back');
  ok(!screenshotFilename('..', at).includes('..'), 'dot-dot cannot survive into a name');
  ok(screenshotFilename('x'.repeat(200), at).length < 100, 'long labels are truncated');

  // PNG decoding: strict prefix and charset, round-trips bytes.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const url = `data:image/png;base64,${bytes.toString('base64')}`;
  eq(Array.from(pngBytesFromDataUrl(url)), Array.from(bytes), 'base64 payload round-trips');
  eq(pngBytesFromDataUrl('data:image/jpeg;base64,AAAA'), undefined, 'non-PNG data URL rejected');
  eq(pngBytesFromDataUrl('data:image/png;base64,'), undefined, 'empty payload rejected');
  eq(pngBytesFromDataUrl('data:image/png;base64,not*valid!'), undefined, 'invalid base64 rejected');
  eq(pngBytesFromDataUrl('AAAA'), undefined, 'bare base64 without prefix rejected');

  // Home expansion: only a leading whole-segment tilde.
  eq(expandHome('~', '/home/u'), '/home/u', 'bare tilde');
  eq(expandHome('~/shots', '/home/u'), '/home/u/shots', 'tilde-slash');
  eq(expandHome('/data/~x', '/home/u'), '/data/~x', 'mid-path tilde untouched');
  eq(expandHome('~user/shots', '/home/u'), '~user/shots', '~user form untouched');
}
