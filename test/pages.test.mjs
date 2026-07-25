import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { collectPages, basePagesFor, isValidPageUrl } = await load('pages.ts');
  const G = 1, W = 2; // ConfigurationTarget.Global / Workspace (from the stub)

  // isValidPageUrl
  ok(isValidPageUrl('http://localhost:8089/ui_kits/kiosk/'), 'http localhost is valid');
  ok(isValidPageUrl('https://example.com/x?y=1'), 'https is valid');
  ok(!isValidPageUrl('file:///etc/passwd'), 'file: is invalid');
  ok(!isValidPageUrl('javascript:alert(1)'), 'javascript: is invalid');
  ok(!isValidPageUrl('localhost:8089'), 'scheme-less is invalid');
  ok(!isValidPageUrl(undefined), 'undefined is invalid');

  // empty
  eq(collectPages(undefined, true), [], 'no config → empty');

  // scope tagging + trust gating
  const inspect = {
    globalValue: [{ name: 'g', url: 'http://gh/' }],
    workspaceValue: [{ name: 'w', url: 'http://wh/' }],
  };
  eq(
    collectPages(inspect, true).map((p) => [p.name, p.scope]).sort(),
    [['g', G], ['w', W]].sort(),
    'trusted → both scopes, tagged'
  );
  eq(
    collectPages(inspect, false).map((p) => p.name),
    ['g'],
    'untrusted → workspace entries dropped'
  );

  // global precedence over same-named workspace entry
  const shadow = {
    globalValue: [{ name: 'same', url: 'http://global/' }],
    workspaceValue: [{ name: 'same', url: 'http://workspace/' }],
  };
  eq(collectPages(shadow, true)[0].url, 'http://global/', 'global wins a name collision');

  // invalid entries skipped
  const dirty = {
    globalValue: [
      { name: 'ok', url: 'http://x/' },
      { name: '', url: 'http://x/' },
      { name: 'bad', url: 'notaurl' },
      { name: 'js', url: 'javascript:alert(1)' },
    ],
  };
  eq(collectPages(dirty, true).map((p) => p.name), ['ok'], 'invalid entries are skipped');

  // write-base per scope
  eq(basePagesFor(inspect, G), [{ name: 'g', url: 'http://gh/' }], 'global base');
  eq(basePagesFor(inspect, W), [{ name: 'w', url: 'http://wh/' }], 'workspace base');
  eq(basePagesFor(undefined, G), [], 'missing inspect → empty base');

  // canvas size: carried only when BOTH dimensions are sane positive ints
  const sized = {
    globalValue: [
      { name: 'fit', url: 'http://x/', width: 1280, height: 800 },
      { name: 'half', url: 'http://x/', width: 1280 },
      { name: 'junk', url: 'http://x/', width: -5, height: 'tall' },
    ],
  };
  const byName = new Map(collectPages(sized, true).map((p) => [p.name, p]));
  eq(
    [byName.get('fit').width, byName.get('fit').height],
    [1280, 800],
    'valid width+height pair is carried'
  );
  eq(byName.get('half').width, undefined, 'a lone dimension is dropped');
  eq(byName.get('junk').width, undefined, 'invalid dimensions are dropped');
}
