import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { cropLayout, parseVisibleArea } = await load('cropLayout.ts');

  // The motivating case: a 480x272 panel advertised as 512x272, shown in a
  // 960x544 tab. The crop fills the box exactly; the inner container carries
  // the padded framebuffer so its right edge overflows the clip box.
  let l = cropLayout(512, 272, 480, 272, 960, 544, true);
  eq(l.scale, 2, 'width-padded fb: scale from the crop, not the framebuffer');
  eq([l.clipWidth, l.clipHeight], [960, 544], 'clip box fills the tab');
  eq([l.innerWidth, l.innerHeight], [1024, 544], 'inner carries the padded width');
  ok(l.innerWidth > l.clipWidth, 'the dead band overflows the clip box');

  // Height-bound tab: the smaller ratio wins, as with plain scale-to-fit.
  l = cropLayout(512, 272, 480, 272, 4800, 272, true);
  eq(l.scale, 1, 'height-bound box picks the smaller ratio');
  eq(l.clipWidth, 480, 'clip width follows the crop at that scale');

  // scaleViewport off → 1:1 window onto the visible area.
  l = cropLayout(512, 272, 480, 272, 100, 100, false);
  eq(l.scale, 1, 'no scale-to-fit renders 1:1');
  eq([l.clipWidth, l.clipHeight, l.innerWidth, l.innerHeight], [480, 272, 512, 272], '1:1 sizes');

  // A stale crop larger than the framebuffer clamps to reality.
  l = cropLayout(512, 272, 9999, 9999, 512, 272, true);
  eq([l.clipWidth, l.clipHeight], [512, 272], 'crop clamps to the framebuffer');

  // Degenerate inputs refuse instead of dividing by zero.
  eq(cropLayout(0, 272, 480, 272, 960, 544, true), undefined, 'zero fb width refused');
  eq(cropLayout(512, 272, 480, 272, 0, 544, true), undefined, 'zero box refused');

  // parseVisibleArea: the "WxH" forms users will actually type.
  eq(parseVisibleArea('480x272'), { width: 480, height: 272 }, 'plain WxH');
  eq(parseVisibleArea(' 480 × 272 '), { width: 480, height: 272 }, 'unicode × and spaces');
  eq(parseVisibleArea('480'), undefined, 'missing height rejected');
  eq(parseVisibleArea('0x272'), undefined, 'zero width rejected');
  eq(parseVisibleArea('99999x272'), undefined, 'out-of-range width rejected');
  eq(parseVisibleArea(undefined), undefined, 'absent setting rejected');
  eq(parseVisibleArea('4 8 0x272'), undefined, 'garbage rejected');
}
