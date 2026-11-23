'use strict';
/* net-get: curl 이 프록시에 막혔을 때만 다른 길로 묻는다 — 망 없이 시험한다. */
import assert from 'node:assert/strict';
import { get, blockedByProxy } from './net-get.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

/* 호출을 세는 가짜 전송로 */
const fake = (codes) => {
  const calls = [];
  const impl = async (url, secs, body) => {
    calls.push({ url, secs, body });
    const c = codes[Math.min(calls.length - 1, codes.length - 1)];
    return { code: c, html: c === '000' ? '' : '<html><body>본문</body></html>' };
  };
  impl.calls = calls;
  return impl;
};
const nosleep = async () => {};

await t('curl 이 대답하면 fetch 를 부르지 않는다', async () => {
  const curl = fake(['200']), fetchImpl = fake(['200']);
  const r = await get('https://x.test/a', { curl, fetchImpl, sleep: nosleep });
  assert.equal(r.via, 'curl');
  assert.equal(r.code, '200');
  assert.equal(curl.calls.length, 1);
  assert.equal(fetchImpl.calls.length, 0, 'curl 이 성공했는데 다른 길로 또 물었다');
});

await t('404·403 은 서버가 대답한 것이므로 그대로 쓴다', async () => {
  for (const code of ['404', '403', '500']) {
    const curl = fake([code]), fetchImpl = fake(['200']);
    const r = await get('https://x.test/a', { curl, fetchImpl, sleep: nosleep });
    assert.equal(r.code, code, code + ' 를 다른 값으로 바꿨다');
    assert.equal(r.via, 'curl');
    assert.equal(fetchImpl.calls.length, 0, code + ' 인데 fetch 로 다시 물었다');
  }
});

await t('curl 이 000 이면 재시도하고, 그래도 000 이면 fetch 로 묻는다', async () => {
  const curl = fake(['000']), fetchImpl = fake(['200']);
  const r = await get('https://x.test/a', { curl, fetchImpl, sleep: nosleep, tries: 3 });
  assert.equal(curl.calls.length, 3, 'tries 만큼 다시 묻지 않았다');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(r.via, 'fetch');
  assert.equal(r.code, '200');
});

await t('재시도 중에 curl 이 살아나면 fetch 는 부르지 않는다', async () => {
  const curl = fake(['000', '200']), fetchImpl = fake(['200']);
  const r = await get('https://x.test/a', { curl, fetchImpl, sleep: nosleep, tries: 3 });
  assert.equal(curl.calls.length, 2);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(r.via, 'curl');
});

await t('둘 다 못 받으면 그때야 응답 없음이다', async () => {
  const curl = fake(['000']), fetchImpl = fake(['000']);
  const r = await get('https://x.test/a', { curl, fetchImpl, sleep: nosleep, tries: 2 });
  assert.equal(r.via, 'none');
  assert.equal(r.code, '000');
  assert.equal(r.html, '');
});

await t('본문을 달라고 하면 두 길 모두에 그대로 전한다', async () => {
  const curl = fake(['000']), fetchImpl = fake(['200']);
  const r = await get('https://x.test/a', { curl, fetchImpl, sleep: nosleep, tries: 1, body: true, secs: 40 });
  assert.equal(curl.calls[0].body, true);
  assert.equal(fetchImpl.calls[0].body, true);
  assert.equal(curl.calls[0].secs, 40);
  assert.ok(r.html.includes('본문'));
});

await t('막힌 길의 표시는 000 하나뿐이다', () => {
  assert.equal(blockedByProxy('000'), true);
  assert.equal(blockedByProxy(' 000 '), true);
  for (const c of ['200', '404', '403', '429', '500', '']) assert.equal(blockedByProxy(c), false, c);
});

console.log('OK — net-get ' + n + '/7');

/* ── 글자 인코딩 ─────────────────────────────────────────────────────────
   EUC-KR 로 보내는 연구기관 누리집이 있어(2026-11-23 www.kribb.re.kr) UTF-8 로
   읽으면 한글이 깨지고, 그러면 srccheck 가 멀쩡한 지면을 본문 미확인으로 떨어뜨린다. */
import { decode } from './net-get.mjs';

let m = 0;
const t2 = (name, fn) => { fn(); m++; console.log('  ✓ ' + name); };

/* EUC-KR 바이트를 직접 만든다 — 「한글」 = C7D1 B1DB */
const body = Buffer.from([0xC7, 0xD1, 0xB1, 0xDB]);
const euc = Buffer.concat([
  Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=euc-kr"></head><body>', 'latin1'),
  body,
  Buffer.from('</body></html>', 'latin1'),
]);

t2('지면이 EUC-KR 이라 적어 두면 그 인코딩으로 푼다', () => {
  assert.ok(decode(euc).includes('한글'), 'EUC-KR 한글이 깨졌다');
  /* UTF-8 로 읽으면 같은 바이트가 다른 글자가 된다 — 그래서 고를 줄 알아야 뜻이 있다 */
  assert.notEqual(euc.toString('utf8'), decode(euc));
  assert.ok(!euc.toString('utf8').includes('한글'));
});

t2('charset 을 적지 않으면 UTF-8 로 읽는다', () => {
  const utf8 = Buffer.from('<html><body>나노플라스틱</body></html>', 'utf8');
  assert.ok(decode(utf8).includes('나노플라스틱'));
});

t2('모르는 charset 이면 UTF-8 로 떨어뜨리고 터지지 않는다', () => {
  const odd = Buffer.concat([
    Buffer.from('<meta charset="x-made-up-9999">', 'latin1'),
    Buffer.from('나노', 'utf8'),
  ]);
  assert.ok(decode(odd).includes('나노'));
});

t2('이미 문자열이면 그대로 돌려준다', () => {
  assert.equal(decode('나노'), '나노');
});

console.log('OK — 글자 인코딩 ' + m + '/4');
