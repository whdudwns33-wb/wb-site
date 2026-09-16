// 진도표 → plan:<cohort>.days 생성 (설계안 v1 §5-5 · 진도계획 §7). CLI: node haru/plan-build.mjs <input.json> [out.json]
// 일정(milestones)은 facts.json 에서만 생성한다 — 정본에 없는 값을 코드가 먼저 갖지 않는다(정본 규칙 6).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86400000;
const here = path.dirname(fileURLToPath(import.meta.url));
export const FACTS = JSON.parse(fs.readFileSync(path.join(here, 'facts.json'), 'utf8'));

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const utc = (d) => Date.parse(d + 'T00:00:00Z');
const dow = (d) => new Date(utc(d)).getUTCDay();   // 0 일 … 6 토

/* 요강 일정 → aud:'parent' 마일스톤. 원서·서류·수험표·발표는 부모 화면 항목이지 학생 항목이 아니다. */
export function milestonesFromFacts(facts, extra) {
  const S = facts.schedule, day = (s) => s.slice(0, 10), hm = (s) => (s.length > 10 ? s.slice(11, 16) : null);
  const m = [
    { d: day(S.formsPublished), aud: 'parent', text: '제출 서류 양식 홈페이지 원서접수 배너에서 공개' },
    { d: day(S.briefing), aud: 'parent', at: hm(S.briefing), text: '입학설명회 ' + hm(S.briefing) + ' 본교 대강당' },
    { d: day(S.apply[0]), aud: 'parent', at: hm(S.apply[0]), text: '원서접수 시작 (인터넷, 전형료 ' + facts.schedule.fee.toLocaleString('ko-KR') + '원) — 서류 제출과 다른 기간' },
    { d: day(S.apply[1]), aud: 'parent', at: hm(S.apply[1]), text: '원서접수 마감 ' + hm(S.apply[1]) },
    { d: day(S.docs[0]), aud: 'parent', at: hm(S.docs[0]), text: '서류 제출 시작 · 학교생활기록부Ⅱ(최근 한 달 내 출력, 상단에 접수번호) · 삼육 교육 동의서 미제출 시 응시 불가' },
    { d: day(S.docs[1]), aud: 'parent', at: hm(S.docs[1]), text: '서류 제출 마감 ' + hm(S.docs[1]) + ' (우체국 소인까지)' },
    { d: day(S.ticket[0]), aud: 'parent', at: hm(S.ticket[0]), text: '수험표 출력 시작 — 본인 직접 출력, 지참해야 입실' },
    { d: facts.exam.date, aud: 'both', at: facts.exam.arriveBy, text: facts.exam.arriveBy + '까지 고사장 입실' },
    { d: day(S.announce[0]), aud: 'parent', at: hm(S.announce[0]), text: '합격자 발표 ' + hm(S.announce[0]) + ' — 오늘은 아무것도 안 하셔도 됩니다' },
    { d: S.enroll[0], aud: 'parent', text: '합격자 등록 ' + S.enroll[0] + ' ~ ' + S.enroll[1] }
  ];
  return m.concat(extra || []).sort((a, b) => a.d.localeCompare(b.d));
}

const p4Sub = (dd) => (dd >= 29 ? 'rebuild' : dd >= 15 ? 'mix' : dd >= 8 ? 'narrow' : 'settle');

