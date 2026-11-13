/* 실력완성·대표유형: 학생용 문제지 + 교사용 인라인 해설 → 기존 Item.
   지문·발문·선지 파싱은 단원집중을 재사용하고 교사용 정답/해설만 변환한다. */
import * as U from './spans-util.mjs';
import { buildDanwon } from './build-danwon.mjs';

const CIRCLED = '①②③④⑤';
const textOf = (row, sizes = [7.9, 9.1]) => U.joinSpans(row.spans.filter((s) => sizes.includes(s.size)));
const join = (rows) => U.stripChrome(rows.map((r) => r.text).join(''));

function teacherBlocks(pages) {
  const blocks = [];
  let current = null;
  for (const row of U.columnRows(pages)) {
    const marker = U.itemMarkers([row])[0];
    if (marker) { current = { no: marker.no, rows: [] }; blocks.push(current); }
    else if (U.passageStarts([row]).length) current = null;
    if (current) current.rows.push(row);
  }
  return blocks;
}

function inlineSolution(block) {
  const parts = [];
  let current = null;
  const answers = new Set();
  for (const row of block.rows) {
    const symbol = row.spans.find((s) => s.size >= 8.5 && s.size <= 9.2 && /^[①-⑤]/.test(s.text.trim()));
    if (symbol && CIRCLED.indexOf(symbol.text.trim()[0]) === parts.length) {
      current = { no: parts.length + 1, rows: [] }; parts.push(current);
    }
    const right = row.spans.find((s) => s.color === '#ff0000' && s.size >= 8.5 && s.size <= 9.2 && /^[①-⑤]/.test(s.text.trim()));
    if (right) answers.add(right.text.trim()[0]);
    if (current) current.rows.push(row);
  }
  const perChoice = {};
  parts.forEach((part) => {
    const rows = part.rows.map((r) => ({ text: U.joinSpans(r.spans.filter((s) => s.size >= 6.5 && s.size <= 7.5 &&
      ['#ff0000', '#0000ff'].includes(s.color))) }));
    const text = join(rows).replace(/^\s*[→↳]\s*/, '');
    if (text) perChoice[part.no] = text;
  });
  const answer = [...answers].join(',');
  return { answer, body: answers.size === 1 ? perChoice[CIRCLED.indexOf(answer) + 1] || '' : '', perChoice,
    raw: block.rows.map((r) => U.joinSpans(r.spans)).join('\n') };
}

/* 대표유형은 뒤쪽의 번호별 정답표가 교사용 재조판 뒤에 한 번 더 있다.
   [정답]/[해설]의 원문을 보존하고 루브릭으로 안전하게 구조화할 수 없는 채점기준은 검수로 남긴다. */
function answerKey(pages) {
  const entries = [];
  let current = null;
  for (const row of U.columnRows(pages)) {
    const text = textOf(row);
    const marker = text.match(/^\s*(\d{1,3})\)\s*\[정답\]/);
    if (marker) { current = { no: Number(marker[1]), rows: [] }; entries.push(current); }
    if (current) current.rows.push({ text });
  }
  const solutions = {};
  entries.forEach((entry) => {
    const raw = join(entry.rows).replace(/^\d+\)\s*/, '');
    const m = raw.match(/^\[정답\]\s*([\s\S]*?)(?:\[해설\]\s*([\s\S]*))?$/);
    if (m) solutions[entry.no] = { answer: m[1].trim(), body: (m[2] || '').trim(), raw };
  });
  return solutions;
}

export function buildBasic(doc, opts = {}) {
  U.restoreChoiceImages(doc);
  const halves = U.practiceHalves(doc);
  const series = opts.sourceSeries || U.SERIES_LABEL[U.detectSeries(doc).series] || '기본 문제';
  const meta = U.headerMeta(doc);
  const blocks = teacherBlocks(halves.teacher);
  const solutions = series === '실력완성' ? Object.fromEntries(blocks.map((b) => [b.no, inlineSolution(b)]))
    : answerKey(halves.teacher);
  if (series !== '실력완성') blocks.forEach((b) => {
    const at = b.rows.findIndex((r) => textOf(r).includes('[정답]'));
    if (at < 0 || !solutions[b.no]) return;
    let rows = b.rows.slice(at);
    const key = rows.findIndex((r) => /^\s*\d+\)\s*\[정답\]/.test(textOf(r)));
    if (key >= 0) rows = rows.slice(0, key);
    const body = join(rows.map((r) => {
      let text = U.joinSpans(r.spans.filter((s) => s.size === 7.9 || s.imageDigest && CIRCLED.includes(s.text)));
      if (/[①-⑤]$/.test(text)) text += ' ';  // 다음 줄로 넘어간 선지별 해설 마커
      return { text };
    })).replace(/^\[정답\]\s*[①-⑤]\s*/, '');
    if (body) solutions[b.no].body = body;
  });
  const out = buildDanwon({ ...doc, pages: halves.student }, { ...opts, sourceSeries: series,
    scope: 'bs-' + (opts.scope || meta.subUnit || 'u'), bodySizes: [7.9, 8.8, 9.0, 9.1], solutions });
  out.series = 'basic';
  out.review.extraction = { recognized: U.columnRows(halves.student).filter((r) => U.itemMarkers([r]).length).length,
    teacherQuestions: blocks.length, studentPages: halves.student.length, teacherPages: halves.teacher.length };
  out.review.report.unshift(`학생용 ${halves.student.length}쪽 · 교사용 ${halves.teacher.length}쪽 — ${series} 인라인 해설`);
  const source = { series, file: opts.sourceFile || doc.file || '' };
  out.review.candidates.push(...Object.entries(solutions).map(([no, s]) => ({ kind: 'teacherSolution', source, no: Number(no), ...s })));
  out.review.candidates.push(...blocks.map((b) => ({ kind: 'inlineTeacher', source, no: b.no, page: b.rows[0] && b.rows[0].page,
    lines: b.rows.map((r) => U.joinSpans(r.spans)) })));
  out.review.pending.filter((p) => p.kind === 'item' && p.item.format === 'essay').forEach((p) => {
    p.reason = 'rubric-authoring';
    p.why = '모범답안·채점기준 원문은 검수 후보에 보존했습니다 — 자동 채점용 keywords 루브릭을 검수에서 확정하세요';
  });
  /* 한 작품용 기본 문제지의 제목 없는 발췌는 인쇄된 머리말 제목으로 잇는다.
     비교형에서 여러 작품을 한 제목으로 합치지 않는다. */
  const title = meta.workTitle || meta.roundTitle;
  if (title) {
    (out.review.pending || []).filter((p) => p.kind === 'set' && p.works.length === 1 && !p.works[0].title).forEach((p) => {
      p.works[0].title = title;
      out.review.candidates.filter((c) => c.kind === 'setText' && c.setId === p.setId).forEach((c) => { c.title = title; });
    });
  }
  return out;
}
