import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { questionBankResult } from './question-bank.js';
const env = { QUESTION_BANK_ACCOUNTS: JSON.stringify([
  { key: 'sample', name: '창작 예시', account: 'fictional-user', password: 'fixture-only', agency: 'fictional-agency' }
]) };
test('목록은 비밀번호를 빼고 인증된 직원에게만 반환한다', () => {
  const body = { app: 'task', action: 'list' };
  assert.equal(questionBankResult(env, body, null).status, 401);
  for (const auth of [{ scope: 'all' }, { scope: 'own', id: 'staff-example' }]) {
    const result = questionBankResult(env, body, auth);
    assert.equal(result.status, 200);
    assert.equal(result.data.items[0].agency, 'fictional-agency');
    assert.equal(JSON.stringify(result).includes('fixture-only'), false);
  }
});
test('비밀번호 보기는 요청한 계정만 반환하며 설정 오류에 원문을 노출하지 않는다', () => {
  const auth = { scope: 'all' };
  assert.deepEqual(questionBankResult(env, { app: 'task', action: 'reveal', key: 'sample' }, auth).data,
    { ok: true, password: 'fixture-only' });
  assert.equal(questionBankResult(env, { app: 'task', action: 'reveal', key: 'missing' }, auth).status, 404);
  assert.equal(questionBankResult(env, { app: 'consult', action: 'list' }, auth).status, 400);
  const result = questionBankResult({ QUESTION_BANK_ACCOUNTS: 'invalid-sensitive-fixture' }, { app: 'task', action: 'list' }, auth);
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes('invalid-sensitive-fixture'), false);
});
test('서버 경로는 근무 로그인 검사 뒤 인증을 재검사하고 응답 캐시를 금지한다', () => {
  const source = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
  const route = source.indexOf("if (url.pathname === '/question-bank')");
  assert.ok(route > source.indexOf("if (app === 'task' && body.auth && body.auth.mode === 'person' && staffWorkLoginEnabled(env))"));
  const block = source.slice(route, source.indexOf("\n      if (", route + 10));
  assert.match(block, /await resolveAuth/);
  assert.match(block, /driver_facility/);
  assert.match(block, /no-store, private/);
});