export function buildPlan(input, facts) {
  facts = facts || FACTS;
  const exam = input.examDate, examT = utc(exam);
  const start = input.phases[0].from, end = ymd(examT + (input.retainDays || 30) * DAY);
  const rest = new Set(input.rest || []);
  const mocks = {}; (input.mocks || []).forEach((m) => { mocks[m.d] = m; });
  const monthOpen = input.monthOpen || {};
  const days = [];
  for (let t = utc(start); t <= utc(end); t += DAY) {
    const d = ymd(t), dd = Math.round((examT - t) / DAY), w = dow(d);
    const ph = input.phases.find((p) => d >= p.from && d <= p.to);
    const entry = { d, dday: dd };
    if (d > exam) { entry.phase = 'p5'; entry.kind = 'retro'; days.push(entry); continue; }
    if (d === exam) { entry.phase = 'p5'; entry.kind = 'exam'; entry.lockAt = input.lockAt || '12:00'; days.push(entry); continue; }
    entry.phase = ph ? ph.id : null;
    if (mocks[d]) {
      const m = mocks[d];
      if (rest.has(d)) throw new Error('회차가 휴일과 겹친다: ' + d);
      Object.assign(entry, { kind: 'mock', keyId: m.keyId, subjects: m.subjects, startAt: m.startAt || '09:00', app: !!m.app, note: m.note });
      if (m.retakeKeyId) entry.retakeKeyId = m.retakeKeyId;
    } else if (rest.has(d)) {
      entry.kind = 'rest'; if (input.restNote && input.restNote[d]) entry.note = input.restNote[d];
    } else if (w === 0 || w === 6) {
      entry.kind = 'rest'; entry.note = '주말';
    } else if (input.cardStart && d < input.cardStart) {
      entry.kind = 'prep'; entry.note = '앱 없음 — 종이·등록·동의서';
    } else if ((input.passageDays || []).includes(w) && entry.phase !== 'p1') {
      entry.kind = 'passage';
    } else {
      entry.kind = 'card';
    }
    if (entry.phase === 'p4' && entry.kind !== 'rest') { entry.sub = p4Sub(dd); entry.mode = entry.sub === 'rebuild' ? 'block' : 'mixed'; if (dd <= 14) entry.freezeNew = true; }
    if (entry.phase && entry.phase !== 'p1' && w === (input.envelopeDay == null ? 1 : input.envelopeDay) && entry.kind === 'card') entry.envelope = true;
    const mo = monthOpen[d.slice(0, 7)]; if (mo && d.slice(8) === '01') entry.openAtoms = mo;
    days.push(entry);
  }
  const plan = {
    cohort: input.cohort, examDate: exam, examDateStatus: input.examDateStatus || 'assumed', lockAt: input.lockAt || '12:00',
    retainDays: input.retainDays || 30, numbersOpenDays: input.numbersOpenDays == null ? 7 : input.numbersOpenDays,
    order: input.order || ['kor', 'math', 'eng'], phases: input.phases, bands: input.bands || {}, frozenKeyId: input.frozenKeyId || null,
    bed: input.bed || { base: '23:45', target: '22:00', days: 7 },
    coreAtoms: 'coreByPhase', days, milestones: milestonesFromFacts(facts, input.extraMilestones),
    notice: facts.notice, builtFrom: { facts: facts.docVersion, admissionYear: facts.admissionYear }
  };
  validate(plan);
  return plan;
}

export function validate(plan) {
  const errs = [];
  for (let i = 1; i < plan.days.length; i++) if (utc(plan.days[i].d) - utc(plan.days[i - 1].d) !== DAY) errs.push('날짜 불연속 ' + plan.days[i - 1].d + ' → ' + plan.days[i].d);
  plan.days.forEach((e) => { if (e.kind === 'mock' && e.note && /휴일/.test(e.note)) errs.push('휴일 회차 ' + e.d); });
  const examIdx = plan.days.findIndex((e) => e.kind === 'exam');
  if (examIdx < 0) errs.push('시험일 없음');
  if (plan.days.some((e, i) => i > examIdx && e.kind !== 'retro')) errs.push('시험 뒤에 카드가 있다');
  if (!plan.milestones.some((m) => m.aud === 'both')) errs.push('입실 마일스톤 없음');
  if (errs.length) throw new Error(errs.join('; '));
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath) { console.error('사용: node haru/plan-build.mjs <input.json> [out.json]'); process.exit(2); }
  const plan = buildPlan(JSON.parse(fs.readFileSync(inPath, 'utf8')));
  const out = outPath || inPath.replace(/\.input\.json$/, '.json');
  fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
  const kinds = {}; plan.days.forEach((e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
  console.log(out, plan.days.length + '일', JSON.stringify(kinds));
}
