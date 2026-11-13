/* 풀이완성·개념완성 step2: 학생용 예제 + 교사용 체크/첨삭 → mc5 또는 명시된 OX.
   근거 기호를 학생이 직접 맞히는 입력은 현재 앱에 없어 검수 쪽에 별도로 보존한다. */
import * as U from './spans-util.mjs';

const CIRCLED = '①②③④⑤';
const RED = ['#d30000', '#ff0000'];
const NOTE = ['#28448e', '#315f97'];
const BODY_INK = ['#000000', '#222222', '#211d1e'];
const isBodyInk = (c) => BODY_INK.includes(c);
const join = (rows) => U.stripChrome(rows.map((r) => r.text).join(''));

function examples(pages) {
  const out = [];
  pages.forEach((p) => U.splitColumns(p).forEach((col, ci) => {
    const rows = col.slice().sort((a, b) => a.y - b.y);
    const starts = U.exampleStarts(rows);
    starts.forEach((start, i) => {
      out.push({ page: p.no, col: ci ? 'R' : 'L', exampleNo: start.no || ci + 1,
        rows: rows.filter((r) => r.y >= start.y && (i + 1 === starts.length || r.y < starts[i + 1].y)) });
    });
  }));
  return out;
}

function feedback(example) {
  const parts = [];
  let current = null;
  const answers = new Set();
  for (const row of example.rows) {
    const marker = row.spans.find((s) => (isBodyInk(s.color) || RED.includes(s.color)) &&
      s.size >= 8.5 && s.size <= 9.2 && /^[①-⑤]/.test(s.text.trim()));
    const symbol = marker && marker.text.trim()[0];
    if (symbol && CIRCLED.indexOf(symbol) === parts.length) {
      current = { no: parts.length + 1, rows: [] }; parts.push(current);
    }
    const correct = row.spans.find((s) => RED.includes(s.color) && s.size >= 8.5 && s.size <= 9.2 && /^[①-⑤]/.test(s.text.trim()));
    if (correct) answers.add(correct.text.trim()[0]);
    const printed = U.joinSpans(row.spans).match(/\(?\정답\s*([①-⑤](?:\s*[,·]\s*[①-⑤])*)\)?/);
    if (printed) (printed[1].match(/[①-⑤]/g) || []).forEach((s) => answers.add(s));
    if (current) current.rows.push(row);
  }
  const perChoice = {}, evidence = [], flags = {};
  parts.forEach((part) => {
    const text = join(part.rows.map((r) => ({ text: U.joinSpans(r.spans.filter((s) => NOTE.includes(s.color))) })));
    if (text) perChoice[part.no] = text.replace(/\(?\정답\s*[①-⑤]\)?/g, '').replace(/^\s*[→↳]\s*/, '').trim();
    const marks = [...new Set((text.match(/[㉠-㉭]/g) || []))];
    evidence.push({ no: part.no, marks, text });
    const red = part.rows.flatMap((r) => r.spans).filter((s) => RED.includes(s.color)).map((s) => s.text).join('');
    if (/[○◯〇]/.test(red)) flags[part.no] = true;
    else if (/[✕×✖]/.test(red)) flags[part.no] = false;
  });
  return { answer: answers.size === 1 ? CIRCLED.indexOf([...answers][0]) + 1 : null,
    answers: [...answers].map((s) => CIRCLED.indexOf(s) + 1), perChoice, evidence, flags,
    raw: example.rows.map((r) => U.joinSpans(r.spans)) };
}

