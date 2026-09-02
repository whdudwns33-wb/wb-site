#!/usr/bin/env node
/* WB 내신 — 레슨 팩 검증기.  node naesin/pack-validate.mjs <팩 디렉터리>
 *
 * 팩 = 과 단위 콘텐츠 JSON 묶음 (이그잼포유 자료를 구조화한 것).
 * 콘텐츠는 라이선스 자료라 저장소에 없다 — 이 검증기는 파이프라인의
 * "검수 게이트" 자동 검증 단계이며, 로컬 팩 디렉터리를 검사한다.
 *
 * 파일 구성 (있는 것만 검사, 최소 1개는 있어야 함):
 *   words.json      단어 마스터        sentences.json  본문 문장 마스터
 *   dialogues.json  대화문 마스터      patterns.json   문법 패턴 마스터
 *   items-*.json    저장 문항
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('사용법: node naesin/pack-validate.mjs <팩 디렉터리>'); process.exit(1); }

const errors = [];
const warns = [];
const summary = [];
const err = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warns.push(`${f}: ${m}`);

function load(name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { err(name, `JSON 파싱 실패 — ${e.message}`); return null; }
}

const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

/* ── words.json ─────────────────────────────── */
const words = load('words.json');
if (words) {
  const f = 'words.json';
  const list = words.words || [];
  if (words.counts?.words != null && list.length !== words.counts.words)
    err(f, `단어 수 불일치 — counts.words=${words.counts.words}, 실제 ${list.length}`);
  const ids = new Set();
  list.forEach((w, i) => {
    const at = `words[${i}](${w.headword ?? '?'})`;
    if (!nonEmpty(w.id)) err(f, `${at} id 없음`);
    else if (ids.has(w.id)) err(f, `${at} id 중복: ${w.id}`);
    else ids.add(w.id);
    if (!nonEmpty(w.headword)) err(f, `${at} headword 없음`);
    if (!Array.isArray(w.meaningKo) || !w.meaningKo.some(nonEmpty)) err(f, `${at} meaningKo 비었음`);
    if (!Array.isArray(w.sections) || !w.sections.length) err(f, `${at} sections 비었음`);
    else w.sections.forEach((s) => { if (s !== 'conversation' && s !== 'reading') err(f, `${at} 잘못된 section: ${s}`); });
    if (w.example && !(nonEmpty(w.example.en) && nonEmpty(w.example.ko))) err(f, `${at} example en/ko 불완전`);
    if (w.definition && !(nonEmpty(w.definition.en) && nonEmpty(w.definition.ko))) err(f, `${at} definition en/ko 불완전`);
    if (w.senses) w.senses.forEach((s, j) => { if (!nonEmpty(s.meaningKo)) err(f, `${at} senses[${j}] meaningKo 없음`); });
  });
  const withEx = list.filter((w) => w.example).length;
  const withDef = list.filter((w) => w.definition).length;
  const poly = list.filter((w) => w.senses?.length).length;
  summary.push(`words: ${list.length}개 (예문 ${withEx} · 영영풀이 ${withDef} · 다의어 ${poly})`);
}

/* ── sentences.json ─────────────────────────── */
const sen = load('sentences.json');
if (sen) {
  const f = 'sentences.json';
  const list = sen.sentences || [];
  list.forEach((s, i) => {
    const at = `sentences[${i}](seq ${s.seq ?? '?'})`;
    if (s.seq !== i + 1) err(f, `${at} seq가 순번(${i + 1})과 다름`);
    if (!['8/1', '8/2', '8/3'].includes(s.dayGroup)) err(f, `${at} dayGroup 이상: ${s.dayGroup}`);
    if (!nonEmpty(s.en)) err(f, `${at} en 없음`);
    if (!nonEmpty(s.ko)) err(f, `${at} ko 없음`);
    if (!Array.isArray(s.keywords) || !s.keywords.length) warn(f, `${at} keywords 비었음`);
    else s.keywords.forEach((k, j) => {
      if (!(nonEmpty(k.en) && nonEmpty(k.ko))) err(f, `${at} keywords[${j}] en/ko 불완전`);
      else if (!s.en.toLowerCase().includes(k.en.toLowerCase().replace(/\s+/g, ' ').trim().split(' ')[0]))
        warn(f, `${at} 핵심어 "${k.en}"가 en에 안 보임 — 표기 확인`);
    });
    if (!Array.isArray(s.tokens) || s.tokens.length < 2) warn(f, `${at} tokens 부족(배열 훈련 불가)`);
    if (s.chunks) {
      /* 청크는 해석 판정의 기준 — 조각을 이어 붙이면 정본 en과 정확히 일치해야 한다 */
      const flat = (t) => String(t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, '');
      if (flat(s.chunks.map((c) => c.en).join(' ')) !== flat(s.en)) err(f, `${at} chunks 연결이 en과 불일치`);
      s.chunks.forEach((c, j) => { if (!(nonEmpty(c.en) && nonEmpty(c.ko))) err(f, `${at} chunks[${j}] en/ko 불완전`); });
    }
  });
  const kw = list.reduce((n, s) => n + (s.keywords?.length || 0), 0);
  summary.push(`sentences: ${list.length}문장 (핵심어 ${kw} · 어색한곳 ${sen.oddOneItems?.length ?? 0} · Check ${sen.checkItems?.length ?? 0})`);
}

