'use strict';
/* 청크브레인 콘텐츠 무결성 — node chunk/content.test.cjs
 *
 * 글쓴이(사람 또는 에이전트)가 끊은 자리를 기계가 다시 본다. 규격서 6장의 검사(이어붙이기·빈 조각·글자 수)에
 * 규칙 검사(관형어·부사·수+단위·의존명사·보조용언 자리에서 끊지 않았나)와 밴드별 어절 상한을 더했다.
 * 지문이 늘어날 때마다 여기부터 돈다 — 여기서 걸리면 학생 화면에서 「모범」이 틀린 채로 나간다. */
const assert = require('assert');
const R = require('./rules.js');
const P = require('./passages.js');
const L = require('./lessons.js');
const errors = [];
const E = (m) => errors.push(m);

/* ── 지문 ── */
const ids = new Set();
const perBand = {};
P.forEach((p) => {
  const at = p.id || '(id 없음)';
  if (!p.id || ids.has(p.id)) E(at + ': id 가 없거나 겹친다'); ids.add(p.id);
  const band = R.BANDS[p.band];
  if (!band) { E(at + ': 모르는 밴드 ' + p.band); return; }
  if (!p.title || !p.genre) E(at + ': title·genre 필요');
  if (!Array.isArray(p.paragraphs) || !p.paragraphs.length) { E(at + ': paragraphs 필요'); return; }
  let chars = 0; const lens = [];
  p.paragraphs.forEach((segs, pi) => {
    if (!Array.isArray(segs) || !segs.length) { E(at + ' 문단 ' + pi + ': 조각 배열이 아니다'); return; }
    const text = segs.join('');
    chars += text.replace(/\s/g, '').length;
    /* 원문 = 이어붙인 것 — 조각을 손보다 글자가 새는 사고를 여기서 잡는다 */
    if (R.segsFromBoundaries(text, R.modelBoundaries(segs)).join('') !== text) E(at + ' 문단 ' + pi + ': 경계로 다시 조립하면 원문과 다르다');
    if (/\s{2,}/.test(text)) E(at + ' 문단 ' + pi + ': 띄어쓰기가 두 번 이어진다');
    if (/\s$/.test(segs[segs.length - 1])) E(at + ' 문단 ' + pi + ': 마지막 조각이 공백으로 끝난다');
    R.check(segs, p.band).forEach((m) => E(at + ' 문단 ' + pi + ': ' + m));
    segs.forEach((s) => lens.push(R.words(s).length));
    /* 문장 하나가 밴드의 문장 길이 범위 안에 있는가 — 유치에 12어절짜리 문장이 섞이면 안 된다 */
    R.sentencesOf(segs).forEach((sent) => {
      const n = R.words(sent.join('')).length;
      if (n > band.sentLen[1]) E(at + ' 문단 ' + pi + ': 문장이 ' + n + '어절 — ' + band.label + ' 문장 상한 ' + band.sentLen[1] + ' 초과: 「' + sent.join('').trim().slice(0, 30) + '…」');
    });
  });
  if (chars < band.chars[0] || chars > band.chars[1]) E(at + ': 글자 수 ' + chars + ' — ' + band.label + ' 범위 ' + band.chars.join('~') + ' 밖');
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  (perBand[p.band] = perBand[p.band] || []).push(avg);
  /* 이해 문제 — 유치·초1~2 는 3지선다, 그 위는 4지선다. 답은 지문 안에 있어야 한다(사실 문제) */
  const q = p.q;
  const want = band.sentenceMode ? 3 : 4;
  if (!q || !q.q || !Array.isArray(q.choices) || q.choices.length !== want) E(at + ': 문제는 ' + want + '지선다여야 한다');
  else {
    if (!(q.answer >= 0 && q.answer < q.choices.length)) E(at + ': answer 인덱스가 범위 밖');
    if (new Set(q.choices).size !== q.choices.length) E(at + ': 선택지가 겹친다');
    if (!q.explain) E(at + ': explain 필요');
  }
});

