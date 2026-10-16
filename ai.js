// ai.js — เรียก Groq Whisper (จับเวลาคำ) และ Gemini (แยกบรรทัดสคริปต์)

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3";
const GEMINI_MODEL = "gemini-3.8-flash"; // NOTE: Google renames/retires Gemini models often — if this
                                                // starts 404-ing again, the error message itself usually names
                                                // the replacement model to put here (e.g. "gemini-3.6-flash").
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const PAUSE_MARK_THRESHOLD_SEC = 0.25; // gap between two whisper words above this is marked [PAUSE] for Gemini

// =========================================================
// STEP A — Groq Whisper: real acoustic word timing
// =========================================================
export async function callGroqWhisper(apiKey, audioFile, promptHint){
  const form = new FormData();
  form.append('file', audioFile);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', 'th');
  // temperature 0 = greedy decoding: ล็อกให้ Whisper ถอดเสียง/Timestamp เดิมทุกครั้งที่กดรัน (ไม่สุ่ม)
  form.append('temperature', '0');
  // optional: user-supplied specialized terms/character names, passed as
  // Whisper's own "prompt" hint so it's more likely to get unusual words
  // right on the first pass instead of mishearing them.
  if (promptHint && promptHint.trim()) form.append('prompt', promptHint.trim());

  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form
  });

  if (!res.ok){
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq Whisper API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const words = data.words || [];
  if (!Array.isArray(words) || words.length === 0){
    throw new Error('Groq Whisper ไม่ส่งข้อมูล word-level timestamp กลับมา (ตรวจว่าเปิด timestamp_granularities[]=word)');
  }
  return words.map(w => ({
    text: String(w.word || ''),
    start: Number(w.start) || 0,
    end: Number(w.end) || 0
  }));
}

// =========================================================
// STEP A.5 — Gemini-assisted script line splitting (OPTIONAL, INDEPENDENT)
// Runs its own Groq Whisper call (separate from the one inside the main
// "start" flow below) so this feature can never alter timing/alignment
// for the actual render — it only ever writes plain text into
// `editedScript`, which the user can still review/edit before pressing
// "สร้างคลิป" as always. Nothing in STEP B/C or the render pipeline is
// touched by this section.
//
// Why Whisper runs FIRST and Gemini never hears the raw audio: a
// general multimodal model asked to listen to audio and place text at
// the right moment is estimating acoustic position from scratch — that
// is precisely the failure mode where a word from one sentence gets
// placed mid-way through another. A dedicated ASR model (Whisper) is
// built for exactly that job and already produces real word-level
// timestamps elsewhere in this file. So instead of asking Gemini to
// guess word position from raw sound, we hand it Whisper's already-
// measured word sequence (with real pause gaps marked inline) and only
// ask it to do the part it's actually good at: deciding readable
// line-break points given real pacing information. Gemini never invents
// wording — rule 4 in the prompt forces it to reproduce the user's own
// clean script text, using the transcript purely as a pacing reference.
// =========================================================

// Turn Whisper's word list into a plain-text pacing reference: words in
// spoken order, with a [PAUSE] marker inserted wherever the gap to the
// next word exceeds PAUSE_MARK_THRESHOLD_SEC. This is intentionally
// plain text (not JSON) — Gemini just needs to see rhythm, not compute
// over structured indices we'd otherwise have to trust it not to miscount.
export function buildTranscriptForGemini(whisperWords){
  let out = '';
  for (let i = 0; i < whisperWords.length; i++){
    out += whisperWords[i].text;
    if (i < whisperWords.length - 1){
      const gap = whisperWords[i + 1].start - whisperWords[i].end;
      out += gap > PAUSE_MARK_THRESHOLD_SEC ? ' [PAUSE] ' : ' ';
    }
  }
  return out.trim();
}

