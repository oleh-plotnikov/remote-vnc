import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default async function ({ ok, eq }) {
  const {
    collectConnections,
    isValidPort,
    secretKeyFor,
    secretMigration,
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

  // secretKeyFor is scoped by name AND host:port — all three, which is why the
  // migration below has to exist at all.
  eq(secretKeyFor({ name: 'p', host: 'h', port: 5901 }), 'remoteVnc:p@h:5901', 'secret key includes host:port');
  eq(secretKeyFor({ name: 'p', host: 'h' }), 'remoteVnc:p@h:5900', 'secret key defaults port to 5900');

  // --- renaming must carry the password with it -----------------------------
  // Every delete path computes the key from the CURRENT entry, so a password
  // stored under the old key becomes unreachable the moment any of the three
  // fields changes: the connection stops offering it, "Forget Password" cannot
  // see it, and deleting the entry leaves it in the OS keyring for good.
  {
    const before = { name: 'mac', host: 'h', port: 5900 };
    eq(secretMigration(before, { ...before }), undefined, 'an edit that changes nothing moves nothing');
    eq(
      secretMigration(before, { ...before, autoReconnect: true }),
      undefined,
      'an edit to a field outside the key moves nothing either'
    );
    eq(
      secretMigration(before, { ...before, name: 'macbook' }),
      { from: 'remoteVnc:mac@h:5900', to: 'remoteVnc:macbook@h:5900' },
      'a rename moves the password to the new key'
    );
    eq(
      secretMigration(before, { ...before, host: 'h2' }),
      { from: 'remoteVnc:mac@h:5900', to: 'remoteVnc:mac@h2:5900' },
      'so does a change of host'
    );
    eq(
      secretMigration(before, { name: 'mac', host: 'h', port: 5901 }),
      { from: 'remoteVnc:mac@h:5900', to: 'remoteVnc:mac@h:5901' },
      'and of port'
    );
    // The default-port case is the one a naive implementation gets wrong:
    // undefined and 5900 are the same address, so this is not a move.
    eq(
      secretMigration({ name: 'mac', host: 'h' }, { name: 'mac', host: 'h', port: 5900 }),
      undefined,
      'an omitted port and an explicit 5900 are the same key, so nothing moves'
    );

    // And the wiring. editConnection drives a QuickPick, so it is not reachable
    // from a test; what is reachable is whether it calls the seam at all, and
    // in which ORDER — storing under the new key before deleting the old one is
    // what makes a failure between the two leave a duplicate password rather
    // than none at all.
    const ext = readFileSync(join(ROOT, 'src/extension.ts'), 'utf8');
    ok(/secretMigration\(/.test(ext), 'the edit path asks whether the key moved');
    const store = ext.indexOf('secrets.store(move.to');
    const drop = ext.indexOf('secrets.delete(move.from');
    ok(store !== -1 && drop !== -1, 'and both halves of the move are there');
    ok(store < drop, 'the new key is written before the old one is deleted, never the other way round');
  }

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

  // username rides the same generic merge as every other field — it is spread,
  // not named in a literal, so it must survive an unrelated edit and clear on
  // an explicit undefined. A Mac target needs it (macOS offers Apple ARD ahead
  // of VNC Auth, and ARD asks for an account name as well as a password), so
  // losing it silently would look like a rejected password.
  const withUser = { name: 'mac', host: '127.0.0.1', username: 'oleh', scope: G };
  const userKept = applyConnectionEdit(withUser, { host: '127.0.0.2' });
  eq(userKept.username, 'oleh', 'untouched username survives an edit');
  const userCleared = applyConnectionEdit(withUser, { username: undefined });
  eq('username' in userCleared, false, 'an explicit undefined removes the username');
  eq(userCleared.host, '127.0.0.1', 'clearing the username leaves the rest');

  // Adding a field to the schema must not change how a password is keyed:
  // existing users would be re-prompted for every saved connection.
  eq(
    secretKeyFor({ name: 'mac', host: '127.0.0.1', port: 5900 }),
    'remoteVnc:mac@127.0.0.1:5900',
    'the secret key ignores username'
  );

  // No base: creating a connection yields exactly the patch.
  const created = applyConnectionEdit(undefined, { name: 'n', host: 'h' });
  eq(created, { name: 'n', host: 'h' }, 'no base yields exactly the patch');

  // A base value that is already undefined does not appear as a key.
  const sparse = applyConnectionEdit({ name: 'n', host: 'h', port: undefined }, {});
  eq('port' in sparse, false, 'an undefined base field is not written');

  // toConnectionEntry is the single producer of entries: the layered reader
  // above and the edit menu's single-scope re-read both go through it, so the
  // menu can never merge onto a record collectConnections would have rejected.
  eq(toConnectionEntry(undefined, G, true), undefined, 'a missing record yields no entry');
  eq(toConnectionEntry({ host: 'h' }, G, true), undefined, 'a nameless record yields no entry');
  eq(toConnectionEntry({ name: 'n', host: 'h', port: 70000 }, G, true), undefined, 'a bad port yields no entry');
  eq(
    toConnectionEntry({ name: 'n', host: 'h' }, W, true),
    { name: 'n', host: 'h', use: { preUseTimeoutMs: 60000 }, scope: W },
    'a valid record is scope-tagged and carries resolved use-commands'
  );

  // The entry is spread from the stored record, not rebuilt from a literal of
  // known keys — so a field this version does not know about survives a round
  // trip through the editor instead of being silently dropped on the next save.
  const stored = { name: 'hmi', host: '10.0.0.5', visibleArea: '480x272', futureField: 'keep me' };
  const entry = toConnectionEntry(stored, G, true);
  eq(entry.futureField, 'keep me', 'an unknown field survives the read');
  const roundTripped = applyConnectionEdit(entry, { host: '10.0.0.6' });
  eq(
    roundTripped,
    { name: 'hmi', host: '10.0.0.6', visibleArea: '480x272', futureField: 'keep me' },
    'an unknown field survives read → edit → write, and scope does not'
  );

  // scaleViewport follows the same merge rules as every other optional field.
  const scaled = applyConnectionEdit(
    { name: 'n', host: 'h', scaleViewport: false },
    { host: 'h2' }
  );
  eq(scaled.scaleViewport, false, 'scaleViewport survives an unrelated edit');
  const clearedScaleViewport = applyConnectionEdit(
    { name: 'n', host: 'h', scaleViewport: false },
    { scaleViewport: undefined }
  );
  eq('scaleViewport' in clearedScaleViewport, false, 'explicit undefined clears scaleViewport');

  // --- pre/post-use commands and the trust gate ------------------------------
  // toConnectionEntry is where a connection's commands are decided, and it is
  // the ONE place that knows which settings layer the record came from — the
  // only thing distinguishing a command the user wrote from one a cloned
  // repository shipped in a committed .vscode/settings.json.
  const commanded = { name: 'kiosk', host: 'h', preUseCommand: 'up', postUseCommand: 'down', preUseTimeout: 90 };

  const userEntry = toConnectionEntry(commanded, G, false);
  eq(userEntry.use.preUseCommand, 'up', 'a USER-scoped command survives even in an untrusted workspace');
  eq(userEntry.use.preUseTimeoutMs, 90000, 'and its timeout arrives in milliseconds');
  eq(userEntry.preUseCommand, undefined, 'the RAW field is not on the entry — use is the only route to a command');
  eq(userEntry.postUseCommand, undefined, 'nor the raw postUseCommand');

  const trustedWorkspaceEntry = toConnectionEntry(commanded, W, true);
  eq(
    [trustedWorkspaceEntry.use.preUseCommand, trustedWorkspaceEntry.use.postUseCommand],
    ['up', 'down'],
    'a WORKSPACE-scoped command survives in a trusted workspace'
  );

  const untrustedWorkspaceEntry = toConnectionEntry(commanded, W, false);
  eq(
    untrustedWorkspaceEntry.use.preUseCommand,
    undefined,
    'a WORKSPACE-scoped command is dropped in an untrusted workspace — a repo must not choose what runs'
  );
  eq(untrustedWorkspaceEntry.use.postUseCommand, undefined, 'and so is its postUseCommand');
  eq(untrustedWorkspaceEntry.host, 'h', 'while the connection itself is untouched and still connects');

  // The resolved commands must never be written back to settings: doing so in
  // an untrusted workspace would persist the stripped result and erase the
  // user's commands for good, which is why the edit menu merges onto the
  // STORED record rather than onto an entry.
  const savedAfterEdit = applyConnectionEdit(untrustedWorkspaceEntry, { host: 'h2' });
  eq('use' in savedAfterEdit, false, 'the resolved use-commands never reach the saved record');
  eq('scope' in savedAfterEdit, false, 'and neither does scope');
}
