import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { collectConnections, isValidPort, secretKeyFor, effectiveAutoReconnect } = await load('connections.ts');
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

  // effectiveAutoReconnect: per-connection value wins; absent → global default.
  // Entries saved before the field existed (≤0.1.0) have no value and must
  // inherit the default instead of silently never reconnecting.
  eq(effectiveAutoReconnect(undefined, true), true, 'legacy entry inherits default-on');
  eq(effectiveAutoReconnect(undefined, false), false, 'legacy entry inherits default-off');
  eq(effectiveAutoReconnect(false, true), false, 'explicit per-connection No beats default-on');
  eq(effectiveAutoReconnect(true, false), true, 'explicit per-connection Yes beats default-off');
}
