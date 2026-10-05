'use strict';
/* 관리 화면 공용 로그인 — 순수 부분(몸통 만들기·빈 칸 막기·폼 문자열)과
   화면 12장이 정말 이 모듈을 쓰는지 정적 검사. 로그인은 한 번 깨지면 관리 화면 전체가
   막히는 자리라, 갈래가 한 장이라도 빠지면 여기서 잡는다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const L = require('./admin-login.js');
let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name); };

t('아이디 갈래는 id·password 를, PIN 갈래는 pin 만 보낸다 (서버가 이 키로 갈래를 가른다)', () => {
  assert.deepEqual(L.body(L.ACCOUNT, { id: 'wb', password: 'pw' }), { id: 'wb', password: 'pw' });
  assert.deepEqual(L.body(L.PIN, { pin: '1234' }), { pin: '1234' });
  /* PIN 갈래에 id 가 섞이면 서버가 아이디 갈래로 보고 no-account 를 돌려준다 */
  assert.deepEqual(Object.keys(L.body(L.PIN, { pin: 'p', id: 'wb' })), ['pin']);
});

t('빠진 값은 undefined·null 이어도 빈 문자열이 된다 (문자열 undefined 가 서버로 가지 않게)', () => {
  assert.deepEqual(L.body(L.ACCOUNT, {}), { id: '', password: '' });
  assert.deepEqual(L.body(L.PIN, {}), { pin: '' });
});

t('빈 칸은 서버까지 보내지 않는다 — 실패 횟수만 축내고 잠금에 가까워진다', () => {
  assert.match(L.missing(L.ACCOUNT, { id: '', password: 'pw' }), /아이디/);
  assert.match(L.missing(L.ACCOUNT, { id: 'wb', password: '' }), /비밀번호/);
  assert.match(L.missing(L.PIN, { pin: '' }), /PIN/);
  assert.equal(L.missing(L.ACCOUNT, { id: 'wb', password: 'pw' }), '');
  assert.equal(L.missing(L.PIN, { pin: '1234' }), '');
});

t('아이디 갈래 폼은 비밀번호 관리자가 알아보는 칸을 쓴다', () => {
  const h = L.formHtml(L.ACCOUNT, '', {});
  assert.match(h, /autocomplete="username"/);
  assert.match(h, /autocomplete="current-password"/);
  assert.match(h, /<form/, 'form 이라야 브라우저가 저장·자동입력을 건다');
  assert.match(h, /PIN 으로 로그인/, 'PIN 갈래로 건너가는 길이 있어야 한다');
});

t('PIN 갈래 폼에는 아이디 칸이 없고 되돌아가는 길이 있다', () => {
  const h = L.formHtml(L.PIN, '', {});
  assert.doesNotMatch(h, /name="username"/);
  assert.match(h, /아이디·비밀번호로 로그인/);
});

t('오류 문구는 그대로 그리지 않고 이스케이프한다', () => {
  const h = L.formHtml(L.ACCOUNT, '<img src=x onerror=alert(1)>', {});
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
});

t('버튼 class 는 화면마다 다르므로 받아 쓴다', () => {
  assert.match(L.formHtml(L.ACCOUNT, '', { btn: 'primary' }), /class="primary"/);
  assert.match(L.formHtml(L.ACCOUNT, '', {}), /class="btn"/, '안 주면 btn');
});

/* ── 화면 12장이 이 모듈을 쓰는가 ── */
const PAGES = fs.readdirSync(DIR).filter((f) => f.endsWith('.html'));
t('관리 화면이 한 장도 빠짐없이 공용 로그인을 쓴다 (PIN 폼을 따로 그리지 않는다)', () => {
  assert.ok(PAGES.length >= 12, '관리 화면이 12장 이상이어야 한다: ' + PAGES.length);
  const missing = [];
  const bespoke = [];
  for (const f of PAGES) {
    const s = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (!/admin-login\.js/.test(s) || !/WBAdminLogin\.mount/.test(s)) missing.push(f);
    /* 옛 방식의 흔적 — 자기 PIN 칸을 그리거나 로그인 몸통을 직접 만들면 갈래가 엇갈린다 */
    if (/id="pin"/.test(s) || /JSON\.stringify\(\{\s*pin:/.test(s)) bespoke.push(f);
  }
  assert.deepEqual(missing, [], '공용 로그인을 안 쓰는 화면: ' + missing.join(', '));
  assert.deepEqual(bespoke, [], '자기 PIN 폼이 남은 화면: ' + bespoke.join(', '));
});

t('admin-login.js 가 배포본 복사 목록에 있다 (없으면 운영에서 404 로 로그인 자체가 막힌다)', () => {
  const build = fs.readFileSync(path.join(DIR, '..', 'build-dist.mjs'), 'utf8');
  assert.match(build, /'admin-login\.js'/);
});

console.log('\n' + n + '건 통과 — reading-server/public/admin-login.js');
