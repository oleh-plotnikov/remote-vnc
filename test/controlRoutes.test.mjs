import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { parseControlRoute, tokenOk, controlErrorStatus, endpointFileName } =
    await load('controlRoutes.ts');

  eq(parseControlRoute('GET', '/targets'), { kind: 'list' }, 'list route');
  eq(parseControlRoute('POST', '/targets/abc/screenshot'), { kind: 'screenshot', id: 'abc' }, 'screenshot route');
  eq(parseControlRoute('POST', '/targets/abc/record'), { kind: 'record', id: 'abc' }, 'record route');
  eq(parseControlRoute('POST', '/targets/abc/record/stop'), { kind: 'recordStop', id: 'abc' }, 'record stop route');
  eq(parseControlRoute('POST', '/targets/abc/reload'), { kind: 'reload', id: 'abc' }, 'reload route');

  // method matters
  eq(parseControlRoute('GET', '/targets/abc/screenshot'), undefined, 'GET on a POST route is rejected');
  eq(parseControlRoute('POST', '/targets'), undefined, 'POST on the list route is rejected');

  // nothing else is routable
  eq(parseControlRoute('POST', '/targets/abc/click'), undefined, 'input routes do not exist');
  eq(parseControlRoute('GET', '/'), undefined, 'root is not routable');
  eq(parseControlRoute('GET', '/../etc/passwd'), undefined, 'traversal is not routable');

  // ids are opaque but bounded
  eq(parseControlRoute('POST', '/targets//screenshot'), undefined, 'empty id rejected');

  // token check
  ok(tokenOk('a'.repeat(48), 'a'.repeat(48)), 'equal tokens pass');
  ok(!tokenOk('a'.repeat(48), 'b'.repeat(48)), 'different tokens fail');
  ok(!tokenOk('short', 'a'.repeat(48)), 'length mismatch fails');
  ok(!tokenOk(undefined, 'a'.repeat(48)), 'missing token fails');
  ok(!tokenOk(null, 'a'.repeat(48)), 'null token fails');
  // Node decodes header values as latin1, so a header of 48 raw 0xFF bytes
  // arrives as a 48-CHARACTER string that is 96 BYTES in UTF-8. Comparing
  // String#length (UTF-16 units) and then handing the buffers to
  // timingSafeEqual (bytes) let that pass the length gate and throw a
  // RangeError out of the request handler, before any route was matched.
  ok(!tokenOk('\xff'.repeat(48), 'a'.repeat(48)), 'a 48-char multi-byte token is rejected, not thrown on');
  ok(!tokenOk('é'.repeat(24) + 'a'.repeat(24), 'a'.repeat(48)), 'a mixed-width token of the right length is rejected');

  // error status: only a category error is the client's fault
  eq(controlErrorStatus('reload applies to page targets only'), 400, 'session reload is a client error');
  eq(controlErrorStatus('page is not mirrored'), 500, 'an unmirrored page is not (yet) a 400');
  eq(controlErrorStatus('EACCES: permission denied'), 500, 'a genuine failure stays a 500');
  eq(controlErrorStatus(''), 500, 'an empty message stays a 500');

  // endpoint file: one per window, so two windows never fight over one file
  eq(endpointFileName(4242), 'control-4242.json', 'endpoint file is keyed by pid');
  ok(
    endpointFileName(1) !== endpointFileName(2),
    'two extension hosts get two different endpoint files'
  );
  ok(/^control-\d+\.json$/.test(endpointFileName(process.pid)), 'name matches the control-*.json glob');
}
