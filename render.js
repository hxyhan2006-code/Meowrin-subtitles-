// render.js — วาดเฟรมซับบนพื้นเขียวและเรนเดอร์เป็นไฟล์ mp4

export const CANVAS_W = 1080, CANVAS_H = 1080;
export const FONT_FAMILY = "Kanit";
export const BOTTOM_MARGIN_RATIO = 0.10;

// ---------- canvas drawing ----------
// ---------- canvas drawing ----------
export function drawFrame(ctx, text, fontPx, strokePx){
  ctx.fillStyle = '#00FF00';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  if (!text) return;

  ctx.font = `700 ${fontPx}px "${FONT_FAMILY}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = strokePx;
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#FFFFFF';

  const x = CANVAS_W / 2;
  const y = CANVAS_H - (CANVAS_H * BOTTOM_MARGIN_RATIO);

  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

export function findActiveText(segments, t){
  for (const seg of segments){
    if (t >= seg.start && t < seg.end) return seg.text;
  }
  return '';
}

// =========================================================
// RENDER — deterministic, offline (WebCodecs via Mediabunny)
// The old approach recorded canvas + audio in real time through
// MediaRecorder while the audio actually played back — so the result
// depended on the phone keeping up at that exact moment. Any hiccup
// (thermal throttling, another app stealing CPU) dropped or delayed
// frames and baked a slightly-wrong clip that only showed up after the
// fact, which is why some renders needed 2-3 tries. This version never
// "plays" anything: audio is decoded once into raw samples, video frames
// are drawn and encoded one at a time on a fixed timeline, and both are
// muxed into an mp4. A slow device just takes longer — the output timing
// is identical no matter how the render actually went, every time.
// =========================================================
export async function renderVideo({ canvas, segments, audioBuffer, onProgress, fontPx, strokePx, mediabunny }){
  const ctx = canvas.getContext('2d');
  await document.fonts.load(`700 ${fontPx}px "${FONT_FAMILY}"`);
  await document.fonts.ready;

  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_HIGH } = mediabunny;

  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });

  const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: QUALITY_HIGH });
  output.addVideoTrack(videoSource);

  const audioSource = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH });
  output.addAudioTrack(audioSource);

  await output.start();

  const FPS = 30;
  const frameDur = 1 / FPS;
  const durationSec = audioBuffer.duration;
  const totalFrames = Math.max(1, Math.ceil(durationSec * FPS));

  for (let i = 0; i < totalFrames; i++){
    const t = i * frameDur;
    const dur = Math.min(frameDur, durationSec - t);
    drawFrame(ctx, findActiveText(segments, t), fontPx, strokePx);
    await videoSource.add(t, dur);
    if (typeof onProgress === 'function'){
      onProgress(Math.min(97, (t / durationSec) * 100));
    }
  }

  if (typeof onProgress === 'function') onProgress(98);
  await audioSource.add(audioBuffer);

  await output.finalize();
  if (typeof onProgress === 'function') onProgress(100);

  const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
  return { blob, durationSeconds: durationSec };
}
