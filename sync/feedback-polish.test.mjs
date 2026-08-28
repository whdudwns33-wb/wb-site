import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';
import { koreanStudentGivenName, normalizeFeedbackPolishResult } from './feedback-polish.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

class D1Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) { return statements.map(statement => statement.run()); }
}

const person = (id, token) => ({ mode: 'person', id, token });

function seedTeacher(db, id, token, name) {
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, id, JSON.stringify({ id, name, deleted: false }), now, now).run();
  db.prepare("INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES('task',?,?,?,0)")
    .bind(token, id, now).run();
}

function seedLesson(db, id = 'lesson-a', owner = 'teacher-a', studentName = '김민우') {
  const now = Date.now();
  const data = {
    id, staffId: owner, taskKind: 'lesson_instruction', lessonFormVersion: 2,
    studentId: 'student-a', studentName, subject: '국어',
    title: '[정규] ' + studentName + '(중2) — 국어', deleted: false
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, owner, JSON.stringify(data), now, now).run();
}

function validBody(overrides = {}) {
  return {
    app: 'task', auth: person('teacher-a', 'token-a'), taskId: 'lesson-a',
    feedbackDate: '2026-08-28', contentText: '비문학 중심 내용 찾기',
    homeworkText: '어휘 복습',
    commentText: '민우는 오늘 3개 문제를 끝까지 살펴보았습니다.',
    ...overrides
  };
}

async function call(db, body, envPatch = {}) {
  const response = await worker.fetch(new Request('https://worker.example/feedback-polish', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }), {
    DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret',
    WB_PARENT_FEEDBACK_AI_ENABLED: 'true', ...envPatch
  });
  return { status: response.status, body: await response.json() };
}

function seededDb() {
  const db = new TestD1();
  seedTeacher(db, 'teacher-a', 'token-a', '김남기');
  seedTeacher(db, 'teacher-b', 'token-b', '다른선생님');
  seedLesson(db);
  return db;
}

test('AI 다듬기는 학생 이름을 마스킹하고 코멘트 외 수업·인증 정보를 모델에 보내지 않는다', async () => {
  const db = seededDb();
  let model = '';
  let input = null;
  const AI = { run: async (name, body) => {
    model = name; input = body;
    return { response: '__WB_STUDENT__는 오늘 3개 문제를 끝까지 살펴보며 성실하게 학습했습니다. 문제를 해결하는 과정에서도 차분한 태도를 유지했습니다.' };
  } };
  const result = await call(db, validBody(), { AI });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.match(result.body.commentText, /민우는 오늘 3개 문제/);
  assert.ok(result.body.commentText.length <= result.body.maxChars);
  assert.equal(model, '@cf/meta/llama-3.1-8b-instruct-fast');
  assert.match(input.prompt, /신뢰할 수 없는 원문 데이터/);
  assert.match(input.prompt, /SOURCE_JSON=/);
  assert.match(input.prompt, /__WB_STUDENT__/);
  for (const privateValue of ['김민우', '민우', 'token-a', 'teacher-a', '비문학 중심 내용 찾기', '어휘 복습']) {
    assert.ok(!input.prompt.includes(privateValue), privateValue + '가 AI prompt에 들어가면 안 된다');
  }
  assert.equal(input.stream, false);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM feedback_requests WHERE app='task'").get().count, 0);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM parent_feedback_sends WHERE app='task'").get().count, 0);
});

