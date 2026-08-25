#!/usr/bin/env node
'use strict';
/* WB 진로독서 콘텐츠 무결성 테스트 — node reading/content.test.cjs */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'articles.json');
const errors = [];
const warns = [];
const E = (m) => errors.push(m);
const W = (m) => warns.push(m);

const LIMITS = {
  L2: { min: 450, max: 750, vocab: 4, q: 4 },
  L3: { min: 650, max: 1050, vocab: 5, q: 4 },
  L4: { min: 900, max: 1450, vocab: 5, q: 5 },
};
const QTYPES = new Set(['main', 'detail', 'vocab', 'infer', 'critical']);
const CATS = new Set(['science', 'society', 'history', 'humanities', 'environment']);
const CAREERS = new Set(['eng','it','med','bio','nat','biz','media','law','edu','art','env','hum']);

function checkLevel(tag, lv, b, isDiag) {
  const lim = LIMITS[lv];
  if (!b.title || typeof b.title !== 'string') E(`${tag}: title 없음`);
  if (!Number.isInteger(b.minutes) || b.minutes < 1) E(`${tag}: minutes 잘못됨`);
  if (!Array.isArray(b.paragraphs) || !b.paragraphs.length) { E(`${tag}: paragraphs 없음`); return; }
  const joined = b.paragraphs.map(p => p.join('')).join('\n');
  const chars = joined.replace(/\n/g, '').length;
  if (!isDiag && (chars < lim.min || chars > lim.max)) W(`${tag}: 글자 수 ${chars} (권장 ${lim.min}~${lim.max})`);
  b.paragraphs.forEach((p, pi) => {
    if (!Array.isArray(p) || !p.length) { E(`${tag}: 문단 ${pi} 형식 오류`); return; }
    p.forEach((seg, si) => {
      if (typeof seg !== 'string' || !seg.length) E(`${tag}: 문단 ${pi} 조각 ${si} 비어 있음`);
    });
    const text = p.join('');
    if (/ {2,}/.test(text)) W(`${tag}: 문단 ${pi} 연속 공백`);
    if (text !== text.trimStart()) W(`${tag}: 문단 ${pi} 앞 공백`);
  });
  if (!Array.isArray(b.vocab)) E(`${tag}: vocab 배열 아님`);
  else {
    if (!isDiag && b.vocab.length < lim.vocab - 1) W(`${tag}: vocab ${b.vocab.length}개 (권장 ${lim.vocab})`);
    b.vocab.forEach((v, vi) => {
      if (!v.word || !v.easy) { E(`${tag}: vocab ${vi} word/easy 누락`); return; }
      const inOneSeg = b.paragraphs.some(p => p.some(seg => seg.includes(v.word)));
      if (!inOneSeg) E(`${tag}: vocab "${v.word}" 가 어떤 조각 안에도 없음`);
      if (v.hanja != null && typeof v.hanja !== 'string') E(`${tag}: vocab "${v.word}" hanja 타입 오류`);
    });
    const words = b.vocab.map(v => v.word);
    if (new Set(words).size !== words.length) E(`${tag}: vocab 중복`);
  }
  if (!Array.isArray(b.questions) || !b.questions.length) { E(`${tag}: questions 없음`); return; }
  if (!isDiag && b.questions.length !== lim.q) W(`${tag}: 문항 ${b.questions.length}개 (권장 ${lim.q})`);
  const answerDist = new Set();
  b.questions.forEach((q, qi) => {
    const qt = `${tag} Q${qi + 1}`;
    if (!QTYPES.has(q.type)) E(`${qt}: type "${q.type}" 알 수 없음`);
    if (q.type === 'critical' && lv !== 'L4') W(`${qt}: critical은 L4 전용`);
    if (!q.q) E(`${qt}: 발문 없음`);
    if (!Array.isArray(q.choices) || q.choices.length !== 4) E(`${qt}: 선지 4개 아님`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) E(`${qt}: answer 인덱스 오류`);
    else answerDist.add(q.answer);
    if (!q.explain) E(`${qt}: explain 없음`);
    if (!Number.isInteger(q.evidencePara) || q.evidencePara < 0 || q.evidencePara >= b.paragraphs.length)
      E(`${qt}: evidencePara 범위 오류`);
  });
  if (b.questions.length >= 4 && answerDist.size === 1) W(`${tag}: 정답 위치가 모두 같음`);
}

let db;
try {
  db = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('FAIL: articles.json 파싱 불가 —', e.message);
  process.exit(1);
}

if (!Array.isArray(db.articles) || !db.articles.length) E('articles 배열 없음');
if (!db.diagnostics) E('diagnostics 없음');

const ids = new Set();
(db.articles || []).forEach((a) => {
  const tag = a.id || '(no-id)';
  if (!a.id) E('id 없는 article');
  if (ids.has(a.id)) E(`${tag}: id 중복`); ids.add(a.id);
  if (!CATS.has(a.category)) E(`${tag}: category "${a.category}" 알 수 없음`);
  if (!Array.isArray(a.careers) || !a.careers.length) E(`${tag}: careers 없음`);
  else a.careers.forEach(c => { if (!CAREERS.has(c)) E(`${tag}: career "${c}" 알 수 없음`); });
  if (!['published', 'draft'].includes(a.status)) E(`${tag}: status 오류`);
  if (!Array.isArray(a.sources) || !a.sources.length) E(`${tag}: sources 없음`);
  else a.sources.forEach(s => { if (!/^https:\/\//.test(s.url || '')) E(`${tag}: source URL https 아님`); });
  ['L2', 'L3', 'L4'].forEach(lv => {
    if (!a.levels || !a.levels[lv]) { E(`${tag}: ${lv} 없음`); return; }
    checkLevel(`${tag}/${lv}`, lv, a.levels[lv], false);
    const b = a.levels[lv];
    if (b.en != null) {
      if (lv === 'L2') W(`${tag}/${lv}: L2에는 영어 대역을 쓰지 않음`);
      if (!Array.isArray(b.en) || b.en.length !== b.paragraphs.length)
        E(`${tag}/${lv}: en 배열 길이(${Array.isArray(b.en) ? b.en.length : '없음'})가 문단 수(${b.paragraphs.length})와 다름`);
      else b.en.forEach((p, i) => { if (typeof p !== 'string' || p.trim().length < 10) E(`${tag}/${lv}: en[${i}] 비정상`); });
    }
  });
  (a.papers || []).forEach((p, i) => {
    if (!p.title || !/^https:\/\//.test(p.url || '')) E(`${tag}: papers[${i}] title/https URL 오류`);
  });
  (a.books || []).forEach((b, i) => {
    if (!b.title || !b.author) E(`${tag}: books[${i}] title/author 누락`);
  });
});
['L2', 'L3', 'L4'].forEach(lv => {
  if (!db.diagnostics || !db.diagnostics[lv]) { E(`diagnostics ${lv} 없음`); return; }
  checkLevel(`diag/${lv}`, lv, db.diagnostics[lv], true);
});

warns.forEach(w => console.log('WARN:', w));
if (errors.length) {
  errors.forEach(e => console.error('ERROR:', e));
  console.error(`\nFAIL — 오류 ${errors.length}건, 경고 ${warns.length}건`);
  process.exit(1);
}
console.log(`OK — 지문 ${db.articles.length}편 × 3레벨 + 진단 3편, 경고 ${warns.length}건`);
