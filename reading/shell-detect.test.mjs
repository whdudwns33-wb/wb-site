'use strict';
/* 같은 껍데기 잡아내기 — 망 없이 시험한다 */
import assert from 'node:assert/strict';
import { shellGroups, shellReport } from './shell-detect.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const row = (id, url, bodyLen, verdict = 'ok') => ({ id, url, bodyLen, verdict, note: '' });

t('같은 호스트에서 서로 다른 주소가 같은 길이면 껍데기로 본다', () => {
  const g = shellGroups([
    row('a', 'https://x.test/a', 24607),
    row('b', 'https://x.test/b', 24607),
    row('c', 'https://x.test/c', 24607),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].host, 'x.test');
  assert.equal(g[0].bodyLen, 24607);
  assert.equal(g[0].rows.length, 3);
});

t('길이가 한 글자라도 다르면 묶지 않는다', () => {
  assert.equal(shellGroups([
    row('a', 'https://x.test/a', 24607),
    row('b', 'https://x.test/b', 24608),
  ]).length, 0);
});

t('호스트가 다르면 묶지 않는다', () => {
  assert.equal(shellGroups([
    row('a', 'https://x.test/a', 24607),
    row('b', 'https://y.test/b', 24607),
  ]).length, 0);
});

t('같은 주소가 두 번 실린 것은 껍데기의 증거가 아니다', () => {
  /* 한 지문이 같은 출처를 두 번 인용하면 길이가 같은 것이 당연하다 */
  assert.equal(shellGroups([
    row('a', 'https://x.test/same', 24607),
    row('b', 'https://x.test/same', 24607),
  ]).length, 0);
});

t('짧은 본문은 다른 검사가 이미 잡으므로 세지 않는다', () => {
  assert.equal(shellGroups([
    row('a', 'https://x.test/a', 120),
    row('b', 'https://x.test/b', 120),
  ]).length, 0);
});

t('주소가 아니거나 길이를 모르는 줄은 건너뛴다', () => {
  assert.equal(shellGroups([
    { id: 'a', url: '주소 아님', bodyLen: 24607, verdict: 'ok' },
    { id: 'b', url: 'https://x.test/b', verdict: 'ok' },
    null,
  ]).length, 0);
  assert.equal(shellGroups(undefined).length, 0);
});

t('보고에는 통과한 개수를 적는다 — 통과한 쪽이 더 위험하다', () => {
  const g = shellGroups([
    row('a', 'https://x.test/a', 24607, 'ok'),
    row('b', 'https://x.test/b', 24607, 'ok'),
    row('c', 'https://x.test/c', 24607, 'warn'),
  ]);
  const lines = shellReport(g);
  assert.match(lines[0], /서로 다른 3개 주소/);
  assert.match(lines[0], /2개가 「본문 확인」으로 통과/);
  assert.equal(lines.filter(l => l.includes('https://x.test/')).length, 3);
});

console.log('OK — 같은 껍데기 ' + n + '/7');