export function buildPuri(doc, opts = {}) {
  U.restoreChoiceImages(doc);
  const halves = U.practiceHalves(doc), meta = U.headerMeta(doc);
  const scope = String(opts.scope || meta.subUnit || 'u').replace(/[^A-Za-z0-9-]/g, '-');
  const series = opts.sourceSeries || (U.detectSeries(doc).series === 'concept2' ? '개념완성 step2.풀이전략' : '풀이완성');
  const student = examples(halves.student), teacher = examples(halves.teacher);
  const title = meta.workTitle || meta.roundTitle;
  const workId = (opts.workIds || {})[title] || '';
  const items = [], sets = [], pending = [], candidates = [], report = [], todo = [];
  const setOf = new Map();

  halves.student.forEach((p, pi) => {
    const rows = U.splitColumns(p).flatMap((col) => {
      const first = U.exampleStarts(col)[0];
      if (!first) return [];
      return col.filter((r) => r.y >= U.MAST_BAND && r.y < first.y).map((r) => {
        const spans = r.spans.filter((s) => s.size >= 8.5 && s.size <= 9.2 && isBodyInk(s.color));
        return { text: U.joinSpans(spans), width: spans.length ? Math.max(...spans.map((s) => s.x + s.w)) - Math.min(...spans.map((s) => s.x)) : 0 };
      }).filter((r) => r.text.trim());
    });
    const setId = 's-ps-' + scope + '-' + String(pi + 1).padStart(2, '0');
    const prose = rows.length && rows.filter((r) => r.width >= p.width * 0.3).length / rows.length >= 0.35;
    const text = prose ? { paragraphs: U.paragraphsFromRows(rows) } : { stanzas: [{ no: 1, lines: rows.map((r) => U.stripChrome(r.text)) }] };
    const ref = { label: '', title: title || '', workId, kind: 'excerpt', text };
    setOf.set(p.no, setId);
    candidates.push({ kind: 'setText', setId, label: '', title: title || '', kind2: 'excerpt', prose: !!prose,
      page: p.no, body: prose ? text.paragraphs : text.stanzas[0].lines });
    if (rows.length && workId) sets.push({ setId, works: [{ workId, label: '', kind: 'excerpt', text }] });
    else pending.push({ kind: 'set', setId, why: rows.length ? '작품 제목/정본 연결을 검수에서 확인하세요' : '예제 위의 지문을 읽지 못했습니다', works: [ref] });
  });

  student.forEach((ex, index) => {
    const source = { series, section: title || '', no: index + 1, page: ex.page, exampleNo: ex.exampleNo };
    if (opts.sourceFile || doc.file) source.file = opts.sourceFile || doc.file;
    const rows = ex.rows.map((r) => ({ text: U.joinSpans(r.spans.filter((s) => s.size >= 8.5 && s.size <= 9.7 && isBodyInk(s.color))) }));
    const parsed = U.parseChoiceRows(rows);
    const stem = parsed.stem.replace(/^Q\d+\.\s*/, '');
    const answer = teacher.length === student.length && teacher[index] ? feedback(teacher[index])
      : { answer: null, perChoice: {}, evidence: [], flags: {}, raw: [] };
    const isNegative = /적절하지\s*않|옳지\s*않|아닌\s*것/.test(stem);
    const item = { id: U.itemId('puri', scope, index + 1), format: 'mc5', source, setId: setOf.get(ex.page),
      stem: U.escapeStem(stem), isNegative, choices: parsed.choices, targetRefs: [],
      explanation: { main: answer.perChoice[answer.answer] || '', perChoice: answer.perChoice } };
    if (workId) item.workId = workId;
    if (parsed.bogi) item.bogi = { kind: 'text', text: parsed.bogi };
    candidates.push({ kind: 'choiceEvidence', itemId: item.id, source, choices: answer.evidence,
      flags: answer.flags, printedAnswer: answer.answer, printedAnswers: answer.answers || [], originalStem: stem, rawTeacher: answer.raw });
    let correct = answer.answer;
    if (!correct && (answer.answers || []).length < 2 && Object.keys(answer.flags).length === parsed.choices.length) {
      const possible = Object.keys(answer.flags).filter((n) => answer.flags[n] === !isNegative);
      if (possible.length === 1) correct = Number(possible[0]);
    }
    const hasChoices = parsed.choices.length >= 2 && parsed.choices.every((c) => c.text && c.text.trim());
    if (hasChoices && parsed.choices.length <= 5 && stem && correct && correct <= parsed.choices.length) {
      item.answer = correct; items.push(item);
    } else if (hasChoices && Object.keys(answer.flags).length === parsed.choices.length && stem) {
      parsed.choices.forEach((c) => items.push({ ...item, id: item.id + '-ox' + c.no, format: 'ox', choices: undefined,
        stem: U.escapeStem(c.text), answer: answer.flags[c.no], source: { ...source, choiceNo: c.no },
        explanation: { main: answer.perChoice[c.no] || '' } }));
    } else {
      item.answer = correct;
      pending.push({ kind: 'item', reason: (answer.answers || []).length > 1 ? 'multi-answer' : 'incomplete-practice',
        why: (answer.answers || []).length > 1 ? '복수 정답은 단일 mc5 정답으로 줄이지 않습니다 — 원문 답을 검수 후보에서 확인하세요'
          : '발문·인쇄된 선지·정답을 확정하지 못했습니다', item });
    }
  });
  halves.teacher.forEach((p) => candidates.push({ kind: 'strategyNotes', page: p.no,
    source: { series, file: opts.sourceFile || doc.file || '' }, images: p.images || [],
    lines: U.columnRows([p]).map((r) => U.joinSpans(r.spans)) }));
  report.push(`학생용 ${halves.student.length}쪽 · 교사용 ${halves.teacher.length}쪽 · 예제 ${student.length}/${teacher.length}`);
  report.push(`문항 ${items.length} (mc5 ${items.filter((i) => i.format === 'mc5').length} · ox ${items.filter((i) => i.format === 'ox').length}) · 검수 ${pending.filter((p) => p.kind === 'item').length}`);
  if (student.length !== teacher.length || !student.length) todo.push('학생/교사 예제 수가 맞지 않습니다 — 페이지 경계를 확인하세요');
  todo.push('선지별 근거 기호 맞히기·선지 고쳐 쓰기는 현재 앱 입력이 없어 review.candidates에 보존했습니다');
  return { series: 'puri', meta, patches: [], items, sets,
    review: { pending, candidates, report, todo, extraction: { recognized: student.length, teacherQuestions: teacher.length,
      studentPages: halves.student.length, teacherPages: halves.teacher.length } } };
}
