import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { parseCdpMessage, readCdpFrames } = await load('cdp.ts');

  // --- pipe framing ----------------------------------------------------------
  // The pipe transport is a byte stream, not a message stream: Chrome writes
  // NUL-terminated JSON to fd 4 and the chunk boundaries are wherever the OS
  // put them. Everything below is a boundary a WebSocket used to hide.
  const B = (s) => Buffer.from(s, 'utf8');
  const NUL = Buffer.from([0]);
  const cat = (...parts) => Buffer.concat(parts);

  const one = readCdpFrames(Buffer.alloc(0), cat(B('{"id":1}'), NUL));
  eq(one.frames, ['{"id":1}'], 'a whole frame in one chunk');
  eq(one.rest.length, 0, 'and nothing left over');

  const two = readCdpFrames(Buffer.alloc(0), cat(B('{"id":1}'), NUL, B('{"id":2}'), NUL));
  eq(two.frames, ['{"id":1}', '{"id":2}'], 'two frames in one chunk both come out');

  // Split mid-message: the first call yields nothing and carries the head.
  const head = readCdpFrames(Buffer.alloc(0), B('{"id":'));
  eq(head.frames, [], 'a partial frame yields nothing');
  const tail = readCdpFrames(head.rest, cat(B('3}'), NUL));
  eq(tail.frames, ['{"id":3}'], 'and is completed by the next chunk');

  // A trailing partial after a complete frame must survive to the next call.
  const mixed = readCdpFrames(Buffer.alloc(0), cat(B('{"id":4}'), NUL, B('{"id":')));
  eq(mixed.frames, ['{"id":4}'], 'the complete frame comes out');
  eq(mixed.rest.toString('utf8'), '{"id":', 'and the partial one is carried');

  // The reason this buffers BYTES and decodes only whole frames: a chunk
  // boundary can fall inside a multi-byte character, and decoding each chunk
  // as it arrives would turn that into U+FFFD in the middle of a screencast
  // frame's base64 or a page title.
  const snowman = B('{"t":"☃"}');
  const cut = readCdpFrames(Buffer.alloc(0), snowman.subarray(0, 6));
  const rest = readCdpFrames(cut.rest, cat(snowman.subarray(6), NUL));
  eq(rest.frames, ['{"t":"☃"}'], 'a character split across chunks is not corrupted');

  // Chrome should not send these, but a stray separator must not become a
  // frame — parseCdpMessage would reject it anyway, and a dropped empty is
  // one less thing to reason about downstream.
  const empties = readCdpFrames(Buffer.alloc(0), cat(NUL, B('{"id":5}'), NUL, NUL));
  eq(empties.frames, ['{"id":5}'], 'empty frames are dropped');

  // responses correlate by id
  const res = parseCdpMessage('{"id":7,"result":{"data":"AAA"}}');
  eq(res.id, 7, 'response id parsed');
  eq(res.result.data, 'AAA', 'response result parsed');

  // events carry a method and no id
  const ev = parseCdpMessage('{"method":"Page.screencastFrame","params":{"sessionId":3}}');
  eq(ev.method, 'Page.screencastFrame', 'event method parsed');
  eq(ev.id, undefined, 'event has no id');

  // anything unparseable is rejected rather than forwarded
  eq(parseCdpMessage('not json'), undefined, 'garbage rejected');
  eq(parseCdpMessage('[1,2,3]'), undefined, 'non-object rejected');
  eq(parseCdpMessage('null'), undefined, 'null rejected');
  eq(parseCdpMessage(undefined), undefined, 'undefined rejected');
}
