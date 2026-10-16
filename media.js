// media.js — ถอดรหัส/ตัด/แปลงเสียง และโหลดไลบรารี mediabunny

const MEDIABUNNY_URL = './vendor/mediabunny.min.js?v=1.8'; // mediabunny 1.54.0 เก็บไว้ในโปรเจกต์ (ไม่ต้องพึ่งอินเทอร์เน็ตตอนเรนเดอร์)
let mediabunnyModulePromise = null;
export function loadMediabunny(){
  if (!mediabunnyModulePromise) mediabunnyModulePromise = import(MEDIABUNNY_URL);
  return mediabunnyModulePromise;
}

// =========================================================
// WAVEFORM TRIM — let the user see, hear, and cut out parts of the
// audio (silence, coughs, mistakes) before it's sent to Whisper.
// =========================================================
export async function decodeAudioFile(file){
  const arrayBuf = await file.arrayBuffer();
  const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await tmpCtx.decodeAudioData(arrayBuf);
  } finally {
    tmpCtx.close();
  }
}

export function isVideoFile(file){
  return (file.type && file.type.startsWith('video/')) || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name || '');
}

// Demux + decode a video file's audio track into a single AudioBuffer,
// using Mediabunny (already a dependency of this file for muxing the
// rendered output). Runs entirely client-side, no upload/transcoding
// service involved.
export async function extractAudioFromVideo(file){
  const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } = await loadMediabunny();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) throw new Error('ไม่พบแทร็กเสียงในไฟล์วิดีโอนี้');
  const canDecode = await audioTrack.canDecode();
  if (!canDecode) throw new Error('เบราว์เซอร์นี้ถอดรหัสแทร็กเสียงของไฟล์วิดีโอนี้ไม่ได้');

  const sampleRate = await audioTrack.getSampleRate();
  const numberOfChannels = await audioTrack.getNumberOfChannels();
  const totalDuration = await input.computeDuration();
  const totalSamples = Math.max(1, Math.ceil(totalDuration * sampleRate));

  const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
  let merged;
  try {
    merged = tmpCtx.createBuffer(numberOfChannels, totalSamples, sampleRate);
  } finally {
    tmpCtx.close();
  }

  const sink = new AudioBufferSink(audioTrack);
  for await (const wrapped of sink.buffers()){
    // some encoders write a few audio chunks with a negative presentation
    // timestamp (priming/encoder-delay samples meant to be discarded before
    // t=0) — only some source videos have this, which is why extraction
    // worked for some clips and threw "offset is out of bounds" for others.
    // Clip off the portion of the chunk that lands before time zero instead
    // of writing at a negative index.
    let offset = Math.round(wrapped.timestamp * sampleRate);
    let srcStart = 0;
    if (offset < 0){
      srcStart = -offset;
      offset = 0;
    }
    if (offset >= totalSamples) continue;
    for (let c = 0; c < numberOfChannels; c++){
      const full = wrapped.buffer.numberOfChannels > c ? wrapped.buffer.getChannelData(c) : wrapped.buffer.getChannelData(0);
      if (srcStart >= full.length) continue;
      const src = srcStart > 0 ? full.subarray(srcStart) : full;
      const dest = merged.getChannelData(c);
      const room = totalSamples - offset;
      dest.set(room >= src.length ? src : src.subarray(0, room), offset);
    }
  }
  return merged;
}

export function computePeaks(buffer, numBuckets){
  const channelCount = buffer.numberOfChannels;
  const length = buffer.length;
  const channelData = [];
  for (let c = 0; c < channelCount; c++) channelData.push(buffer.getChannelData(c));
  const samplesPerBucket = Math.max(1, Math.floor(length / numBuckets));
  const peaks = new Float32Array(numBuckets * 2);
  for (let i = 0; i < numBuckets; i++){
    const start = i * samplesPerBucket;
    const end = Math.min(length, start + samplesPerBucket);
    let min = 0, max = 0;
    for (let j = start; j < end; j++){
      let v = 0;
      for (let c = 0; c < channelCount; c++) v += channelData[c][j];
      v /= channelCount;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[i*2] = min;
    peaks[i*2+1] = max;
  }
  return peaks;
}

// ---------- build the final audio actually sent to Whisper + used in the render ----------
export function buildTrimmedAudioBuffer(buffer, regions){
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const totalSamples = buffer.length;
  const cuts = regions
    .map(r => ({
      start: Math.max(0, Math.min(totalSamples, Math.round(r.start * sampleRate))),
      end: Math.max(0, Math.min(totalSamples, Math.round(r.end * sampleRate)))
    }))
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const kept = [];
  let cursor = 0;
  cuts.forEach(c => {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  });
  if (cursor < totalSamples) kept.push({ start: cursor, end: totalSamples });

  const newLength = Math.max(1, kept.reduce((sum, k) => sum + (k.end - k.start), 0));
  const outBuffer = new AudioContext().createBuffer(numChannels, newLength, sampleRate);
  for (let c = 0; c < numChannels; c++){
    const srcData = buffer.getChannelData(c);
    const dstData = outBuffer.getChannelData(c);
    let writeOffset = 0;
    kept.forEach(k => {
      dstData.set(srcData.subarray(k.start, k.end), writeOffset);
      writeOffset += (k.end - k.start);
    });
  }
  return outBuffer;
}

export function audioBufferToWavBlob(buffer){
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;
  const arrBuf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrBuf);
  function writeString(offset, str){
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let c = 0; c < numChannels; c++) channelData.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < numFrames; i++){
    for (let c = 0; c < numChannels; c++){
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([arrBuf], { type: 'audio/wav' });
}
