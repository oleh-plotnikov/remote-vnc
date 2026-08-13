import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { collectPages, basePagesFor, isValidPageUrl, applyPageEdit } = await load('pages.ts');
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

  // mirror flag: only an exact `true` enables it
  const mirrorInspect = {
    globalValue: [
      { name: 'm', url: 'http://h/', mirror: true },
      { name: 'n', url: 'http://h/', mirror: 'yes' },
      { name: 'o', url: 'http://h/' },
    ],
  };
  const got = collectPages(mirrorInspect, true);
  eq(got.find((p) => p.name === 'm').mirror, true, 'mirror:true survives');
  eq(got.find((p) => p.name === 'n').mirror, undefined, 'non-boolean mirror is dropped');
  eq(got.find((p) => p.name === 'o').mirror, undefined, 'absent mirror stays absent');

  // --- pre/post-use commands -------------------------------------------------
  // These execute arbitrary shell commands, so the ONE thing that must hold at
  // this boundary is that the raw fields do not survive onto the entry: `use`
  // is the trust-gated result, and it has to be the only route to a command.
  // An entry still carrying `preUseCommand` would be one refactor away from
  // running something this build decided to drop.
  const commanded = {
    globalValue: [
      { name: 'kiosk', url: 'http://localhost:8777/', preUseCommand: 'up', postUseCommand: 'down', preUseTimeout: 90 },
    ],
    workspaceValue: [{ name: 'repo', url: 'http://localhost:9000/', preUseCommand: 'wsup' }],
  };
  const withCommands = new Map(collectPages(commanded, true).map((p) => [p.name, p]));
  const kiosk = withCommands.get('kiosk');
  eq(kiosk.use.preUseCommand, 'up', 'a user-scoped preUseCommand reaches the entry as use.preUseCommand');
  eq(kiosk.use.postUseCommand, 'down', 'and so does its postUseCommand');
  eq(kiosk.use.preUseTimeoutMs, 90000, 'and preUseTimeout arrives already converted to milliseconds');
  eq(kiosk.preUseCommand, undefined, 'the RAW preUseCommand is not on the entry — use is the only route to a command');
  eq(kiosk.postUseCommand, undefined, 'nor the raw postUseCommand');
  eq(kiosk.preUseTimeout, undefined, 'nor the raw timeout, which would be in the wrong unit');
  eq(
    withCommands.get('repo').use.preUseCommand,
    'wsup',
    'a workspace-scoped command survives in a TRUSTED workspace — that is the case this feature exists for'
  );
  eq(
    collectPages({ globalValue: [{ name: 'plain', url: 'http://x/' }] }, true)[0].use,
    { preUseTimeoutMs: 60000 },
    'a page with no commands still carries a usable default timeout and nothing else'
  );

  // --- editing a page must not delete what the wizard did not ask about ------
  // The page editor rebuilt the record from a literal of the three fields it
  // prompts for, which silently dropped `mirror`; with commands in the schema
  // it would drop those too — and those are fields the user had to be trusted
  // to set in the first place.
  const edited = applyPageEdit(
    { name: 'kiosk', url: 'http://a/', mirror: true, preUseCommand: 'up', width: 800, height: 600 },
    { name: 'kiosk', url: 'http://b/', width: undefined, height: undefined }
  );
  eq(edited.url, 'http://b/', 'the patch wins for the fields it carries');
  eq(edited.mirror, true, 'mirror survives an edit that never asked about it');
  eq(edited.preUseCommand, 'up', 'and so does preUseCommand');
  eq('width' in edited, false, 'an explicit undefined clears the field rather than writing a null');
  eq(
    applyPageEdit(undefined, { name: 'n', url: 'http://x/' }),
    { name: 'n', url: 'http://x/' },
    'a page created from nothing is just the patch'
  );

  // The two fields that describe an entry rather than belong to it. `use` is
  // the trust-RESOLVED commands: writing it back would persist a trust decision
  // into settings, so editing a page in an untrusted workspace would erase the
  // very commands it was only supposed to ignore. `scope` would land in
  // settings.json as a stray number. `editPage` merges onto the stored record
  // and so passes neither today — this is what keeps that true of the next
  // caller, and it is the strip applyConnectionEdit already has.
  const fromEntry = applyPageEdit(
    { name: 'kiosk', url: 'http://a/', scope: 2, use: { preUseCommand: 'up', preUseTimeoutMs: 60000 } },
    { name: 'kiosk', url: 'http://b/' }
  );
  eq('use' in fromEntry, false, 'the resolved use-commands never reach the saved page record');
  eq('scope' in fromEntry, false, 'and neither does scope');
  eq(fromEntry.url, 'http://b/', 'while the fields that ARE part of the stored shape still merge');
}
