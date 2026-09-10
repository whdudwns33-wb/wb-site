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
  /* L1(초1~2)은 "짧은 L2"가 아니다 — 규격 근거는 docs/저학년-지문-스펙-v1.md */
  /* 120 = 최소 8문장 × 평균 15자, 350 = 최대 14문장 × 최대 25자 — 문장 규칙과 산술을 맞춘다 */
  L1: { min: 120, max: 350, vocab: 2, q: 2, choices: 3 },
  L2: { min: 450, max: 750, vocab: 4, q: 4 },
  L3: { min: 650, max: 1050, vocab: 5, q: 4 },
  L4: { min: 900, max: 1450, vocab: 5, q: 5 },
};
/* L1 전용 상한 — 저학년은 해독에 작업기억을 쓰므로 문장·조각이 짧아야 한다 */
const L1 = {
  paraMin: 2, paraMax: 3, sentPerPara: [2, 4], sentTotal: [8, 14],
  sentMax: 25, segMax: 8, vocabMax: 3, easyMax: 25, qMax: 3,
  qtypes: new Set(['main', 'detail']),
  hanjaMaxGrade: '7급',   // 한국어문회 7급 이하만
};
const HANJA = (() => {
  try { return require('../vocab/hanja-grades.js'); } catch (e) { return null; }
})();
/* 낱말의 급수가 L1 허용 범위(7급 이하) 안인지 — 급수가 아예 없으면(2급 이상) 통과시키지 않는다 */
function hanjaTooHard(hanja) {
  if (!HANJA || !hanja) return null;
  const g = HANJA.wbWordGrade(hanja);
  if (!g) return '급수 밖(2급 이상)';
  const order = HANJA.WB_HANJA_LEVELS;
  return order.indexOf(g) > order.indexOf(L1.hanjaMaxGrade) ? g : null;
}
function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
}
const QTYPES = new Set(['main', 'detail', 'vocab', 'infer', 'critical']);
const CHTYPES = new Set(['main', 'detail', 'vocab', 'infer', 'critical', 'apply']); // 심화 문항
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
    if (lv === 'L1' && !L1.qtypes.has(q.type))
      E(`${qt}: L1은 main·detail만 — "${q.type}"은 문항 읽기 능력을 재게 된다`);
    if (!q.q) E(`${qt}: 발문 없음`);
    const nCh = lim.choices || 4;
    if (!Array.isArray(q.choices) || q.choices.length !== nCh) E(`${qt}: 선지 ${nCh}개 아님`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= nCh) E(`${qt}: answer 인덱스 오류`);
    else answerDist.add(q.answer);
    if (!q.explain) E(`${qt}: explain 없음`);
    if (!Number.isInteger(q.evidencePara) || q.evidencePara < 0 || q.evidencePara >= b.paragraphs.length)
      E(`${qt}: evidencePara 범위 오류`);
  });
  if (b.questions.length >= 4 && answerDist.size === 1) W(`${tag}: 정답 위치가 모두 같음`);
  /* 심화 문항 (선택 — 신규 지문은 레벨당 2개 권장) */
  if (b.challenge != null) {
    if (!Array.isArray(b.challenge) || !b.challenge.length) E(`${tag}: challenge 형식 오류`);
    else b.challenge.forEach((q, qi) => {
      const qt = `${tag} 심화Q${qi + 1}`;
      if (!CHTYPES.has(q.type)) E(`${qt}: type "${q.type}" 알 수 없음`);
      if (!q.q) E(`${qt}: 발문 없음`);
      if (!Array.isArray(q.choices) || q.choices.length !== 4) E(`${qt}: 선지 4개 아님`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) E(`${qt}: answer 인덱스 오류`);
      if (!q.explain) E(`${qt}: explain 없음`);
      if (!Number.isInteger(q.evidencePara) || q.evidencePara < 0 || q.evidencePara >= b.paragraphs.length)
        E(`${qt}: evidencePara 범위 오류`);
    });
  } else if (!isDiag && lv !== 'L1') W(`${tag}: 심화 문항 없음 (신규 지문은 2개 권장)`);
  if (lv === 'L1') checkL1(tag, b, isDiag);
}

