// aligner.js — Green Screen Subtitle Generator (Native ES Module)
// Linear Monotonic Line Matching: สคริปต์ไทย <-> เวลาจาก Groq Whisper

const MIN_DISPLAY = 0.35; // เวลาแสดงผลขั้นต่ำต่อบรรทัด (วินาที)
const HANDOFF_GAP = 0.08; // ช่องว่างสูงสุดที่ยืดให้ต่อกันแบบไร้รอยต่อ (วินาที)

/** ตัดช่องว่างทุกชนิด (รวม zero-width) ออกจากข้อความ */
function stripWs(str) {
  return String(str == null ? '' : str).replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '');
}

/**
 * สร้าง Character Timeline จากคำของ Whisper
 * @param {Array<{text:string,start:number,end:number}>} whisperWords
 * @returns {Array<{char:string,start:number,end:number}>}
 */
function buildCharTimeline(whisperWords) {
  const timeline = [];
  if (!Array.isArray(whisperWords)) return timeline;

  for (const w of whisperWords) {
    if (!w) continue;
    const chars = Array.from(stripWs(w.text));
    const n = chars.length;
    if (n === 0) continue;

    let wStart = Number(w.start);
    let wEnd = Number(w.end);
    if (!Number.isFinite(wStart)) wStart = timeline.length ? timeline[timeline.length - 1].end : 0;
    if (!Number.isFinite(wEnd)) wEnd = wStart;
    if (wEnd < wStart) wEnd = wStart;

    const dur = wEnd - wStart;
    for (let i = 0; i < n; i++) {
      timeline.push({
        char: chars[i],
        start: wStart + (dur * i) / n,
        end: wStart + (dur * (i + 1)) / n,
      });
    }
  }
  return timeline;
}

/**
 * Display Timing Guard — จัดระเบียบเวลาทีละบรรทัดตามลำดับ
 * @param {Array<{text:string,start:number,end:number}>} segments
 */
function applyDisplayTimingGuard(segments) {
  for (let i = 0; i < segments.length; i++) {
    const cur = segments[i];
    const next = i + 1 < segments.length ? segments[i + 1] : null;

    // ป้องกันเวลาจบไม่เกินเวลาเริ่ม
    if (cur.end <= cur.start) cur.end = cur.start + MIN_DISPLAY;

    // เวลาแสดงผลขั้นต่ำ
    if (cur.end - cur.start < MIN_DISPLAY) cur.end = cur.start + MIN_DISPLAY;

    if (!next) continue;

    // Seamless Handoff: ช่องว่างเล็กน้อย -> ยืดให้ชนกัน
    const gap = next.start - cur.end;
    if (gap >= 0 && gap <= HANDOFF_GAP) {
      cur.end = next.start;
    } else if (cur.end > next.start) {
      // ทับซ้อนกับบรรทัดถัดไป
      if (next.start - cur.start >= MIN_DISPLAY) {
        cur.end = next.start;
      } else {
        cur.end = cur.start + MIN_DISPLAY;
        next.start = cur.end; // ดันต่อเป็นลูกโซ่
      }
    }
  }
  return segments;
}

/**
 * จับคู่บรรทัดสคริปต์เข้ากับเวลาเสียงของ Whisper
 * @param {string[]} lines
 * @param {Array<{text:string,start:number,end:number}>} whisperWords
 * @returns {Array<{text:string,start:number,end:number,matched:boolean,score:number}>}
 */
export function alignLinesToWords(lines, whisperWords) {
  if (!Array.isArray(lines) || lines.length === 0) return [];

  const stream = buildCharTimeline(whisperWords);
  if (stream.length === 0) return [];

  const results = [];
  let streamIdx = 0; // เดินหน้าอย่างเดียว

  for (const line of lines) {
    const lineClean = stripWs(line);
    if (lineClean.length === 0) continue; // ข้ามบรรทัดว่าง

    const len = Array.from(lineClean).length;

    // กันกรณีสคริปต์ยาวกว่าเสียง: ตรึงที่ตัวอักษรสุดท้าย
    const startIdx = Math.min(streamIdx, stream.length - 1);
    const endIdx = Math.max(startIdx, Math.min(stream.length - 1, streamIdx + len - 1));

    const start = stream[startIdx].start;
    const end = stream[endIdx].end;

    streamIdx = endIdx + 1;

    results.push({ text: line, start, end, matched: true, score: 1 });
  }

  return applyDisplayTimingGuard(results);
}

/**
 * Pass-through แบบปลอดภัย: ตรวจสอบขอบเขตเวลา แล้วส่ง segments เดิมกลับ
 * (ไม่ใช้คลื่นเสียงตัดทอนคำพูด)
 * @param {Array<{start:number,end:number}>} segments
 * @param {AudioBuffer} audioBuffer
 */
export function refineSegmentBoundariesWithEnergy(segments, audioBuffer) { // eslint-disable-line no-unused-vars
  if (!Array.isArray(segments) || segments.length === 0) return segments;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;

    if (!Number.isFinite(seg.start) || seg.start < 0) seg.start = i > 0 ? segments[i - 1].end : 0;
    if (!Number.isFinite(seg.end) || seg.end <= seg.start) seg.end = seg.start + MIN_DISPLAY;
  }

  return segments;
}