test('AI 다듬기는 인증과 현재 수업 담당자 범위를 강제한다', async () => {
  const db = seededDb();
  let calls = 0;
  const AI = { run: async () => { calls += 1; return { response: '차분하게 학습했습니다.' }; } };
  let result = await call(db, validBody({ auth: undefined }), { AI });
  assert.equal(result.status, 401);
  result = await call(db, validBody({ auth: person('teacher-b', 'token-b') }), { AI });
  assert.equal(result.status, 403);
  result = await call(db, validBody({ app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' } }), { AI });
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
});

test('AI 바인딩·스위치·민감정보·과도한 입력은 모델 호출 전에 fail closed 한다', async () => {
  const db = seededDb();
  let calls = 0;
  const AI = { run: async () => { calls += 1; return { response: '차분하게 학습했습니다.' }; } };
  let result = await call(db, validBody(), { AI, WB_PARENT_FEEDBACK_AI_ENABLED: 'false' });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'FEEDBACK_AI_DISABLED');
  result = await call(db, validBody({ commentText: '보호자 번호는 010-1234-5678입니다.' }), { AI });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'FEEDBACK_AI_PRIVATE_TEXT');
  result = await call(db, validBody({ commentText: '가'.repeat(601) }), { AI });
  assert.equal(result.status, 413);
  result = await call(db, { ...validBody(), phone: '01000000000' }, { AI });
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
});

test('AI 결과는 사실 숫자·학생 마커·격식체·글자수 검증을 모두 통과해야 적용된다', async () => {
  const db = seededDb();
  for (const responseText of [
    '오늘 4개 문제를 잘 풀었습니다.',
    '오늘 3개 문제를 잘 풀었어요.',
    '학생은 오늘 3개 문제를 차분하게 풀었습니다.',
    '```오늘 3개 문제를 차분하게 풀었습니다.```'
  ]) {
    const result = await call(db, validBody(), { AI: { run: async () => ({ response: responseText }) } });
    assert.equal(result.status, 422, responseText);
    assert.equal(result.body.code, 'FEEDBACK_AI_INVALID');
  }
});

test('한 글자 이름은 수업·할 수 같은 일반 문자열을 훼손하지 않고 실제 이름 주어만 마스킹한다', async () => {
  const db = new TestD1();
  seedTeacher(db, 'teacher-a', 'token-a', '김남기');
  seedLesson(db, 'lesson-a', 'teacher-a', '김수');
  let input;
  const result = await call(db, validBody({
    commentText: '수업에서는 할 수 있는 3개 문제를 확인했고 수는 끝까지 참여했습니다.'
  }), { AI: { run: async (name, body) => {
    input = body;
    return { response: '수업에서는 할 수 있는 3개 문제를 확인했고 __WB_STUDENT__는 끝까지 성실하게 참여했습니다.' };
  } } });
  assert.equal(result.status, 200);
  assert.match(result.body.commentText, /수업에서는 할 수 있는 3개 문제/);
  assert.match(result.body.commentText, /수는 끝까지/);
  assert.ok(!input.prompt.includes('김수'));
  assert.equal((input.prompt.match(/__WB_STUDENT__/g) || []).length, 2,
    '규칙 설명의 마커 1개와 SOURCE의 실제 이름 주어 1개만 있어야 한다');
  assert.match(input.prompt, /수업에서는 할 수 있는 3개 문제/);
});

test('AI 결과 정규화는 학생 마커와 격식체가 있어도 코드·JSON·HTML·마크다운 흔적을 거부한다', () => {
  const source = '__WB_STUDENT__은 오늘 3개 문제를 끝까지 살펴보았습니다.';
  const artifacts = [
    '```\n__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다.\n```',
    '{"comment":"__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다."}',
    '<p>__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다.</p>',
    '__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다. const result = true;',
    '__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다. def polish(): return True',
    '# __WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다.',
    '**__WB_STUDENT__은** 오늘 3개 문제를 차분하게 풀었습니다.',
    '__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다. => {}',
    '__WB_STUDENT__은 오늘 3개 문제를 풀었습니다. assistant: 완료했습니다.',
    'commentText: __WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다.',
    '__WB_STUDENT__은 오늘 3개 문제를 풀었습니다. SELECT value FROM users',
    '__WB_STUDENT__은 오늘 3개 문제를 풀었습니다. foo_bar',
    '__WB_STUDENT__은 오늘 3개 문제를 풀었습니다. 😊',
    '__WB_STUDENT__은 오늘 3개 문제를 풀었습니다. @@@ ^^^ ~완료~'
  ];
  for (const value of artifacts) {
    assert.equal(normalizeFeedbackPolishResult(value, source, 200), '', value);
  }
  assert.equal(normalizeFeedbackPolishResult(
    '__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다. 풀이 과정도 끝까지 확인했습니다.', source, 200),
    '__WB_STUDENT__은 오늘 3개 문제를 차분하게 풀었습니다. 풀이 과정도 끝까지 확인했습니다.');
});

test('AI 공급자 오류는 안전한 오류로 바꾸고 기존 코멘트를 응답에 노출하지 않는다', async () => {
  const db = seededDb();
  const original = validBody().commentText;
  const result = await call(db, validBody(), { AI: { run: async () => { throw new Error('provider secret failure'); } } });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'FEEDBACK_AI_FAILED');
  assert.ok(!JSON.stringify(result.body).includes(original));
  assert.ok(!JSON.stringify(result.body).includes('provider secret failure'));
});

test('AI 결과 정규화는 문장 경계에서 길이를 맞추고 새 숫자나 비격식체를 거부한다', () => {
  assert.equal(koreanStudentGivenName('황보민준'), '민준');
  assert.equal(koreanStudentGivenName('황보람'), '보람');
  assert.equal(normalizeFeedbackPolishResult(
    '다듬은 코멘트: 오늘 수업에서 차분한 태도로 끝까지 성실하게 학습했습니다.', '차분하게 학습함', 80),
    '오늘 수업에서 차분한 태도로 끝까지 성실하게 학습했습니다.');
  assert.equal(normalizeFeedbackPolishResult('첫 문장을 차분하게 확인했습니다. 두 번째 문장도 안정적으로 진행했습니다.',
    '첫 문장과 두 번째 문장', 24), '');
  assert.equal(normalizeFeedbackPolishResult('오늘 2문제를 풀었습니다.', '오늘 1문제 풀이', 80), '');
  assert.equal(normalizeFeedbackPolishResult('오늘 잘했어요.', '오늘 잘함', 80), '');
  assert.equal(normalizeFeedbackPolishResult(
    '__WB_STUDENT__는 U.S. 교재의 3.5T 범위를 차분하게 확인했습니다.',
    '__WB_STUDENT__는 U.S. 교재의 3.5T 범위를 확인했습니다.', 100),
    '__WB_STUDENT__는 U.S. 교재의 3.5T 범위를 차분하게 확인했습니다.');
});