/* ── L1(초1~2) 전용 검증 — docs/저학년-지문-스펙-v1.md §10 ── */
function checkL1(tag, b, isDiag) {
  if (b.challenge != null) E(`${tag}: L1에는 심화 문항을 넣지 않는다`);
  if (b.en != null || b.enseg != null || b.envocab != null) E(`${tag}: L1에는 영어 대역을 넣지 않는다`);
  if (b.questions && b.questions.length > L1.qMax) W(`${tag}: 문항 ${b.questions.length}개 (L1은 ${L1.qMax}개 이하)`);

  const paras = Array.isArray(b.paragraphs) ? b.paragraphs : [];
  if (!isDiag && (paras.length < L1.paraMin || paras.length > L1.paraMax))
    W(`${tag}: 문단 ${paras.length}개 (권장 ${L1.paraMin}~${L1.paraMax})`);

  let total = 0;
  paras.forEach((p, pi) => {
    (Array.isArray(p) ? p : []).forEach((seg, si) => {
      if (typeof seg === 'string' && seg.trim().length > L1.segMax)
        W(`${tag}: 문단 ${pi} 조각 ${si} "${seg.trim()}" ${seg.trim().length}자 (조각은 ${L1.segMax}자 이하)`);
    });
    const ss = sentences((Array.isArray(p) ? p : []).join(''));
    total += ss.length;
    if (!isDiag && (ss.length < L1.sentPerPara[0] || ss.length > L1.sentPerPara[1]))
      W(`${tag}: 문단 ${pi} 문장 ${ss.length}개 (권장 ${L1.sentPerPara[0]}~${L1.sentPerPara[1]})`);
    ss.forEach((sent) => {
      if (sent.length > L1.sentMax) W(`${tag}: 문장 ${sent.length}자 — "${sent}" (최대 ${L1.sentMax}자)`);
    });
  });
  if (!isDiag && (total < L1.sentTotal[0] || total > L1.sentTotal[1]))
    W(`${tag}: 총 문장 ${total}개 (권장 ${L1.sentTotal[0]}~${L1.sentTotal[1]})`);

  (b.vocab || []).forEach((v) => {
    if (!v || !v.word) return;
    if (v.easy && v.easy.length > L1.easyMax)
      W(`${tag}: "${v.word}" 뜻풀이 ${v.easy.length}자 (${L1.easyMax}자 이내로)`);
    const hard = hanjaTooHard(v.hanja);
    if (hard) W(`${tag}: "${v.word}" 한자 ${hard} — L1은 ${L1.hanjaMaxGrade} 이하만`);
  });
  const hanjaN = (b.vocab || []).filter((v) => v && v.hanja).length;
  if (hanjaN > 1) W(`${tag}: 한자어 ${hanjaN}개 (L1은 지문당 1개 이하)`);
  if ((b.vocab || []).length > L1.vocabMax) W(`${tag}: 어휘 ${b.vocab.length}개 (L1은 ${L1.vocabMax}개 이하)`);
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
  if (a.issue != null && typeof a.issue !== 'boolean') E(`${tag}: issue는 boolean`);
  if (!Array.isArray(a.sources) || !a.sources.length) E(`${tag}: sources 없음`);
  else a.sources.forEach(s => { if (!/^https:\/\//.test(s.url || '')) E(`${tag}: source URL https 아님`); });
  /* L1(저학년)은 선택 — 있으면 검증하고, 없어도 통과시킨다 (기존 지문을 건드리지 않으려고) */
  if (a.levels && a.levels.L1) checkLevel(`${tag}/L1`, 'L1', a.levels.L1, false);
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
    if (b.envocab != null) {
      if (!Array.isArray(b.envocab)) E(`${tag}/${lv}: envocab 배열 아님`);
      else {
        const enText = (b.en || []).join('\n');
        const seen = new Set();
        b.envocab.forEach((ev, i) => {
          if (!ev.word || !ev.ko) { E(`${tag}/${lv}: envocab[${i}] word/ko 누락`); return; }
          if (seen.has(ev.word)) E(`${tag}/${lv}: envocab "${ev.word}" 중복`); seen.add(ev.word);
          if (!enText.includes(ev.word)) E(`${tag}/${lv}: envocab "${ev.word}" 영어 본문에 없음`);
        });
      }
    }
  });
  (a.papers || []).forEach((p, i) => {
    if (!p.title || !/^https:\/\//.test(p.url || '')) E(`${tag}: papers[${i}] title/https URL 오류`);
  });
  (a.books || []).forEach((b, i) => {
    if (!b.title || !b.author) E(`${tag}: books[${i}] title/author 누락`);
    if (b.url != null && !/^https:\/\//.test(b.url)) E(`${tag}: books[${i}] url https 아님`);
    if (b.video != null && !/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(b.video.url || '')) E(`${tag}: books[${i}] video URL 유튜브 아님`);
  });
  (a.videos || []).forEach((v, i) => {
    if (!v.title || !/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(v.url || '')) E(`${tag}: videos[${i}] title/유튜브 URL 오류`);
  });
  ['L3', 'L4'].forEach(lv => {
    const b = a.levels && a.levels[lv];
    if (!b || b.enseg == null) return;
    if (!Array.isArray(b.enseg) || b.enseg.length !== (b.en || []).length) {
      E(`${tag}/${lv}: enseg 문단 수 불일치`); return;
    }
    b.enseg.forEach((segs, i) => {
      if (!Array.isArray(segs) || segs.join('') !== b.en[i])
        E(`${tag}/${lv}: enseg[${i}] 조각 이어붙이기가 en 원문과 다름`);
    });
  });
});
if (db.diagnostics && db.diagnostics.L1) checkLevel('diag/L1', 'L1', db.diagnostics.L1, true);
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
const l1n = (db.articles || []).filter(a => a.levels && a.levels.L1).length;
console.log(`OK — 지문 ${db.articles.length}편 × 3레벨${l1n ? ` (L1 ${l1n}편)` : ''} + 진단 3편, 경고 ${warns.length}건`);
