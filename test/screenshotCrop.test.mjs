import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const {
    MAX_CROP_DATAURL_CHARS,
    clampCropRect,
    acceptCrop,
    rectFromDrag,
    toImagePoint,
    fitScale,
    stagedName,
    isStagedPath,
    bytesEqual,
  } = await load('screenshotCrop.ts');

  // clampCropRect: whole pixels, inside the image, and idempotent — acceptCrop
  // re-clamps a rect the webview already clamped, so a second pass that moved
  // an edge by one pixel would refuse every honest crop.
  const rect = clampCropRect({ x: 12.6, y: 8.2, width: 100.4, height: 50.5 }, 1920, 1080);
  eq(rect, { x: 12, y: 8, width: 100, height: 51 }, 'the origin floors and the extent rounds');
  eq(clampCropRect(rect, 1920, 1080), rect, 'clamping an already-clamped rect changes nothing');
  const corner = clampCropRect({ x: 90.9, y: 90.9, width: 999, height: 999 }, 100, 100);
  eq(corner, { x: 90, y: 90, width: 10, height: 10 }, 'the extent stops at the far corner');
  eq(clampCropRect(corner, 100, 100), corner, 'idempotent against the edges too');
  eq(
    clampCropRect({ x: 0, y: 0, width: 9999, height: 9999 }, 100, 100),
    { x: 0, y: 0, width: 100, height: 100 },
    'a rect claiming more than the image clamps to the image'
  );
  eq(clampCropRect({ x: 0, y: 0, width: 0.4, height: 10 }, 100, 100), undefined,
    'a width that rounds to zero is not a selection');
  eq(clampCropRect({ x: 0, y: 0, width: NaN, height: 10 }, 100, 100), undefined, 'NaN rejected');
  eq(clampCropRect({ x: '0', y: 0, width: 10, height: 10 }, 100, 100), undefined,
    'a numeric string is not a number');
  eq(clampCropRect(undefined, 100, 100), undefined, 'an absent message field rejected');
  eq(clampCropRect({ x: 0, y: 0, width: 10, height: 10 }, 0, 100), undefined,
    'an image with no width rejected');

  // acceptCrop: the whole trust decision. The webview has already cut the
  // pixels, so the rect that arrives with them is a claim to check, never an
  // instruction to follow.
  eq(
    acceptCrop({ x: 10, y: 10, width: 40, height: 30 }, 100, 100, 40, 30),
    { x: 10, y: 10, width: 40, height: 30 },
    'an image measuring exactly the claim is accepted'
  );
  eq(acceptCrop({ x: 10, y: 10, width: 40, height: 30 }, 100, 100, 100, 100), undefined,
    'a full-resolution image claiming a small selection refused');
  eq(acceptCrop({ x: 10, y: 10, width: 40, height: 30 }, 100, 100, 40, 29), undefined,
    'one pixel of height mismatch refused');
  eq(acceptCrop({ x: 0, y: 0, width: 9999, height: 9999 }, 100, 100, 9999, 9999), undefined,
    'the clamped rect, not the claimed one, is what the image must match');
  eq(acceptCrop(undefined, 100, 100, 40, 30), undefined, 'no rect, no crop');

  // rectFromDrag: which corner the drag started from must not matter, and a
  // drag beginning off the image selects from the edge instead of keeping its
  // width and sliding inwards.
  const drag = rectFromDrag({ x: 10, y: 20 }, { x: 60, y: 80 }, 100, 100);
  eq(drag, { x: 10, y: 20, width: 50, height: 60 }, 'a down-and-right drag');
  eq(rectFromDrag({ x: 60, y: 80 }, { x: 10, y: 20 }, 100, 100), drag,
    'the same drag up-and-left is the same rectangle');
  eq(
    rectFromDrag({ x: -50, y: -50 }, { x: 10, y: 10 }, 100, 100),
    { x: 0, y: 0, width: 10, height: 10 },
    'a drag starting outside selects from the edge'
  );
  eq(
    rectFromDrag({ x: 90, y: 90 }, { x: 500, y: 500 }, 100, 100),
    { x: 90, y: 90, width: 10, height: 10 },
    'a drag ending outside stops at the far corner'
  );
  eq(rectFromDrag({ x: 10, y: 10 }, { x: 10, y: 10 }, 100, 100), undefined,
    'a click is not a selection');
  eq(rectFromDrag({ x: 10, y: 10 }, { x: NaN, y: 40 }, 100, 100), undefined,
    'a non-finite pointer coordinate rejected');

  // Resizing from a west or north handle anchors the opposite edge, and a
  // sub-pixel pointer must not drag that edge along with it. Both corners are
  // rounded before the rectangle is spanned; letting the origin floor while the
  // extent rounds made the anchored edge toggle every half pixel — visible as a
  // 1px shimmer on the far side of the selection while resizing.
  const eastEdge = (px) => {
    const r = rectFromDrag({ x: 200, y: 100 }, { x: px, y: 200 }, 400, 400);
    return r.x + r.width;
  };
  eq(
    [eastEdge(100), eastEdge(100.4), eastEdge(100.6), eastEdge(101), eastEdge(101.6)],
    [200, 200, 200, 200, 200],
    'a west-handle resize leaves the anchored east edge alone'
  );
  const southEdge = (py) => {
    const r = rectFromDrag({ x: 100, y: 200 }, { x: 200, y: py }, 400, 400);
    return r.y + r.height;
  };
  eq(
    [southEdge(90), southEdge(90.4), southEdge(90.6), southEdge(91.6)],
    [200, 200, 200, 200],
    'a north-handle resize leaves the anchored south edge alone'
  );
  // Rounding, not flooring. Flooring the corners would anchor the far edge just
  // as well, but it turns every press into a 1x1: `Math.floor` maps 10.2 and
  // 10.4 to 10 and 11 only because the extent is taken afterwards. Rounding
  // keeps a press a press and a movement that never crosses a pixel boundary a
  // click — which is what the "a click is not a selection" rule above means at
  // a scale where one image pixel is several CSS pixels wide.
  eq(rectFromDrag({ x: 10.4, y: 10.4 }, { x: 10.4, y: 10.4 }, 100, 100), undefined,
    'a press at fractional coordinates is not a selection');
  eq(rectFromDrag({ x: 10.2, y: 10.2 }, { x: 10.4, y: 10.4 }, 100, 100), undefined,
    'a drag that never crosses a pixel boundary is not a selection');
  eq(
    rectFromDrag({ x: 10.2, y: 10.2 }, { x: 10.8, y: 10.8 }, 100, 100),
    { x: 10, y: 10, width: 1, height: 1 },
    'a drag that does cross one selects that pixel'
  );

  // toImagePoint: CSS px -> image px at the current fit scale, never through
  // devicePixelRatio. The clamp is inclusive because a point is a corner, not
  // a pixel — otherwise the last column and row are unselectable.
  eq(toImagePoint(960, 544, 2, 480, 272), { x: 480, y: 272 }, 'the bottom-right corner is reachable');
  eq(toImagePoint(5000, 5000, 2, 480, 272), { x: 480, y: 272 }, 'past the corner clamps to it');
  eq(toImagePoint(-30, -30, 2, 480, 272), { x: 0, y: 0 }, 'dragged off the top-left clamps to the origin');
  eq(toImagePoint(100, 100, 0.5, 480, 272), { x: 200, y: 200 }, 'below 100 % one CSS px is two image px');
  eq(toImagePoint(100, 100, 0, 480, 272), { x: 100, y: 100 }, 'a zero scale falls back to 1:1, not Infinity');

  // fitScale: upscaling is the point — the motivating hardware is a 480x272
  // panel — and a tab measured mid-layout must not poison every coordinate
  // downstream with NaN.
  eq(fitScale(1920, 1080, 960, 540), 0.5, 'a large image fits by half');
  eq(fitScale(480, 272, 1920, 1088), 4, 'a small panel is upscaled on purpose');
  eq(fitScale(1920, 1080, 1920, 200), 200 / 1080, 'the tighter axis wins');
  eq(fitScale(480, 272, 0, 0), 1, 'a 0x0 box yields 1, not NaN');
  eq(fitScale(480, 272, NaN, 100), 1, 'NaN in, 1 out');

  // stagedName: capture names are second-resolution, so two screenshots inside
  // one second would otherwise reuse a name and overwrite the file an open
  // crop tab is still showing.
  eq(stagedName('hmi-20260803-181530.png', []), 'hmi-20260803-181530.png', 'a free name is taken as is');
  eq(stagedName('shot.png', ['shot.png']), 'shot-2.png', 'the suffix goes before the extension');
  eq(stagedName('shot.png', ['shot.png', 'shot-2.png', 'shot-3.png']), 'shot-4.png',
    'a collision chain keeps counting');
  eq(stagedName('shot.png', ['shot.png', 'shot-3.png']), 'shot-2.png',
    'the first free number wins, not the one after the highest');
  eq(stagedName('capture.tar.gz', ['capture.tar.gz']), 'capture.tar-2.gz', 'only the last dot is an extension');
  eq(stagedName('README', ['README']), 'README-2', 'a name with no extension');
  eq(stagedName('shot.png', ['SHOT.PNG']), 'shot.png', 'the comparison is case-sensitive');

  // isStagedPath: this one predicate decides both silent overwrite and the
  // save dialog's default directory, so near-misses have to be refused.
  const dir = 'file:///storage/recordings';
  ok(isStagedPath(`${dir}/shot.png`, dir), 'a file directly in staging is staged');
  ok(isStagedPath(`${dir}/shot.png`, `${dir}/`), 'a staging dir already ending in a slash');
  ok(!isStagedPath('file:///storage/recordings-evil/shot.png', dir), 'a sibling directory is not staging');
  ok(!isStagedPath(`${dir}/sub/shot.png`, dir), 'a nested path is not directly in staging');
  ok(!isStagedPath(dir, dir), 'the directory itself is not a file inside it');

  // bytesEqual: the stale-source check that runs before an in-place overwrite.
  const bytes = Uint8Array.from([1, 2, 3]);
  ok(bytesEqual(bytes, Uint8Array.from([1, 2, 3])), 'equal contents');
  ok(!bytesEqual(bytes, Uint8Array.from([1, 2, 3, 4])), 'differing lengths are not equal');
  ok(!bytesEqual(bytes, Uint8Array.from([1, 2, 4])), 'one differing byte');
  ok(!bytesEqual(bytes, undefined), 'a missing side is never equal, so the write is refused');

  // The length cap runs before Buffer.from, so it has to admit the largest
  // honest payload: a lossless PNG of a 4K framebuffer, base64 inflated.
  ok(MAX_CROP_DATAURL_CHARS > (3840 * 2160 * 4 * 4) / 3, 'admits a worst-case 4K capture');
  ok(MAX_CROP_DATAURL_CHARS < 512 * 1024 * 1024, 'still a bound, not a formality');
}
