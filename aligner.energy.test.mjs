// รันด้วย: node aligner.energy.test.mjs
// ทดสอบการขยับขอบ "ขึ้นซับ" ตามคลื่นเสียง ด้วยเสียงจำลอง (ยังไม่ใช่คลิปจริง)
import assert from 'node:assert/strict';
import { refineSegmentBoundariesWithEnergy } from './aligner.js';

const SR = 16000;

// เสียงจำลอง: พื้นเสียงเบา ๆ + ช่วง "พูด" (คลื่นไซน์ดัง) ตามช่วงที่กำหนด
function makeBuffer(seconds, bursts, noiseAmp = 0.002, burstAmp = 0.5) {
  const data = new Float32Array(Math.round(seconds * SR));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < data.length; i++) data[i] = rnd() * noiseAmp;
  for (const [a, b] of bursts) {
    for (let i = Math.round(a * SR); i < Math.round(b * SR) && i < data.length; i++) {
      data[i] += Math.sin((2 * Math.PI * 220 * i) / SR) * burstAmp;
    }
  }
  return { sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}

const seg = (start, end, matched = true) => ({ text: 'x', start, end, matched });
const near = (actual, expected, tol = 0.025) =>
  assert.ok(Math.abs(actual - expected) <= tol, `คาดว่า ~${expected} ได้ ${actual}`);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ผ่าน:', name);
}

const buf = makeBuffer(5, [[1.0, 1.5], [2.0, 2.6]]);

test('Whisper บอกเร็วไป (ยังเงียบ) -> ขยับไปชนจุดเสียงเริ่ม', () => {
  const [s] = refineSegmentBoundariesWithEnergy([seg(0.92, 1.5)], buf);
  near(s.start, 1.0);
  assert.equal(s.end, 1.5);
});

test('Whisper บอกช้าไป (เสียงดังอยู่แล้ว) -> ถอยกลับไปชนจุดเสียงเริ่ม', () => {
  const [s] = refineSegmentBoundariesWithEnergy([seg(1.1, 1.5)], buf);
  near(s.start, 1.0);
});

test('ไม่แตะขอบ "ซับหาย" แม้เสียงจบก่อน/หลัง', () => {
  const out = refineSegmentBoundariesWithEnergy([seg(0.95, 1.3), seg(2.0, 2.9)], buf);
  assert.equal(out[0].end, 1.3);
  assert.equal(out[1].end, 2.9);
});

test('เสียงเริ่มไกลเกินช่วงค้นหา -> ไม่ขยับ', () => {
  const [s] = refineSegmentBoundariesWithEnergy([seg(0.5, 1.5)], buf);
  assert.equal(s.start, 0.5);
});

test('เสียงพูดต่อเนื่องไม่มีช่องเงียบ -> ไม่ขยับ', () => {
  const cont = makeBuffer(5, [[1.0, 4.0]]);
  const [s] = refineSegmentBoundariesWithEnergy([seg(2.0, 3.0)], cont);
  assert.equal(s.start, 2.0);
});

test('คลิปเสียงรบกวนดังจนแยกไม่ออก -> ไม่แตะอะไร', () => {
  const noisy = makeBuffer(5, [[1.0, 1.5]], 0.3, 0.4);
  const input = [seg(0.95, 1.5)];
  const out = refineSegmentBoundariesWithEnergy(input, noisy);
  assert.equal(out[0].start, 0.95);
});

test('ไม่ล้ำเข้าไปทับบรรทัดก่อนหน้า', () => {
  const out = refineSegmentBoundariesWithEnergy([seg(0.5, 1.02), seg(1.1, 1.5)], buf);
  assert.ok(out[1].start >= out[0].end, `${out[1].start} ทับ ${out[0].end}`);
});

test('บรรทัดที่จับคู่ไม่เจอ/ไม่มีเวลา ไม่ถูกแตะ', () => {
  const input = [seg(0.95, 1.5, false), { text: 'y', start: null, end: null, matched: false }];
  const out = refineSegmentBoundariesWithEnergy(input, buf);
  assert.equal(out[0].start, 0.95);
  assert.equal(out[1].start, null);
});

test('ไม่แก้ข้อมูลที่ส่งเข้า และอินพุตว่าง/ไม่มีเสียงไม่พัง', () => {
  const input = [seg(0.92, 1.5)];
  refineSegmentBoundariesWithEnergy(input, buf);
  assert.equal(input[0].start, 0.92);
  assert.deepEqual(refineSegmentBoundariesWithEnergy([], buf), []);
  assert.equal(refineSegmentBoundariesWithEnergy(input, null), input);
});

console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
