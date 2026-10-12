// aligner.js
// Green Screen Subtitle Generator — Monotonic Word Matching + Acoustic Silence Preservation
// Native ES Module (browser)

/* ------------------------------------------------------------------ */
/* ค่าคงที่ปรับแต่งได้                                                   */
/* ------------------------------------------------------------------ */
const LOOKAHEAD = 20;              // จำนวนคำ Whisper ที่สแกนไปข้างหน้าจาก wp
const MAX_SPAN = 20;               // จำนวนคำสูงสุดต่อ 1 ช่วงที่ลองรวม
const MIN_SCORE = 0.20;            // เกณฑ์ผ่านขั้นต่ำของ textSimilarity (ผ่อนลงเพื่อให้คำสั้น/คำที่ Whisper สะกดเพี้ยนผ่านได้)
const SKIP_PENALTY = 0.002;        // ลดคะแนนเลือกต่อคำที่ข้าม (กันกระโดดไปจับ Hook รอบหลัง)
const SKIP_THRESHOLD_STEP = 0.003; // เพิ่มเกณฑ์ต่อคำที่ข้าม (ตั้งเป็น 0 เพื่อใช้ MIN_SCORE ตรงๆ)

const SUBWORD_MIN_LEFTOVER = 2;    // ตัวอักษรที่เหลือในคำอย่างน้อยกี่ตัวถึงจะถือว่าคำนั้นคร่อมหลายบรรทัด
const SUBWORD_MIN_SCORE = 0.5;     // ส่วนที่เหลือของคำต้องคล้ายต้นบรรทัดถัดไปอย่างน้อยเท่านี้

const GLUE_GAP = 0.05;             // ช่องว่าง < ค่านี้ = พูดต่อเนื่อง -> ยืด cur.end ไปชน next.start
const DEAD_AIR_GAP = 0.12;         // ช่องว่าง > ค่านี้ = Dead Air จริง -> ห้ามแตะเด็ดขาด
const MIN_DISPLAY = 0.28;          // เวลาแสดงผลขั้นต่ำต่อบรรทัด (วินาที)
const MAX_SEC_PER_CHAR = 0.12;     // เพดานเวลาต่อตัวอักษร ตอนต้องเดาเวลาโดยไม่มีคำ Whisper รองรับ

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** ตัดช่องว่างทุกชนิด (space, tab, newline, nbsp, ideographic space, zero-width) */
function stripWs(str) {
  return String(str ?? '').replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '');
}

/** ใช้เฉพาะตอนจับคู่: ตัดช่องว่าง + lowercase + ตัดเครื่องหมายวรรคตอน/สัญลักษณ์ */
function normalizeForMatch(str) {
  return stripWs(str).toLowerCase().replace(/[\p{P}\p{S}]+/gu, '');
}

