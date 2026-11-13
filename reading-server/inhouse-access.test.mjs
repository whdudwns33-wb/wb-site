'use strict';
import assert from 'node:assert/strict';
import { createInhouseAccess } from './inhouse-access.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const req = (peer, headers = {}, rawHeaders) => ({ socket: { remoteAddress: peer }, headers, rawHeaders });

t('허용망 미설정은 로컬만 — IPv4·IPv6·IPv4-mapped loopback, 실제 LAN·외부는 거절', () => {
  const allow = createInhouseAccess();
  for (const peer of ['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])
    assert.equal(allow(req(peer, { host: 'localhost:8890' })), true, peer);
  for (const peer of ['192.168.10.20', '203.0.113.25', '2001:db8::1', '', undefined])
    assert.equal(allow(req(peer, { host: 'localhost:8890' })), false, String(peer));
  assert.equal(allow(undefined), false);
});

t('잘못된 허용망은 초기화 실패 — /0·범위 밖 prefix·비IP·불완전 CIDR·빈 토큰', () => {
  for (const value of ['0.0.0.0/0', '::/0', '192.168.1.0/33', '2001:db8::/129', '192.168.1.0/-1',
    '192.168.1.0/24.0', '192.168.1.0/', '192.168.1.0/24/7', 'localhost', '127.1', '0127.0.0.1',
    'fe80::1%5', '192.168.1.0/24,', ',', null, 123]) assert.throws(() => createInhouseAccess(value), /원내 허용망/, String(value));
});

t('IPv4 정확 주소·CIDR는 native 경계와 mapped IPv6까지 매칭', () => {
  const allow = createInhouseAccess(' 203.0.113.25 , 192.168.10.1/24 ');
  for (const peer of ['203.0.113.25', '192.168.10.0', '192.168.10.255', '::ffff:192.168.10.20', '::ffff:c0a8:a14'])
    assert.equal(allow(req(peer)), true, peer);
  for (const peer of ['203.0.113.26', '192.168.9.255', '192.168.11.0', '::ffff:192.168.11.1'])
    assert.equal(allow(req(peer)), false, peer);
});

t('IPv6 정확 주소·CIDR는 압축·대소문자와 prefix 경계를 native로 판정', () => {
  const allow = createInhouseAccess('2001:db8:abcd::/48,2001:db8:1::9');
  for (const peer of ['2001:DB8:ABCD::7', '2001:db8:abcd:ffff:ffff:ffff:ffff:ffff', '2001:0db8:0001:0000:0000:0000:0000:0009'])
    assert.equal(allow(req(peer)), true, peer);
  for (const peer of ['2001:db8:abce::1', '2001:db8:1::10']) assert.equal(allow(req(peer)), false, peer);
});

t('직접 LAN·외부 연결은 실제 socket IP만 — CF·X-Forwarded-For 위조로 허용되지 않음', () => {
  const allow = createInhouseAccess('192.168.10.0/24');
  const spoof = { host: 'localhost:8890', 'cf-connecting-ip': '192.168.10.20', 'x-forwarded-for': '192.168.10.20' };
  assert.equal(allow(req('203.0.113.7', spoof)), false);
  assert.equal(allow(req('192.168.10.20', { 'cf-connecting-ip': 'not-an-ip' })), true, '직접 연결의 CF 헤더는 아예 믿지 않는다');
  assert.equal(allow(req('127.0.0.1', { host: 'academy.example', 'x-forwarded-for': '192.168.10.20' })), false);
});

t('localhost 터널은 단일 CF 실제 IP가 등록 허용망에 속할 때만 — malformed·중복은 거절', () => {
  const allow = createInhouseAccess('203.0.113.25');
  assert.equal(allow(req('127.0.0.1', { host: 'academy.example', 'cf-connecting-ip': '203.0.113.25' })), true);
  for (const ip of ['203.0.113.26', '203.0.113.25, 203.0.113.25', ' 203.0.113.25', '203.0.113.25:80', '', null, ['203.0.113.25']])
    assert.equal(allow(req('::ffff:127.0.0.1', { 'cf-connecting-ip': ip })), false, JSON.stringify(ip));
  assert.equal(allow(req('::1', { 'cf-connecting-ip': '203.0.113.25' },
    ['CF-Connecting-IP', '203.0.113.25', 'cf-connecting-ip', '203.0.113.25'])), false, '같은 값의 raw 중복도 거절');
});

t('CF 방문자 주소가 loopback이면 허용망에 있어도 거절 — 기본 설정은 외부 학생 전부 차단', () => {
  const allow = createInhouseAccess('127.0.0.1,::1');
  for (const ip of ['127.0.0.1', '::1', '::ffff:7f00:1'])
    assert.equal(allow(req('127.0.0.1', { host: 'academy.example', 'cf-connecting-ip': ip })), false, ip);
  assert.equal(createInhouseAccess()(req('127.0.0.1', { host: 'localhost', 'cf-connecting-ip': '203.0.113.25' })), false);
});

t('터널 CF 헤더 누락은 public Host에서 fail closed, literal IP·localhost의 로컬 접속만 허용', () => {
  const allow = createInhouseAccess('203.0.113.25');
  for (const host of ['academy.example', 'academy.example:8890', 'localhost.academy.example'])
    assert.equal(allow(req('127.0.0.1', { host })), false, host);
  for (const host of ['localhost', 'LOCALHOST:8890', '127.0.0.1:8890', '192.168.10.8:8890', '[::1]:8890', '[2001:db8::1]'])
    assert.equal(allow(req('127.0.0.1', { host })), true, host);
});

t('malformed Host는 로컬에서도 거절 — URL의 IPv4 자동 변환·credentials·경로·중복 방지', () => {
  const allow = createInhouseAccess();
  for (const host of ['', '127.1', '2130706433', '0x7f000001', 'user@localhost', 'localhost/path', 'localhost:65536',
    'localhost:', 'localhost:abc', '::1', '[127.0.0.1]', '[fe80::1%5]', ' localhost', 'localhost, localhost', ['localhost']])
    assert.equal(allow(req('127.0.0.1', { host })), false, JSON.stringify(host));
  assert.equal(allow(req('127.0.0.1', { host: 'localhost' }, ['Host', 'localhost', 'host', 'localhost'])), false);
});

console.log('\n통과 ' + passed + '개 — 원내 IP·터널 경계 검증');