/* 밴드마다 최소 6편, 정답 위치가 한쪽으로 쏠리지 않았나, 조각 평균이 밴드 눈금 근처인가 */
R.BAND_ORDER.forEach((b) => {
  const list = P.filter((p) => p.band === b);
  if (list.length < 6) E(b + ': 지문이 ' + list.length + '편 — 최소 6편');
  const answers = new Set(list.map((p) => p.q && p.q.answer));
  if (answers.size < 3) E(b + ': 정답 위치가 ' + [...answers].join(',') + ' 뿐 — 고르게 섞어야 찍기가 안 통한다');
  const genres = new Set(list.map((p) => p.genre));
  if (genres.size < 2) E(b + ': 갈래가 하나뿐 — 이야기·설명·논설 등을 섞는다');
  const avgs = perBand[b] || [];
  const avg = avgs.reduce((a, x) => a + x, 0) / (avgs.length || 1);
  const t = R.BANDS[b].target;
  if (avg < t - 1 || avg > t + 1.2) E(b + ': 조각 평균 ' + avg.toFixed(2) + '어절 — 눈금 ' + t + ' 에서 너무 멀다');
});

/* ── 배우기 카드 ── */
const lids = new Set();
L.forEach((l) => {
  const at = l.id || '(id 없음)';
  if (!l.id || lids.has(l.id)) E('카드 ' + at + ': id 가 없거나 겹친다'); lids.add(l.id);
  if (!R.BANDS[l.band]) E('카드 ' + at + ': 모르는 밴드');
  if (!l.title || !l.rule || !l.why || !l.tip) E('카드 ' + at + ': title·rule·why·tip 필요');
  if (!Array.isArray(l.tags) || !l.tags.length) E('카드 ' + at + ': tags 필요');
  else l.tags.forEach((tg) => { if (!R.TAG_LABEL[tg]) E('카드 ' + at + ': 모르는 태그 ' + tg); });
  if (!Array.isArray(l.examples) || l.examples.length < 2) E('카드 ' + at + ': 보기 2개 이상');
  if (!Array.isArray(l.checks) || l.checks.length < 1) E('카드 ' + at + ': 확인 문제 1개 이상');
  [].concat(l.examples || [], l.checks || []).forEach((x, i) => {
    if (!x || !Array.isArray(x.segs) || !x.segs.length) { E('카드 ' + at + ' 항목 ' + i + ': segs 필요'); return; }
    R.check(x.segs, l.band).forEach((m) => E('카드 ' + at + ' 항목 ' + i + ': ' + m));
    if (R.modelBoundaries(x.segs).length < 1) E('카드 ' + at + ' 항목 ' + i + ': 경계가 하나도 없다 — 연습이 안 된다');
  });
});
/* 카드는 나선형 — 학년마다 새 카드 2장 이상, 그 학년까지 쌓인 카드가 4장 이상이면 배우기 탭이 비지 않는다 */
R.BAND_ORDER.forEach((b, i) => {
  if (L.filter((l) => l.band === b).length < 2) E(b + ': 새 카드가 2장 미만');
  const upto = R.BAND_ORDER.slice(0, i + 1);
  if (L.filter((l) => upto.indexOf(l.band) >= 0).length < 4) E(b + ': 이 학년까지 쌓인 카드가 4장 미만');
});
/* 모든 규칙 태그를 어느 카드든 다루는가 — 복습 탭이 「약한 규칙 → 카드」로 보낼 곳이 있어야 한다 */
Object.keys(R.TAG_LABEL).forEach((tg) => { if (!L.some((l) => l.tags.indexOf(tg) >= 0)) E('태그 ' + tg + ' 를 다루는 카드가 없다'); });

if (errors.length) {
  errors.forEach((e) => console.error('ERROR:', e));
  console.error('\nFAIL — ' + errors.length + '건');
  process.exit(1);
}
const words = P.reduce((n, p) => n + p.paragraphs.reduce((m, s) => m + R.words(s.join('')).length, 0), 0);
console.log('OK — 지문 ' + P.length + '편(' + words + '어절) · 카드 ' + L.length + '장 · 밴드 ' + R.BAND_ORDER.join('·'));
R.BAND_ORDER.forEach((b) => {
  const avgs = perBand[b]; const avg = avgs.reduce((a, x) => a + x, 0) / avgs.length;
  console.log('  ' + b.padEnd(3) + ' 지문 ' + avgs.length + '편 · 조각 평균 ' + avg.toFixed(2) + '어절 (눈금 ' + R.BANDS[b].target + ')');
});
