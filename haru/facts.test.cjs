'use strict';
/* facts.json 은 정본(사람 문서)과 같은 값이어야 한다 — 값의 형태와 내적 일관성만 여기서 잡는다. */
const assert = require('node:assert/strict');
const F = require('./facts.json');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const ts = s => Date.parse(s.length === 10 ? s + 'T00:00:00+09:00' : s + ':00+09:00');

t('배점 — 일반 330, 특별 430, 동점자 국→수→영', () => {
  const s = F.scoring;
  assert.equal(s.kor + s.math + s.eng + s.doc, s.generalTotal);
  assert.equal(s.generalTotal + s.bible, s.specialTotal);
  assert.deepEqual(s.tieBreak, ['kor', 'math', 'eng']);
});
t('정원 합 122', () => {
  const q = F.quota;
  assert.equal(q.general + q.sda1 + q.sda2 + q.leader + q.intl + q.social, q.total);
});
t('교시 — 3과목 각 40분 25문항 4점, 순서 국→수→영', () => {
  assert.equal(F.exam.periods.length, 3);
  assert.deepEqual(F.exam.periods.map(p => p.subject), ['kor', 'math', 'eng']);
  F.exam.periods.forEach(p => { assert.equal(p.min, 40); assert.equal(p.items, 25); assert.equal(p.items * p.pointsPerItem, 100); });
});
t('일정이 시간순', () => {
  const S = F.schedule;
  const seq = [S.notice, S.formsPublished, S.briefing, S.apply[0], S.apply[1], S.docs[0], S.docs[1], S.ticket[0], F.exam.date, S.announce[0], S.enroll[0], S.enroll[1]];
  for (let i = 1; i < seq.length; i++) assert.ok(ts(seq[i]) >= ts(seq[i - 1]), seq[i - 1] + ' → ' + seq[i]);
  assert.ok(ts(S.apply[1]) < ts(S.docs[0]), '원서와 서류는 다른 기간');
});
t('듣기는 확정으로 적지 않는다 · 경쟁률은 unverified 에만', () => {
  assert.equal(F.exam.listening, 'unspecified');
  assert.ok(F.unverified.applicants.includes('추정'));
  assert.ok(!('applicants' in F.exam));
});
t('학교 URL 이 있고 학교명이 앱 이름에 쓰이지 않는다', () => {
  assert.ok(/^https:\/\//.test(F.school.url));
  assert.ok(!/haru|하루/.test(F.school.name));
});
/* 상시 고지는 기획서 §4 의 세 문장 그대로다. 홈페이지 주소만은 정본 v1.2 의 현재 주소(school.url)를 따른다 —
   설계안 v1 이 "고지의 링크는 facts.json.school.url 에서 읽는다"로 정했다(구 주소는 리다이렉트). */
t('상시 고지 — 제휴 없음 · 공식 정보는 학교 홈페이지와 요강 · 요강 기준일, 주소는 school.url 과 같다', () => {
  assert.ok(F.notice.includes('사설 학습 도구') && F.notice.includes('제휴·후원 관계도 없습니다'));
  assert.ok(F.notice.includes('학교 홈페이지(' + new URL(F.school.url).host + ')와 모집요강에서 확인하십시오'));
  assert.ok(F.notice.includes(F.admissionYear + '학년도 모집요강(' + F.schedule.notice + ' 공고) 기준'));
});
console.log(n + ' tests passed');
