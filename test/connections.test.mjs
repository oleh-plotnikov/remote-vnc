import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const {
    collectConnections,
    isValidPort,
    secretKeyFor,
    effectiveAutoReconnect,
    applyConnectionEdit,
    toConnectionEntry,
  } = await load('connections.ts');
  const G = 1, W = 2; // ConfigurationTarget.Global / Workspace (from the stub)

  // isValidPort
  ok(isValidPort(undefined), 'undefined port is valid');
  ok(isValidPort(5900), '5900 is valid');
  ok(!isValidPort(0), '0 is invalid');
  ok(!isValidPort(70000), '70000 is invalid');
  ok(!isValidPort(5901.5), 'non-integer is invalid');

  // secretKeyFor is host-scoped
  eq(secretKeyFor({ name: 'p', host: 'h', port: 5901 }), 'remoteVnc:p@h:5901', 'secret key includes host:port');
  eq(secretKeyFor({ name: 'p', host: 'h' }), 'remoteVnc:p@h:5900', 'secret key defaults port to 5900');

  // empty
  eq(collectConnections(undefined, true), [], 'no config → empty');

  // scope tagging + global only when untrusted
  const inspect = {
    globalValue: [{ name: 'g', host: 'gh' }],
    workspaceValue: [{ name: 'w', host: 'wh', port: 5901 }],
  };
  const trusted = collectConnections(inspect, true);
  eq(trusted.map((c) => [c.name, c.scope]).sort(), [['g', G], ['w', W]], 'trusted shows both with scope tags');
  const untrusted = collectConnections(inspect, false);
  eq(untrusted.map((c) => c.name), ['g'], 'untrusted hides workspace entries');

  // global wins a name collision
  const collide = {
    globalValue: [{ name: 'dup', host: 'global-host' }],
    workspaceValue: [{ name: 'dup', host: 'attacker-host' }],
  };
  const merged = collectConnections(collide, true);
  eq(merged.length, 1, 'collision deduped to one');
  eq([merged[0].host, merged[0].scope], ['global-host', G], 'global wins the collision');

  // invalid entries skipped
  const bad = { globalValue: [{ name: 'ok', host: 'h' }, { name: 'badport', host: 'h', port: 70000 }, { host: 'noname' }] };
  eq(collectConnections(bad, true).map((c) => c.name), ['ok'], 'invalid entries skipped');

  // autoReconnect is carried through
  const withFlag = collectConnections({ globalValue: [{ name: 'ar', host: 'h', autoReconnect: true }] }, true);
  eq(withFlag[0].autoReconnect, true, 'autoReconnect carried through');
  const noFlag = collectConnections({ globalValue: [{ name: 'n', host: 'h' }] }, true);
  eq(noFlag[0].autoReconnect, undefined, 'absent autoReconnect stays undefined');

  // forceRawEncoding is carried through
  const raw = collectConnections({ globalValue: [{ name: 'r', host: 'h', forceRawEncoding: true }] }, true);
  eq(raw[0].forceRawEncoding, true, 'forceRawEncoding carried through');

  // parkServerCursor is carried through (dropping it here would silently
  // disable per-connection cursor parking)
  const park = collectConnections({ globalValue: [{ name: 'p2', host: 'h', parkServerCursor: true }] }, true);
  eq(park[0].parkServerCursor, true, 'parkServerCursor carried through');
  eq(raw[0].parkServerCursor, undefined, 'absent parkServerCursor stays undefined');

  // visibleArea is carried through as the raw string (parsed at connect time)
  const area = collectConnections({ globalValue: [{ name: 'v', host: 'h', visibleArea: '480x272' }] }, true);
  eq(area[0].visibleArea, '480x272', 'visibleArea carried through');

  // effectiveAutoReconnect: per-connection value wins; absent → global default.
  // Entries saved before the field existed (≤0.1.0) have no value and must
  // inherit the default instead of silently never reconnecting.
  eq(effectiveAutoReconnect(undefined, true), true, 'legacy entry inherits default-on');
  eq(effectiveAutoReconnect(undefined, false), false, 'legacy entry inherits default-off');
  eq(effectiveAutoReconnect(false, true), false, 'explicit per-connection No beats default-on');
  eq(effectiveAutoReconnect(true, false), true, 'explicit per-connection Yes beats default-off');

  // applyConnectionEdit: a wizard patch must not delete fields the wizard
  // never asked about. Editing a connection used to rewrite the record from a
  // literal, which silently dropped visibleArea and parkServerCursor.
  const saved = {
    name: 'hmi',
    host: '10.0.0.5',
    port: 5900,
    visibleArea: '480x272',
    parkServerCursor: true,
    scope: G,
  };
  const renamed = applyConnectionEdit(saved, { name: 'panel', host: '10.0.0.6' });
  eq(renamed.visibleArea, '480x272', 'untouched visibleArea survives an edit');
  eq(renamed.parkServerCursor, true, 'untouched parkServerCursor survives an edit');
  eq(renamed.name, 'panel', 'the patch wins for fields it names');
  eq(renamed.host, '10.0.0.6', 'the patch wins for host too');
  eq(renamed.scope, undefined, 'scope never reaches the written record');

  // An explicit undefined clears — this is how "Auto" removes the crop.
  const cleared = applyConnectionEdit(saved, { visibleArea: undefined });
  eq('visibleArea' in cleared, false, 'an explicit undefined removes the key');
  eq(cleared.parkServerCursor, true, 'clearing one field leaves the others');

  // No base: creating a connection yields exactly the patch.
  const created = applyConnectionEdit(undefined, { name: 'n', host: 'h' });
  eq(created, { name: 'n', host: 'h' }, 'no base yields exactly the patch');

  // A base value that is already undefined does not appear as a key.
  const sparse = applyConnectionEdit({ name: 'n', host: 'h', port: undefined }, {});
  eq('port' in sparse, false, 'an undefined base field is not written');

  // toConnectionEntry is the single producer of entries: the layered reader
  // above and the edit menu's single-scope re-read both go through it, so the
  // menu can never merge onto a record collectConnections would have rejected.
  eq(toConnectionEntry(undefined, G), undefined, 'a missing record yields no entry');
  eq(toConnectionEntry({ host: 'h' }, G), undefined, 'a nameless record yields no entry');
  eq(toConnectionEntry({ name: 'n', host: 'h', port: 70000 }, G), undefined, 'a bad port yields no entry');
  eq(toConnectionEntry({ name: 'n', host: 'h' }, W), { name: 'n', host: 'h', scope: W }, 'a valid record is scope-tagged');

  // The entry is spread from the stored record, not rebuilt from a literal of
  // known keys — so a field this version does not know about survives a round
  // trip through the editor instead of being silently dropped on the next save.
  const stored = { name: 'hmi', host: '10.0.0.5', visibleArea: '480x272', futureField: 'keep me' };
  const entry = toConnectionEntry(stored, G);
  eq(entry.futureField, 'keep me', 'an unknown field survives the read');
  const roundTripped = applyConnectionEdit(entry, { host: '10.0.0.6' });
  eq(
    roundTripped,
    { name: 'hmi', host: '10.0.0.6', visibleArea: '480x272', futureField: 'keep me' },
    'an unknown field survives read → edit → write, and scope does not'
  );
}
