'use strict';
/* 반 명단 붙여넣기 검증 (node reading-server/roster.test.mjs) */
import assert from 'node:assert';
import { parseRoster } from './roster.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

t('이름만 붙여넣으면 학년·반은 화면에서 준 값으로 채운다', () => {
  const { rows, errors } = parseRoster('김지우\n박서준\n이하윤', { cls: '초5 A반', grade: '초5' });
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(rows.map((r) => r.name), ['김지우', '박서준', '이하윤']);
  assert.ok(rows.every((r) => r.cls === '초5 A반' && r.grade === '초5'));
});

t('코드를 안 적으면 겹치지 않는 번호를 새로 만든다', () => {
  const { rows } = parseRoster('가\n나\n다', { existing: ['wb-101', 'wb-107', 'other-9'] });
  assert.deepStrictEqual(rows.map((r) => r.code), ['wb-108', 'wb-109', 'wb-110'],
    '이미 있는 가장 큰 번호 다음부터 — 접두사가 다른 것은 세지 않는다');
  assert.ok(rows.every((r) => r.made), '새로 만든 줄임을 표시한다');
});

t('줄마다 학년·반·코드를 따로 적을 수 있다', () => {
  const { rows } = parseRoster('김지우 | 초5 | 초5 A반 | wb-201\n박서준 | 중1 | 중1 B반',
    { cls: '기본반', grade: '기본학년' });
  assert.deepStrictEqual(rows[0], { code: 'wb-201', name: '김지우', grade: '초5', cls: '초5 A반', level: '', made: false });
  assert.strictEqual(rows[1].cls, '중1 B반');
  assert.strictEqual(rows[1].code, 'wb-202',
    '앞줄에서 손으로 적은 번호 다음으로 이어 준다 — 그래야 반 번호가 붙어 있다');
});

t('쉼표로 적어도 되지만, 막대가 있으면 막대가 칸 구분이다', () => {
  assert.strictEqual(parseRoster('김지우, 초5, 초5 A반').rows[0].cls, '초5 A반');
  /* 반 이름에 쉼표가 있으면 막대로 적어야 안 잘린다 */
  const r = parseRoster('김지우 | 초5 | 월,수,금 A반').rows[0];
  assert.strictEqual(r.cls, '월,수,금 A반', '막대가 있으면 쉼표는 반 이름의 일부다');
});

t('빈 줄과 # 메모는 건너뛴다', () => {
  const { rows } = parseRoster('# 초5 A반 명단\n김지우\n\n  \n박서준\n');
  assert.strictEqual(rows.length, 2);
});

t('코드가 겹치면 한 명이 조용히 사라지므로 막는다', () => {
  /* 같은 코드로 저장하면 덮어쓰기라 뒤엣것만 남는다 — 등록 전에 걸러야 한다 */
  const { rows, errors } = parseRoster('김지우 | | | wb-201\n박서준 | | | wb-201');
  assert.strictEqual(rows.length, 1);
  assert.ok(errors.some((e) => e.includes('겹칩니다')), errors.join(' / '));
});

t('코드 형식이 틀리면 그 줄만 거르고 나머지는 살린다', () => {
  const { rows, errors } = parseRoster('김지우 | | | 코드한글\n박서준 | | | wb-9\n이하윤');
  assert.deepStrictEqual(rows.map((r) => r.name), ['박서준', '이하윤']);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].startsWith('1행'), errors[0]);
});

t('이름이 같으면 막지 않고 알려 준다', () => {
  const { rows, errors } = parseRoster('김지우\n김지우');
  assert.strictEqual(rows.length, 2, '동명이인은 실제로 있으므로 등록은 시킨다');
  assert.ok(errors.some((e) => e.startsWith('알림:')), errors.join(' / '));
  assert.notStrictEqual(rows[0].code, rows[1].code);
});

t('붙여넣는 중에 만든 코드끼리도 겹치지 않는다', () => {
  const { rows } = parseRoster('가 | | | wb-102\n나\n다', { existing: ['wb-101'] });
  assert.deepStrictEqual(rows.map((r) => r.code), ['wb-102', 'wb-103', 'wb-104'],
    '앞줄에서 손으로 적은 코드도 피해야 한다');
});

t('빈 명단은 오류가 아니라 빈 결과다', () => {
  const { rows, errors } = parseRoster('', {});
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(errors, []);
});

console.log('\n통과 ' + passed + '개 — 반 명단 붙여넣기 검증 완료');