function levenshteinChars(A, B) {
  const n = A.length;
  const m = B.length;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = A[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = ai === B[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}

function similarityChars(A, B) {
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;
  return 1 - levenshteinChars(A, B) / Math.max(A.length, B.length);
}

/** ความคล้ายคลึงด้วย Levenshtein Distance: 0.0 - 1.0 */
function textSimilarity(a, b) {
  return similarityChars(Array.from(a ?? ''), Array.from(b ?? ''));
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** เวลา ณ ตำแหน่งตัวอักษรที่ charPos ภายในคำ (กระจายตามสัดส่วนตัวอักษร) */
function timeAt(word, charPos) {
  const L = word.chars.length;
  return word.start + (charPos / L) * (word.end - word.start);
}

/** เตรียมคำ Whisper: รองรับ {word|text, start, end} ตัดคำว่าง/เวลาเสีย และเรียงตามเวลา */
function prepareWords(whisperWords) {
  const out = [];
  if (!Array.isArray(whisperWords)) return out;
  for (const w of whisperWords) {
    if (!w) continue;
    const start = Number(w.start);
    const end = Number(w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const chars = Array.from(normalizeForMatch(w.word ?? w.text ?? ''));
    if (chars.length === 0) continue;
    out.push({ start, end: Math.max(start, end), chars });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/** ข้อความ (ตัวอักษร) ของบรรทัดถัดๆ ไป ต่อกันจนครบ need ตัว */
function upcomingChars(entries, fromIdx, need) {
  let acc = [];
  for (let i = fromIdx; i < entries.length && acc.length < need; i++) {
    acc = acc.concat(entries[i].target);
  }
  return acc;
}

/**
 * หาช่วงคำ [s..e] ที่คล้าย target ที่สุด โดยเริ่มสแกนที่ wp เท่านั้น (monotonic)
 * wOff = จำนวนตัวอักษรของคำ wp ที่บรรทัดก่อนหน้าใช้ไปแล้ว (กรณีคำถูกรวบหลายบรรทัด)
 */
function findBestWindow(target, words, wp, wOff) {
  const n = words.length;
  const maxChars = target.length * 2 + 4;
  const lastStart = Math.min(n - 1, wp + LOOKAHEAD - 1);
  let best = null;

  for (let s = wp; s <= lastStart; s++) {
    const first = s === wp && wOff > 0 ? words[s].chars.slice(wOff) : words[s].chars;
    if (first.length === 0) continue;
    const lastEnd = Math.min(n - 1, s + MAX_SPAN - 1);
    let acc = [];
    for (let e = s; e <= lastEnd; e++) {
      acc = acc.concat(e === s ? first : words[e].chars);
      const sim = similarityChars(target, acc);
      const adj = sim - SKIP_PENALTY * (s - wp);
      // เสมอกัน -> เก็บอันที่มาก่อน (ใกล้ wp กว่า / สั้นกว่า)
      if (!best || adj > best.adj + 1e-9) {
        best = { s, e, sim, adj, len: acc.length };
      }
      if (acc.length > maxChars) break;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* alignLinesToWords                                                    */
/* ------------------------------------------------------------------ */

export function alignLinesToWords(lines, whisperWords) {
  const rawLines = Array.isArray(lines)
    ? lines
    : typeof lines === 'string'
      ? lines.split(/\r?\n/)
      : [];
  const words = prepareWords(whisperWords);

  // ข้ามบรรทัดว่าง
  const entries = [];
  for (const line of rawLines) {
    const text = typeof line === 'string' ? line : String(line ?? '');
    if (stripWs(text) === '') continue;
    entries.push({ text, target: Array.from(normalizeForMatch(text)) });
  }

  if (entries.length === 0) return [];
  if (words.length === 0) {
    return entries.map((e) => ({ text: e.text, start: null, end: null, matched: false }));
  }

  /* ---------- Phase 1: Monotonic Word Matching ---------- */
  let wp = 0;   // ตัวชี้คำ Whisper (เดินหน้าอย่างเดียว)
  let wOff = 0; // ตัวอักษรของคำ wp ที่ถูกใช้ไปแล้ว (Sub-word)
  const recs = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const { text, target } = entries[idx];
    let rec = null;

    if (target.length > 0 && wp < words.length) {
      const best = findBestWindow(target, words, wp, wOff);
      if (best) {
        const skipped = best.s - wp;
        const required = MIN_SCORE + SKIP_THRESHOLD_STEP * skipped;
        if (best.sim >= required) {
          const startOff = best.s === wp ? wOff : 0;

          // Phase 2: Sub-word Interpolation — คำ Whisper คำเดียวคร่อมหลายบรรทัด
          let endChar = null; // null = ใช้คำสุดท้ายจนจบคำ
          const excess = best.len - target.length;
          if (excess >= SUBWORD_MIN_LEFTOVER) {
            const lastWord = words[best.e];
            const Lw = lastWord.chars.length;
            const avail = best.e === best.s ? Lw - startOff : Lw;
            if (excess < avail) {
              const leftover = lastWord.chars.slice(Lw - excess);
              const upcoming = upcomingChars(entries, idx + 1, excess);
              if (
                upcoming.length > 0 &&
                similarityChars(leftover, upcoming.slice(0, excess)) >= SUBWORD_MIN_SCORE
              ) {
                endChar = Lw - excess;
              }
            }
          }

          const start = startOff > 0 ? timeAt(words[best.s], startOff) : words[best.s].start;
          const end = endChar !== null ? timeAt(words[best.e], endChar) : words[best.e].end;

          rec = {
            text,
            start,
            end: Math.max(start, end),
            matched: true,
            wi0: best.s,
            wi1: best.e,
            startsMid: startOff > 0,
            partialEnd: endChar !== null,
          };

          if (endChar !== null) {
            wp = best.e;      // คำเดิมยังเหลือส่วนท้ายให้บรรทัดถัดไป
            wOff = endChar;
          } else {
            wp = best.e + 1;
            wOff = 0;
          }
        }
      }
    }

    // จับคู่ไม่เจอ: ไม่ขยับ wp เพื่อให้บรรทัดถัดไปยังหาคำเจอ
    if (!rec) {
      rec = { text, start: null, end: null, matched: false, weight: Math.max(1, target.length) };
    }
    recs.push(rec);
  }

  /* ---------- Phase 3: กระจายเวลาให้บรรทัดที่จับคู่ไม่เจอ ---------- */
  let i = 0;
  while (i < recs.length) {
    if (recs[i].matched) {
      i++;
      continue;
    }
    let j = i;
    while (j < recs.length && !recs[j].matched) j++;

    const prev = i > 0 ? recs[i - 1] : null;
    const next = j < recs.length ? recs[j] : null;
    const run = recs.slice(i, j);
    const totalW = run.reduce((a, r) => a + r.weight, 0);
    const cap = totalW * MAX_SEC_PER_CHAR;

    // ใช้คำ Whisper ที่ยังไม่ถูกจับคู่ระหว่าง prev กับ next เป็นขอบเขตเสียงพูดจริง
    const freeFrom = prev ? prev.wi1 + 1 : 0;
    const freeTo = next ? next.wi0 - 1 : words.length - 1;
    const hasFree = freeFrom <= freeTo;

    let lo = null;
    let hi = null;
    if (hasFree) {
      lo = words[freeFrom].start;
      hi = words[freeTo].end;
    }
    if (prev && prev.partialEnd) lo = prev.end;   // ส่วนท้ายของคำที่ถูกแบ่ง
    if (next && next.startsMid) hi = next.start;  // ส่วนต้นของคำที่ถูกแบ่ง

    if (lo === null || hi === null) {
      // ไม่มีคำ Whisper รองรับ: เฉลี่ยจากช่องว่างระหว่าง prev/next แต่ไม่ยืดเกินอัตราพูดปกติ
      const gapLo = lo ?? (prev ? prev.end : next ? Math.max(0, next.start - cap) : 0);
      const gapHi = hi ?? (next ? next.start : gapLo + cap);
      if (gapHi <= gapLo) {
        // ช่องว่างแคบเกินไป: ห้ามเหลือ 0 วินาที ให้ยืดออกให้ทุกบรรทัดมีเวลาแสดงผล
        lo = gapLo;
        hi = gapLo + run.length * MIN_DISPLAY;
      } else {
        const dur = Math.min(gapHi - gapLo, cap);
        lo = gapLo + (gapHi - gapLo - dur) / 2;
        hi = lo + dur;
      }
    }
    // ประกันว่าช่วงที่นำมาแบ่งยาวอย่างน้อย run.length * MIN_DISPLAY เสมอ
    const minSpan = run.length * MIN_DISPLAY;
    if (hi - lo < minSpan) hi = lo + minSpan;

    let cum = 0;
    for (const r of run) {
      r.start = lo + (cum / totalW) * (hi - lo);
      cum += r.weight;
      r.end = lo + (cum / totalW) * (hi - lo);
    }
    i = j;
  }

  /* ---------- Phase 4: Dead Air + เวลาแสดงผลขั้นต่ำ ---------- */
  const timed = recs.filter((r) => r.start !== null && r.end !== null);

  // 4.1 บังคับให้เรียงตามเวลาและห้ามซ้อนทับกัน
  for (let k = 0; k < timed.length - 1; k++) {
    const cur = timed[k];
    const nxt = timed[k + 1];
    if (nxt.start < cur.start) nxt.start = cur.start;
    if (nxt.end < nxt.start) nxt.end = nxt.start;
    if (cur.end > nxt.start) cur.end = nxt.start;
  }

  // 4.2 เวลาแสดงผลขั้นต่ำ + Collision Guard
  //     ห้ามบีบ cur.end ให้สั้นกุด: ให้เวลาครบ MIN_DISPLAY เสมอ
  //     ถ้าชนบรรทัดถัดไป ให้ดัน next.start ออกไปเป็นลูกโซ่ (ไม่มีบรรทัดไหนหายจากจอ)
  for (let k = 0; k < timed.length; k++) {
    const cur = timed[k];
    const nxt = k + 1 < timed.length ? timed[k + 1] : null;

    if (cur.end < cur.start) cur.end = cur.start;
    if (cur.end - cur.start < MIN_DISPLAY) {
      cur.end = cur.start + MIN_DISPLAY;
      if (nxt && nxt.start < cur.end) {
        nxt.start = cur.end;                       // ดันต่อเป็นลูกโซ่
        if (nxt.end < nxt.start) nxt.end = nxt.start; // บรรทัดถัดไปจะถูกเติมให้ครบ MIN_DISPLAY ในรอบถัดไป
      }
    }
  }

  // 4.3 รักษา Dead Air: ยืดเฉพาะช่องว่างจิ๋ว (< GLUE_GAP) กันจอกระพริบ
  //     ช่องว่างตั้งแต่ GLUE_GAP ขึ้นไป (รวมถึง > DEAD_AIR_GAP) ปล่อยตามเสียงจริง
  for (let k = 0; k < timed.length - 1; k++) {
    const cur = timed[k];
    const nxt = timed[k + 1];
    const gap = nxt.start - cur.end;
    if (gap > 0 && gap < GLUE_GAP) {
      cur.end = nxt.start;
    }
    // gap > DEAD_AIR_GAP => ไม่แตะ
  }

  return recs.map((r) => ({
    text: r.text,
    start: r.start === null ? null : round3(r.start),
    end: r.end === null ? null : round3(r.end),
    matched: r.matched,
  }));
}

/* ------------------------------------------------------------------ */
/* refineSegmentBoundariesWithEnergy                                    */
/* ------------------------------------------------------------------ */

/**
 * Pass-through แบบปลอดภัย: คืน segments เดิมโดยไม่แก้ไข
 * เพื่อไม่ให้การวิเคราะห์คลื่นเสียงไปตัดหางเสียงคำพูดทิ้ง
 */
export function refineSegmentBoundariesWithEnergy(segments, audioBuffer) {
  void audioBuffer;
  return segments;
}
