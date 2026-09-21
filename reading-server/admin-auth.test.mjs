'use strict';
/* 관리 로그인 판정 검증 (node reading-server/admin-auth.test.mjs) */
import assert from 'node:assert/strict';
import { checkAdminLogin, safeEqual, LOGIN_ERRORS } from './admin-auth.mjs';
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };
const ENV = { ADMIN_PIN: 'pin-1234', ADMIN_ID: 'wb-teacher', ADMIN_PASSWORD: 'correct horse battery' };

console.log('admin-auth — 관리 로그인');

await t('safeEqual — 같은 문자열만 참, 빈 값·문자열 아닌 값은 거짓', async () => {
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('abc', 'abcd'), false);
  assert.equal(await safeEqual('', ''), false, '빈 값끼리도 거짓 — 설정이 빠진 채 빈 입력이 통과하면 안 된다');
  assert.equal(await safeEqual(undefined, 'undefined'), false, '설정이 없을 때 문자열 undefined 로 못 들어온다');
  assert.equal(await safeEqual(1234, '1234'), false);
  assert.equal(await safeEqual('한글 비밀번호', '한글 비밀번호'), true);
});

await t('PIN — id 없이 pin 만 오면 PIN 갈래, 숫자로 와도 문자열로 비교', async () => {
  assert.deepEqual(await checkAdminLogin({ pin: 'pin-1234' }, ENV), { ok: true, via: 'pin' });
  assert.deepEqual(await checkAdminLogin({ pin: 1234 }, { ADMIN_PIN: '1234' }), { ok: true, via: 'pin' });
  const bad = await checkAdminLogin({ pin: 'nope' }, ENV);
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'bad-pin'); assert.equal(bad.error, LOGIN_ERRORS['bad-pin']);
  assert.equal((await checkAdminLogin({}, ENV)).reason, 'bad-pin', '빈 요청은 PIN 실패');
  assert.equal((await checkAdminLogin(null, ENV)).reason, 'bad-pin');
  assert.equal((await checkAdminLogin({ pin: '' }, { ADMIN_PIN: '' })).ok, false, 'PIN 미설정이면 빈 PIN 으로도 못 들어온다');
  assert.equal((await checkAdminLogin({ pin: 'x' }, {})).ok, false);
});

await t('아이디·비밀번호 — 둘 다 맞아야 통과, 아이디는 앞뒤 공백을 무시, 비밀번호는 그대로', async () => {
  assert.deepEqual(await checkAdminLogin({ id: 'wb-teacher', password: 'correct horse battery' }, ENV), { ok: true, via: 'account' });
  assert.deepEqual(await checkAdminLogin({ id: '  wb-teacher ', password: 'correct horse battery' }, ENV), { ok: true, via: 'account' });
  for (const body of [
    { id: 'wb-teacher', password: 'correct horse battery ' },
    { id: 'WB-teacher', password: 'correct horse battery' },
    { id: 'wb-teacher', password: '' },
    { id: '', password: 'correct horse battery' },
    { id: 'wb-teacher' },
    { password: 'correct horse battery' },
    { id: ['wb-teacher'], password: 'correct horse battery' },
  ]) {
    const r = await checkAdminLogin(body, ENV);
    assert.equal(r.ok, false, JSON.stringify(body)); assert.equal(r.reason, 'bad-account'); assert.equal(r.error, LOGIN_ERRORS['bad-account']);
  }
  /* id 가 오면 PIN 이 같이 와도 아이디 갈래다 — PIN 을 붙여서 아이디 검사를 건너뛰지 못한다 */
  assert.equal((await checkAdminLogin({ id: 'x', password: 'y', pin: 'pin-1234' }, ENV)).reason, 'bad-account');
});

await t('아이디 로그인 미설정 — 시크릿이 하나라도 없으면 no-account 로 안내하고, PIN 갈래는 그대로 산다', async () => {
  for (const env of [{ ADMIN_PIN: 'p' }, { ADMIN_PIN: 'p', ADMIN_ID: 'a' }, { ADMIN_PIN: 'p', ADMIN_PASSWORD: 'b' }, { ADMIN_PIN: 'p', ADMIN_ID: '', ADMIN_PASSWORD: 'b' }]) {
    const r = await checkAdminLogin({ id: 'a', password: 'b' }, env);
    assert.equal(r.ok, false); assert.equal(r.reason, 'no-account'); assert.equal(r.error, LOGIN_ERRORS['no-account']);
    assert.deepEqual(await checkAdminLogin({ pin: 'p' }, env), { ok: true, via: 'pin' });
  }
});

console.log(`admin-auth: ${passed} passed`);