/* ── dialogues.json ─────────────────────────── */
const dlg = load('dialogues.json');
if (dlg) {
  const f = 'dialogues.json';
  const list = dlg.dialogues || [];
  if (!list.length) err(f, 'dialogues 비었음');
  let lines = 0;
  list.forEach((d, i) => {
    (d.lines || []).forEach((l, j) => {
      lines += 1;
      if (!(nonEmpty(l.speaker) && nonEmpty(l.en) && nonEmpty(l.ko))) err(f, `dialogues[${i}].lines[${j}] speaker/en/ko 불완전`);
    });
  });
  summary.push(`dialogues: ${list.length}개 ${lines}줄 (핵심표현 ${dlg.keyExpressions?.length ?? 0} · 어휘 사이드바 ${dlg.vocabSidebar?.length ?? 0} · QA ${dlg.readingQA?.length ?? 0})`);
}

/* ── patterns.json ──────────────────────────── */
const pat = load('patterns.json');
if (pat) {
  const f = 'patterns.json';
  const list = pat.patterns || [];
  list.forEach((p, i) => {
    if (!nonEmpty(p.title)) err(f, `patterns[${i}] title 없음`);
    if (!nonEmpty(p.conceptKo)) err(f, `patterns[${i}] conceptKo 없음`);
    if (!p.textbookExamples?.length) warn(f, `patterns[${i}] 교과서 예문 없음`);
  });
  summary.push(`patterns: ${list.length}개`);
}

/* ── items-*.json ───────────────────────────── */
for (const name of fs.readdirSync(dir).filter((n) => /^items-.*\.json$/.test(n)).sort()) {
  const data = load(name);
  if (!data) continue;
  const list = data.items || [];
  list.forEach((it, i) => {
    const at = `items[${i}](no ${it.no ?? '?'})`;
    if (!nonEmpty(it.formatType)) err(name, `${at} formatType 없음`);
    if (!Array.isArray(it.answer) || !it.answer.length) err(name, `${at} answer 비었음`);
    if (Array.isArray(it.choices) && it.choices.length) {
      const labels = new Set(it.choices.map((c) => String(c.label)));
      it.answer.forEach((a) => { if (!labels.has(String(a))) err(name, `${at} 정답 "${a}"가 보기 label에 없음`); });
      if (it.answerCount != null && it.answer.length !== it.answerCount)
        err(name, `${at} answerCount(${it.answerCount}) ≠ 정답 수(${it.answer.length})`);
    }
  });
  summary.push(`${name}: ${list.length}문항`);
}

/* ── packId 일치 ────────────────────────────── */
const packIds = new Set([words, sen, dlg, pat].filter(Boolean).map((d) => d.packId).filter(Boolean));
if (packIds.size > 1) err('(공통)', `packId 불일치: ${[...packIds].join(' / ')}`);
if (!summary.length) { err('(공통)', '검사할 팩 파일이 하나도 없음'); }

/* ── 결과 ───────────────────────────────────── */
console.log(`팩 검증 — ${dir}`);
summary.forEach((s) => console.log('  · ' + s));
if (warns.length) { console.log(`\n경고 ${warns.length}건:`); warns.slice(0, 30).forEach((w) => console.log('  ⚠ ' + w)); if (warns.length > 30) console.log(`  … 외 ${warns.length - 30}건`); }
if (errors.length) { console.log(`\n오류 ${errors.length}건:`); errors.slice(0, 50).forEach((e) => console.log('  ✗ ' + e)); if (errors.length > 50) console.log(`  … 외 ${errors.length - 50}건`); process.exit(1); }
console.log('\n통과 — 오류 없음' + (warns.length ? ` (경고 ${warns.length}건은 검수 화면에서 확인)` : ''));
