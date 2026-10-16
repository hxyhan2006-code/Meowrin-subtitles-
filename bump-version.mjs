// ใช้: node bump-version.mjs 1.8   (บวกเลขเวอร์ชันทุกจุดให้ตรงกัน)
//      node bump-version.mjs --check   (ตรวจว่าทุกจุดเลขเดียวกัน)
import { readFileSync, writeFileSync } from 'node:fs';

const TARGETS = [
  ['index.html', [/(style\.css\?v=)([\d.]+)/g, /(app\.js\?v=)([\d.]+)/g, /(id="appVersion">v)([\d.]+)/g]],
  ['app.js', [/(\.\/(?:aligner|srt|ai|media|render)\.js\?v=)([\d.]+)/g]],
  ['media.js', [/(mediabunny\.min\.js\?v=)([\d.]+)/g]],
];

const arg = process.argv[2];
if (!arg || (arg !== '--check' && !/^\d+\.\d+$/.test(arg))) {
  console.error('ใช้: node bump-version.mjs 1.8   หรือ   node bump-version.mjs --check');
  process.exit(1);
}

const found = [];
for (const [file, patterns] of TARGETS) {
  let text = readFileSync(file, 'utf-8');
  for (const re of patterns) {
    const hits = [...text.matchAll(re)];
    if (hits.length === 0) { console.error('ไม่พบรูปแบบเลขเวอร์ชันใน', file, String(re)); process.exit(1); }
    hits.forEach((m) => found.push([file, m[0], m[2]]));
    if (arg !== '--check') text = text.replace(re, `$1${arg}`);
  }
  if (arg !== '--check') writeFileSync(file, text);
}

const versions = new Set(found.map((f) => f[2]));
if (arg === '--check') {
  if (versions.size === 1) { console.log(`เลขเวอร์ชันตรงกันทุกจุด: v${[...versions][0]} (${found.length} จุด)`); }
  else { console.error('เลขเวอร์ชันไม่ตรงกัน:'); found.forEach((f) => console.error(' ', f[0], f[1])); process.exit(1); }
} else {
  console.log(`บวกเป็น v${arg} แล้ว ${found.length} จุด`);
}