export function buildGeminiSplitPrompt(rawScript, transcriptText, fillMode, wordMin, wordMax){
  const rules = [
    'กติกา:',
    `1. เป้าหมายความยาวบรรทัด: ${wordMin}-${wordMax} คำต่อบรรทัด — บรรทัดส่วนใหญ่ (อย่างน้อย 90%) ต้องอยู่ในช่วงนี้จริงๆ ห้ามเกินเพดานบนหรือต่ำกว่าเพดานล่างเป็นประจำ อนุญาตให้ยืดหยุ่นได้เฉพาะกรณีจำเป็นจริงๆ เท่านั้น เช่น ชื่อเฉพาะที่แยกคำไม่ได้ หรือวลีติดกันแน่นจนแยกแล้วความหมายเสีย — ไม่ใช่ทุกครั้งที่รู้สึกว่า "น่าจะรวมกันดูดีกว่า"`,
    '2. ห้ามปล่อยคำเชื่อม (เช่น เพราะ, และ, แล้ว, แต่, โผล่) ลอยเดี่ยวๆ บนบรรทัดของตัวเอง',
    '3. ใช้ตำแหน่ง [PAUSE] ในทรานสคริปต์เป็นเบาะแสหลักของจุดตัด แต่ยังต้องพิจารณาเป้าหมายความยาวในข้อ 1 ประกอบด้วย — ถ้าช่วงยาวไม่มี [PAUSE] เลย ให้ใช้เป้าหมายความยาวเป็นตัวช่วยตัดสินใจแทน'
  ];

  if (fillMode){
    rules.push(
      '4. เทียบลำดับคำใน "สคริปต์ต้นฉบับ" กับ "ทรานสคริปต์เสียงจริง" ไปทีละช่วง — ช่วงไหนที่สคริปต์ต้นฉบับมีข้อความรองรับอยู่แล้ว ให้คงคำจากสคริปต์ต้นฉบับเป๊ะ 100% ห้ามเปลี่ยนแม้สะกดจะต่างจากทรานสคริปต์',
      '5. ช่วงไหนที่ทรานสคริปต์เสียงจริงมีคำพูดอยู่ แต่สคริปต์ต้นฉบับไม่มีข้อความรองรับเลย (ช่องว่าง/ไม่ครอบคลุม) ให้ดึงคำจากทรานสคริปต์เสียงจริงมาใช้แทนสำหรับช่วงนั้น และขึ้นต้นทุกบรรทัดที่เนื้อหามาจากทรานสคริปต์ (ไม่ใช่จากสคริปต์ต้นฉบับ) ด้วยข้อความ "[AI] " ที่จุดเริ่มบรรทัด (ห้ามใช้สัญลักษณ์อีโมจิ ใช้ตัวอักษรธรรมดา "[AI] " เท่านั้น) เพื่อให้แยกออกจากบรรทัดที่มาจากสคริปต์ต้นฉบับได้ง่าย',
      '6. ถ้าสคริปต์ต้นฉบับว่างเปล่าทั้งหมด ให้ใช้ทรานสคริปต์เสียงจริงทั้งหมดเป็นฐานในการตัดบรรทัด และขึ้นต้นทุกบรรทัดด้วย "[AI] "',
      '7. ประมวลผลครั้งเดียวจากต้นจนจบ ห้ามวนซ้ำ ห้ามพิมพ์ซ้ำ ห้ามหยุดก่อนถึงคำสุดท้ายของทรานสคริปต์เสียงจริง'
    );
  } else {
    rules.push(
      '4. ห้ามเพิ่ม/ตัด/เรียงคำใหม่ ต้องคงคำและลำดับจาก "สคริปต์ต้นฉบับ" เป๊ะ 100% — ทรานสคริปต์เสียงจริงมีไว้ดูจังหวะเท่านั้น ห้ามเอาคำจากทรานสคริปต์มาแทนคำในสคริปต์ต้นฉบับแม้จะสะกดต่างกัน',
      '5. ถ้ามีบางช่วงของทรานสคริปต์เสียงจริงที่ไม่มีข้อความในสคริปต์ต้นฉบับรองรับเลย ให้ข้ามช่วงนั้นไปเงียบๆ ห้ามแต่งข้อความเติมเอง และห้ามพยายามยัดคำจากสคริปต์ต้นฉบับไปเติมช่วงที่ไม่ตรงกันจริงๆ',
      '6. ประมวลผลครั้งเดียวจากต้นจนจบ ห้ามวนซ้ำ ห้ามพิมพ์ซ้ำ ห้ามหยุดก่อนสคริปต์ต้นฉบับหมด'
    );
  }

  return [
    'คุณคือ Thai Subtitle Pacing Engine',
    '',
    'หน้าที่: แบ่ง "สคริปต์ต้นฉบับ" ด้านล่างออกเป็นบรรทัดย่อยสำหรับซับไตเติ้ล โดยใช้ "ทรานสคริปต์เสียงจริงพร้อมจุดหยุด" เป็นตัวช่วยตัดสินใจว่าจะตัดจังหวะตรงไหน',
    '',
    ...rules,
    '',
    'รูปแบบผลลัพธ์: พิมพ์เฉพาะบรรทัดที่ตัดวรรคแล้ว ห้ามมีคำนำ ห้ามมีคำอธิบาย ห้ามมี code block',
    '',
    '--- สคริปต์ต้นฉบับ ---',
    rawScript ? rawScript : '(ไม่มี — ไม่มีสคริปต์ต้นฉบับให้เลย ใช้ทรานสคริปต์เสียงจริงทั้งหมดแทนตามกติกาข้อที่เกี่ยวข้องด้านบน)',
    '',
    `--- ทรานสคริปต์เสียงจริงพร้อมจุดหยุด (ใช้ดูจังหวะเสมอ${fillMode ? ' และใช้เป็นแหล่งคำสำหรับช่วงที่สคริปต์ไม่ครอบคลุม' : ' ห้ามคัดลอกคำจากส่วนนี้เว้นแต่กติกาด้านบนอนุญาต'}) ---`,
    transcriptText
  ].join('\n');
}

export async function callGeminiSplit(apiKey, rawScript, transcriptText, fillMode, wordMin, wordMax){
  const prompt = buildGeminiSplitPrompt(rawScript, transcriptText, fillMode, wordMin, wordMax);
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  if (!res.ok){
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
  const cleaned = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  if (!cleaned) throw new Error('Gemini ไม่ส่งข้อความบรรทัดที่แยกแล้วกลับมา ลองใหม่อีกครั้ง');
  return cleaned;
}
