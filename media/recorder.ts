/**
 * Session recording inside the webview — the framebuffer exists only in
 * noVNC's canvas, so both encoders run here and the host receives finished
 * bytes. WebM rides the browser's MediaRecorder (native VP8/VP9); GIF is
 * encoded incrementally by gifenc, so memory holds the growing compressed
 * file, never a raw frame history.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { MAX_RECORDING_MS, RecordingFormat, RecordingStopReason } from '../src/recording';

export interface RecorderResult {
  data: Uint8Array;
  durationMs: number;
  reason: RecordingStopReason;
}

export interface RecorderOptions {
  /** noVNC's canvas — still the padded framebuffer when a crop is active. */
  canvas: HTMLCanvasElement;
  /** The area worth recording: visibleSize() of the crop, in canvas pixels. */
  width: number;
  height: number;
  format: RecordingFormat;
  fps: number;
  /** Delivered exactly once, after stop() or the duration cap. */
  onStop(result: RecorderResult): void;
  /** Delivered instead of onStop when recording cannot start or dies. */
  onError(message: string): void;
}

export interface Recorder {
  stop(reason?: RecordingStopReason): void;
}

export function startRecording(opts: RecorderOptions): Recorder | undefined {
  try {
    return opts.format === 'gif' ? startGif(opts) : startWebm(opts);
  } catch (err) {
    opts.onError(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function startWebm(opts: RecorderOptions): Recorder | undefined {
  const { canvas, width, height, fps } = opts;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
    (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
  );
  if (!mime) {
    opts.onError('this webview cannot encode WebM (MediaRecorder unavailable)');
    return undefined;
  }

  // With a crop the canvas holds more than the user sees — record a work
  // canvas that receives only the visible rectangle, at the capture rate.
  let source = canvas;
  let copyTimer: number | undefined;
  if (width !== canvas.width || height !== canvas.height) {
    const work = document.createElement('canvas');
    work.width = width;
    work.height = height;
    const ctx = work.getContext('2d');
    if (!ctx) {
      opts.onError('no 2D context for the crop copy');
      return undefined;
    }
    const copy = () => ctx.drawImage(canvas, 0, 0, width, height, 0, 0, width, height);
    copy(); // the stream must not open on an empty frame
    copyTimer = window.setInterval(copy, Math.round(1000 / fps));
    source = work;
  }

  const recorder = new MediaRecorder(source.captureStream(fps), {
    mimeType: mime,
    videoBitsPerSecond: 4_000_000,
  });
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let reason: RecordingStopReason = 'stopped';
  let done = false;
  // A failing recorder fires 'error' and then a trailing 'stop' event (the
  // spec's error -> dataavailable -> stop sequence), so onstop alone cannot
  // assume it is the normal path. `done` cannot double as this guard either:
  // the ordinary stop() path already sets it before calling recorder.stop(),
  // before onstop fires. `delivered` tracks only whether onStop/onError has
  // fired, so the pair stays mutually exclusive and exactly-once either way.
  let delivered = false;

  const cleanup = () => {
    if (copyTimer !== undefined) {
      clearInterval(copyTimer);
    }
    clearTimeout(capTimer);
  };
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
    }
  };
  recorder.onstop = () => {
    if (delivered) {
      return;
    }
    delivered = true;
    cleanup();
    void new Blob(chunks, { type: mime }).arrayBuffer().then((buf) => {
      opts.onStop({ data: new Uint8Array(buf), durationMs: Date.now() - startedAt, reason });
    });
  };
  recorder.onerror = () => {
    if (delivered) {
      return;
    }
    delivered = true;
    done = true;
    cleanup();
    opts.onError('MediaRecorder failed mid-recording');
  };

  const stop = (why: RecordingStopReason = 'stopped') => {
    if (done) {
      return;
    }
    done = true;
    reason = why;
    try {
      recorder.stop(); // onstop delivers the bytes
    } catch {
      cleanup();
    }
  };
  const capTimer = window.setTimeout(() => stop('maxDuration'), MAX_RECORDING_MS);
  recorder.start(1000); // 1 s chunks keep any single blob small
  return { stop };
}

function startGif(opts: RecorderOptions): Recorder | undefined {
  const { canvas, width, height, fps } = opts;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    opts.onError('no 2D context to read frames from');
    return undefined;
  }
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  const startedAt = Date.now();
  let done = false;

  const grab = () => {
    // Quantised per frame and appended immediately: memory holds only the
    // growing compressed GIF, never raw frames.
    const image = ctx.getImageData(0, 0, width, height);
    const palette = quantize(image.data, 256);
    gif.writeFrame(applyPalette(image.data, palette), width, height, { palette, delay });
  };
  grab(); // a stop before the first tick must still yield a playable file

  const stop = (why: RecordingStopReason = 'stopped') => {
    if (done) {
      return;
    }
    done = true;
    clearInterval(frameTimer);
    clearTimeout(capTimer);
    gif.finish();
    opts.onStop({ data: gif.bytes(), durationMs: Date.now() - startedAt, reason: why });
  };
  const frameTimer = window.setInterval(() => {
    if (done) {
      return;
    }
    try {
      grab();
    } catch (err) {
      done = true;
      clearInterval(frameTimer);
      clearTimeout(capTimer);
      opts.onError(err instanceof Error ? err.message : String(err));
    }
  }, delay);
  const capTimer = window.setTimeout(() => stop('maxDuration'), MAX_RECORDING_MS);
  return { stop };
}
