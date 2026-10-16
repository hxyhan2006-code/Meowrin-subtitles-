// srt.js — แปลงรายการซับเป็นไฟล์ .srt

function srtTime(t){
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const pad = (n, len) => String(n).padStart(len, '0');
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(ms,3)}`;
}

export function buildSrt(segments){
  return segments.map((seg, i) =>
    `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text}\n`
  ).join('\n');
}
