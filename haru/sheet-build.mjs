// 종이 시험지·OMR 답안지·정답표 조판 — 자작(origin:'own') 팩을 인쇄한다. CLI: node haru/sheet-build.mjs <pack.json> <outDir> [--key paperkey.json] [--title "국어 실전 회차 1"]
// 시험지 HTML 에는 정답·해설·오답 태그가 한 글자도 들어가지 않는다(pack-check.stripForStudent 를 거친 뒤 조판). 정답표는 별도 파일이고 원장만 본다.
// 인쇄물에 학교명·교표를 넣지 않는다(기획서 §4-16). 외부 CSS·폰트 없음.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PC = require('./pack-check.js');

const CIRCLED = ['①', '②', '③', '④', '⑤'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SUBJ = { kor: '국어', math: '수학', eng: '영어' };

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
body { font-family: "Noto Serif KR", "Apple SD Gothic Neo", "Malgun Gothic", serif; font-size: 11.5pt; line-height: 1.6; color: #111; margin: 0; }
.hd { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #111; padding-bottom: 4pt; margin-bottom: 10pt; }
.hd .t { font-size: 15pt; font-weight: 700; } .hd .m { font-size: 10pt; color: #333; }
.box { border: 1px solid #333; padding: 8pt 10pt; margin: 6pt 0 10pt; } .box p { margin: 0 0 6pt; text-indent: 1em; }
.box .verse { white-space: pre-line; line-height: 1.7; }
.set { font-size: 10pt; color: #333; margin: 12pt 0 2pt; font-weight: 700; }
.q { margin: 8pt 0 6pt; page-break-inside: avoid; } .q .no { font-weight: 700; margin-right: 4pt; }
.q .stem { margin: 3pt 0 3pt 1.2em; padding: 3pt 8pt; border-left: 3px solid #999; }
.ch { margin: 2pt 0 0 1.2em; } .ch div { margin: 1pt 0; }
.neg { text-decoration: underline; text-underline-offset: 2pt; font-weight: 700; }
.omr { page-break-before: always; } .omr table { border-collapse: collapse; margin-top: 8pt; }
.omr td, .omr th { border: 1px solid #333; padding: 4pt 8pt; text-align: center; font-size: 11pt; }
.omr .b { font-size: 14pt; letter-spacing: 6pt; }
.id { display: flex; gap: 12pt; margin: 8pt 0; } .id div { border: 1px solid #333; padding: 6pt 10pt; min-width: 120pt; }
.rules { font-size: 10pt; color: #333; margin-top: 8pt; }
.foot { font-size: 9pt; color: #555; border-top: 1px solid #999; margin-top: 14pt; padding-top: 4pt; }
.ans table { border-collapse: collapse; } .ans td, .ans th { border: 1px solid #333; padding: 3pt 8pt; font-size: 10.5pt; }
`;

/* 세트 경계: 지문 = 한 세트, 지문 없는 단독 문항 = 저마다 한 세트('q21'). pace.js 는 세트 첫 문항에 지문 시간을 귀속하므로
   단독 문항을 세트에 빠뜨리면 checkPaperKey 가 '빠진 번호'로 막는다. */
function setsOf(pack, key) {
  if (key && key.sets) return key.sets;
  const s = {}, seen = {};
  (pack.passages || []).forEach((p) => { s[p.id] = p.itemNos.slice(); p.itemNos.forEach((n) => { seen[n] = true; }); });
  (pack.items || []).forEach((it) => { if (!seen[it.no]) s['q' + it.no] = [it.no]; });
  return s;
}
function renderItem(it) {
  const q = esc(it.instructionKo).replace(/(옳지 않은|일치하지 않는|아닌|틀린)/g, '<span class="neg">$1</span>');
  const stem = it.stemKo ? `<div class="stem">${esc(it.stemKo)}</div>` : '';
  const ch = (it.choices || []).map((c, i) => `<div>${CIRCLED[i] || c.key} ${esc(c.text)}</div>`).join('');
  return `<div class="q"><span class="no">${it.no}.</span>${q}${stem}<div class="ch">${ch}</div></div>`;
}
export function renderExam(pack, opts = {}) {
  const st = PC.stripForStudent(pack);
  const title = opts.title || `${SUBJ[st.subject] || st.subject} 실전 회차`;
  const limit = st.timeLimitSec ? Math.round(st.timeLimitSec / 60) + '분' : (opts.minutes || 40) + '분';
  const n = st.items.length;
  const byId = {}; (st.passages || []).forEach((p) => { byId[p.id] = p; });
  const items = st.items.slice().sort((a, b) => a.no - b.no);
  let body = '', shown = {};
  for (const it of items) {
    if (it.setId && byId[it.setId] && !shown[it.setId]) {
      const p = byId[it.setId]; shown[it.setId] = true;
      const range = p.itemNos.length > 1 ? `[${Math.min(...p.itemNos)}~${Math.max(...p.itemNos)}]` : `[${p.itemNos[0]}]`;
      // 시(verse)는 행·연을 그대로 보존한다(pre-line). 산문은 문단마다 <p>
      const inner = p.verse ? `<div class="verse">${esc(p.textKo)}</div>` : String(p.textKo).split(/\n+/).map((x) => `<p>${esc(x)}</p>`).join('');
      body += `<div class="set">${range} 다음 글을 읽고 물음에 답하시오.</div><div class="box">${inner}</div>`;
      if (p.attribution) body += `<div class="rules">출처: ${esc(p.attribution.org)} 「${esc(p.attribution.title)}」(${esc(p.attribution.year)}) · 공공누리 제1유형</div>`;
    }
    body += renderItem(it);
  }
  const omr = renderOmr(n, opts);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="hd"><div class="t">${esc(title)}</div><div class="m">${limit} · ${n}문항 · 문항당 4점 · 성명 ______ · 번호 ____</div></div>
<div class="rules">답은 답안지에 컴퓨터용 사인펜으로 표시합니다. 넘긴 문항은 시험지에 △ 표시를 하고 끝에 돌아옵니다. 시험지에 풀이를 써도 됩니다.</div>
${body}
${omr}
<div class="foot">WB 독해력학원 자체 제작 연습 문항 · 실제 시험과 무관 · 학교와 제휴·후원 관계 없음 · ${esc(opts.footer || '')}</div>
</body></html>`;
}
export function renderOmr(n, opts = {}) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`<tr><td>${i}</td><td class="b">①②③④${opts.five ? '⑤' : ''}</td><td></td></tr>`);
  return `<div class="omr"><div class="hd"><div class="t">답안지</div><div class="m">${esc(opts.title || '')}</div></div>
<div class="id"><div>수험번호<br><br></div><div>성명<br><br></div><div>회차 ${esc(opts.round || '')}</div></div>
<table><tr><th>번호</th><th>답 (하나만 칠하세요)</th><th>△</th></tr>${rows.join('')}</table>
<div class="rules">칠한 답을 바꿀 때는 지우지 말고 감독 선생님께 새 답안지를 받습니다. △ 칸은 넘겼다가 돌아온 문항에 표시합니다(채점과 무관).</div></div>`;
}
export function renderAnswerKey(pack, key) {
  const items = pack.items.slice().sort((a, b) => a.no - b.no);
  const sets = setsOf(pack, key); const setOf = {}; Object.keys(sets).forEach((s) => sets[s].forEach((no) => { setOf[no] = s; }));
  const rows = items.map((it) => {
    const ans = it.choices.findIndex((c) => c.key === it.answerKey);
    return `<tr><td>${it.no}</td><td>${CIRCLED[ans] || it.answerKey}</td><td>${esc(it.atomId)}</td><td>${esc(setOf[it.no] || '')}</td><td>${it.tier}</td><td>${esc(it.explanationKo || '')}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>정답표 ${esc(pack.packId)}</title><style>${CSS}</style></head><body class="ans">
<div class="hd"><div class="t">정답표 · ${esc(pack.packId)}</div><div class="m">원장·강사용 — 학생에게 배부 금지</div></div>
<div class="rules">${(pack.passages || []).map((p) => `${esc(p.id)} 「${esc(p.titleKo || '')}」 ${esc(p.genre || '')} · 문항 ${p.itemNos.join(',')}`).join(' / ')}</div>
<table><tr><th>번호</th><th>정답</th><th>원자</th><th>세트</th><th>tier</th><th>해설</th></tr>${rows}</table></body></html>`;
}
/* 팩 → paperkey (자작이므로 answer 포함). 종이 회차의 서버 채점·pace 세트 경계의 원천. */
export function paperKeyFrom(pack, id, opts = {}) {
  const items = pack.items.slice().sort((a, b) => a.no - b.no);
  const map = {}, answer = {}; items.forEach((it) => { map[it.no] = it.atomId; answer[it.no] = it.answerKey; });
  return { id: id || pack.packId, label: opts.label || pack.packId, subject: pack.subject, n: items.length, timeLimitSec: pack.timeLimitSec || 2400,
           origin: 'own', holder: 'academy', frozen: !!opts.frozen, sets: setsOf(pack, null), map, answer, note: '문항 번호 ↔ 원자 대응. 문항·지문 텍스트는 담지 않는다.' };
}
export function build(pack, outDir, opts = {}) {
  const chk = PC.checkPack(pack, { atoms: opts.atoms });
  if (chk.errors.length) throw new Error('팩 검증 실패: ' + chk.errors.map((e) => e.where + ' ' + e.msg).join('; '));
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, pack.packId);
  const key = paperKeyFrom(pack, opts.keyId, opts);
  const kc = PC.checkPaperKey(key, { atoms: opts.atoms });
  if (kc.errors.length) throw new Error('paperkey 검증 실패: ' + kc.errors.map((e) => e.msg).join('; '));
  fs.writeFileSync(base + '-시험지.html', renderExam(pack, opts));
  fs.writeFileSync(base + '-정답표.html', renderAnswerKey(pack, key));
  fs.writeFileSync(base + '-paperkey.json', JSON.stringify(key, null, 2) + '\n');
  return { exam: base + '-시험지.html', answers: base + '-정답표.html', paperkey: base + '-paperkey.json', key };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--title') opts.title = args[++i]; else if (args[i] === '--round') opts.round = args[++i]; else if (args[i] === '--frozen') opts.frozen = true; else if (args[i] === '--key-id') opts.keyId = args[++i]; else pos.push(args[i]); }
  if (pos.length < 2) { console.error('사용: node haru/sheet-build.mjs <pack.json> <outDir> [--title T] [--round R] [--frozen] [--key-id ID]'); process.exit(2); }
  opts.atoms = require('./atoms.json');
  const out = build(JSON.parse(fs.readFileSync(pos[0], 'utf8')), pos[1], opts);
  console.log(out.exam, out.answers, out.paperkey);
}
