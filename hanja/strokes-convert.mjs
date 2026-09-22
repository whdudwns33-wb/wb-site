#!/usr/bin/env node
/* WB 어휘브레인 — 공개 획순 데이터 → 공용 획순 사전 변환기 (오프라인 도구)
 *   node hanja/strokes-convert.mjs <graphics.txt> <출력.json> (--book <단어장.json> | --chars 觀測點…) [--box 1024 --top 900]
 *
 * 입력은 Make Me a Hanzi 계열의 graphics.txt(한 줄에 JSON 하나: {"character":"十","strokes":[…],"medians":[[[x,y],…],…]}).
 * 그 데이터는 Arphic Public License 아래 배포된다 — 원본은 저장소에 넣지 않고, 변환 산출물도 관리 웹으로 KV 에 올린다.
 * 좌표는 1024 단위 상자에 y 가 위로 자라는 꼴(글꼴 좌표)이라 0~1·y 아래로 바꾼다: x' = x/box, y' = (top - y)/box.
 *
 * 한국 표준 필순과 다른 글자가 있다. 그래서 단어장에 적힌 획수와 데이터의 획 수가 다르면 review 에 적어
 * 원장이 검수하게 한다 — 검수 없이 올린 획순은 "틀린 채점"이 된다. 검수는 관리 웹 업로드 전에 사람이 한다. */
import fs from 'node:fs';
import path from 'node:path';

const HJ = /^[㐀-䶿一-鿿豈-﫿]$/;
const clamp = (v) => Math.max(0, Math.min(1, v));

/* lines: graphics.txt 줄들 · wanted: {ch: 기대 획수|null} · opts: {box, top}
   → { strokes: {ch: {strokes, medians}}, missing: [ch], mismatch: [{ch, expected, got}] } */
export function convertLines(lines, wanted, opts) {
  const box = (opts && opts.box) || 1024, top = (opts && opts.top) == null ? 900 : opts.top;
  const want = new Map(Object.entries(wanted || {}));
  const strokes = {}, mismatch = [];
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    const ch = rec && rec.character;
    if (!ch || !HJ.test(ch) || !want.has(ch) || strokes[ch]) continue;
    const meds = Array.isArray(rec.medians) ? rec.medians : [];
    const out = meds.map((m) => (Array.isArray(m) ? m : []).map((p) => [Math.round(clamp(p[0] / box) * 1000) / 1000, Math.round(clamp((top - p[1]) / box) * 1000) / 1000]).filter((p) => p.length === 2))
      .filter((m) => m.length >= 2);
    if (!out.length) continue;
    /* 점이 64개를 넘는 획은 균등하게 솎는다 — 단어장 한계(medianPts)와 같은 눈금 */
    const thin = out.map((m) => (m.length <= 64 ? m : m.filter((p, i) => i % Math.ceil(m.length / 64) === 0 || i === m.length - 1)));
    strokes[ch] = { strokes: thin.length, medians: thin };
    const exp = want.get(ch);
    if (exp != null && Number(exp) !== thin.length) mismatch.push({ ch, expected: Number(exp), got: thin.length });
  }
  const missing = [...want.keys()].filter((ch) => !strokes[ch]);
  return { strokes, missing, mismatch };
}

/* 단어장 JSON 에서 글자와 기대 획수를 모은다 — 직접 적은 글자·낱말의 한자·획수 표 모두 */
export function wantedFromBook(book) {
  const out = {};
  for (const c of (book && book.chars) || []) if (c && HJ.test(String(c.ch || ''))) out[c.ch] = c.strokes == null ? null : Number(c.strokes);
  for (const w of (book && book.words) || []) {
    const parts = Array.isArray(w && w.parts) ? w.parts.map((p) => p.ch) : String((w && w.hanja) || '').split('').filter((x) => HJ.test(x));
    for (const ch of parts) if (!(ch in out)) out[ch] = null;
  }
  for (const [ch, n] of Object.entries((book && book.strokes) || {})) if (HJ.test(ch) && out[ch] == null) out[ch] = Number(n);
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const args = process.argv.slice(2);
  const pos = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
  const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  if (pos.length < 2 || (!opt('book') && !opt('chars'))) {
    console.error('사용법: node hanja/strokes-convert.mjs <graphics.txt> <출력.json> (--book <단어장.json> | --chars 觀測點) [--box 1024 --top 900]');
    process.exit(1);
  }
  let wanted = {};
  if (opt('book')) wanted = wantedFromBook(JSON.parse(fs.readFileSync(opt('book'), 'utf8')));
  if (opt('chars')) for (const ch of opt('chars')) if (HJ.test(ch) && !(ch in wanted)) wanted[ch] = null;
  const lines = fs.readFileSync(pos[0], 'utf8').split(/\r?\n/);
  const r = convertLines(lines, wanted, { box: Number(opt('box') || 1024), top: opt('top') == null ? 900 : Number(opt('top')) });
  fs.writeFileSync(pos[1], JSON.stringify({ strokes: r.strokes, madeAt: new Date().toISOString(), source: path.basename(pos[0]), license: '원본 데이터의 라이선스를 따른다(Arphic Public License 등) — 저장소에 넣지 않는다' }, null, 0) + '\n');
  const reviewPath = pos[1].replace(/\.json$/i, '') + '.review.txt';
  fs.writeFileSync(reviewPath, [
    '검수할 것 — 획 수가 단어장과 다른 글자(한국 표준 필순과 다를 수 있음). 원장이 하나씩 보고 올린다.',
    ...r.mismatch.map((m) => m.ch + ': 단어장 ' + m.expected + '획 · 데이터 ' + m.got + '획'),
    '', '데이터에 없는 글자: ' + (r.missing.join(' ') || '없음'),
  ].join('\n') + '\n');
  console.log('글자 ' + Object.keys(r.strokes).length + '자 → ' + pos[1] + ' · 검수 ' + r.mismatch.length + '자, 없음 ' + r.missing.length + '자 → ' + reviewPath);
}
