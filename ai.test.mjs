// รันด้วย: node ai.test.mjs
// ทดสอบการเลือกโมเดล Gemini ใน ai.js (จำลอง fetch ไม่ได้เรียก API จริง ไม่เสียเงิน)
import assert from 'node:assert/strict';
import { GEMINI_MODELS, DEFAULT_GEMINI_MODEL, callGeminiSplit } from './ai.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ผ่าน:', name); }

async function urlUsed(model) {
  let url = null;
  globalThis.fetch = async (u) => {
    url = u;
    return { ok: true, text: async () => '', json: async () => ({ candidates: [{ content: { parts: [{ text: 'บรรทัด' }] } }] }) };
  };
  await callGeminiSplit('K E', 'สคริปต์', 'a [PAUSE] b', false, 2, 3, model);
  return url;
}

await test('มีโมเดลให้เลือก 3 ตัว id ไม่ซ้ำ ตัวแรกคือค่าเริ่มต้น (3.8 Flash)', () => {
  assert.equal(GEMINI_MODELS.length, 3);
  assert.equal(new Set(GEMINI_MODELS.map(m => m.id)).size, 3);
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
  for (const m of GEMINI_MODELS) assert.ok(m.id && m.label && m.name);
});

await test('เลือกโมเดลไหน คำขอไปที่โมเดลนั้น (และ key ถูกเข้ารหัสใน URL)', async () => {
  for (const m of GEMINI_MODELS) {
    assert.equal(await urlUsed(m.id), `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=K%20E`);
  }
});

await test('ไม่ระบุหรือชื่อที่ไม่รู้จัก -> ใช้ค่าเริ่มต้น ไม่ยิงไปที่ชื่อมั่ว', async () => {
  const expected = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent?key=K%20E`;
  assert.equal(await urlUsed(undefined), expected);
  assert.equal(await urlUsed('gemini-ที่ไม่มี'), expected);
  assert.equal(await urlUsed('../evil'), expected);
});

console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
