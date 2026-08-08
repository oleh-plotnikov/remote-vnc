import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { captureFilename, screenshotFilename, pngBytesFromDataUrl, pngSize, expandHome } =
    await load('screenshot.ts');

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

  // pngSize: the magic-byte half that pngBytesFromDataUrl deliberately does
  // not do. The fixture builds a real signature and IHDR so each field can be
  // corrupted one at a time.
  const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const header = (o = {}) => {
    const {
      sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      len = 13,
      type = [0x49, 0x48, 0x44, 0x52],
      w = 480,
      h = 272,
    } = o;
    // Trailing five bytes: bit depth, colour type, compression, filter, interlace.
    return Uint8Array.from([...sig, ...be32(len), ...type, ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
  };

  eq(pngSize(header()), { width: 480, height: 272 }, 'signature + IHDR read');
  eq(pngSize(header({ w: 1920, h: 1080 })), { width: 1920, height: 1080 }, 'a larger source');
  eq(pngSize(header({ w: 32768, h: 32768 })), { width: 32768, height: 32768 }, 'the bound itself');
  eq(pngSize(bytes), undefined, 'the four-byte fixture above is only half a signature');
  eq(pngSize(header().slice(0, 20)), undefined, 'header truncated before the height rejected');
  eq(pngSize(header().slice(0, 8)), undefined, 'a bare signature with no IHDR rejected');
  eq(pngSize(header({ sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b] })), undefined,
    'one wrong signature byte rejected');
  eq(pngSize(header({ type: [0x49, 0x45, 0x4e, 0x44] })), undefined, 'IEND where IHDR belongs');
  eq(pngSize(header({ len: 12 })), undefined, 'IHDR length other than 13 rejected');
  eq(pngSize(header({ w: 0 })), undefined, 'zero width rejected');
  eq(pngSize(header({ h: 0 })), undefined, 'zero height rejected');
  eq(pngSize(header({ w: 32769 })), undefined, 'oversized width rejected');
  eq(pngSize(header({ h: 0xffffffff })), undefined, 'a height that overflows a signed shift');

  // captureFilename generalises the screenshot name to any extension; the
  // png case must keep producing exactly the names screenshots always had.
  eq(captureFilename('hmi', at, 'webm'), 'hmi-20260803-181530.webm', 'webm extension');
  eq(captureFilename('hmi', at, 'gif'), 'hmi-20260803-181530.gif', 'gif extension');
  eq(captureFilename('hmi', at, 'png'), screenshotFilename('hmi', at), 'png case matches screenshots');
  eq(captureFilename('a b/c:d', at, 'gif'), 'a-b-c-d-20260803-181530.gif', 'sanitising applies');

  // Home expansion: only a leading whole-segment tilde.
  eq(expandHome('~', '/home/u'), '/home/u', 'bare tilde');
  eq(expandHome('~/shots', '/home/u'), '/home/u/shots', 'tilde-slash');
  eq(expandHome('/data/~x', '/home/u'), '/data/~x', 'mid-path tilde untouched');
  eq(expandHome('~user/shots', '/home/u'), '~user/shots', '~user form untouched');
}
