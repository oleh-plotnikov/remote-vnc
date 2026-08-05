import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { recordingBytes, clampFps, MAX_RECORDING_MS } = await load('recording.ts');

  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  const gif = Uint8Array.from('GIF89a'.split('').map((c) => c.charCodeAt(0)));

  // Magic-byte validation, mirroring pngBytesFromDataUrl's strictness.
  eq(Array.from(recordingBytes('webm', webm)), Array.from(webm), 'EBML magic accepted');
  eq(Array.from(recordingBytes('gif', gif)), Array.from(gif), 'GIF89a magic accepted');
  eq(recordingBytes('webm', gif), undefined, 'gif bytes rejected as webm');
  eq(recordingBytes('gif', webm), undefined, 'webm bytes rejected as gif');
  eq(recordingBytes('gif', new Uint8Array()), undefined, 'empty payload rejected');
  eq(recordingBytes('webm', 'AAAA'), undefined, 'non-binary payload rejected');
  eq(recordingBytes('webm', undefined), undefined, 'missing payload rejected');
  eq(
    Array.from(recordingBytes('webm', webm.buffer)),
    Array.from(webm),
    'a bare ArrayBuffer is normalised'
  );

  // Frame-rate clamping for the record-start message.
  eq(clampFps(10), 10, 'in-range untouched');
  eq(clampFps(0), 1, 'floor at 1');
  eq(clampFps(99), 30, 'ceiling at 30');
  eq(clampFps(12.7), 13, 'rounded');
  eq(clampFps(NaN), 10, 'NaN falls back to the default');

  ok(MAX_RECORDING_MS === 10 * 60 * 1000, 'cap is ten minutes');
}
