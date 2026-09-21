'use strict';
/* 어휘 교재 텍스트 → 단어장 초안 검증 (node hanja/extract/draft.test.mjs)
 * 초안은 초안이다 — 하지만 못 뽑은 줄을 조용히 버리면 강사가 낱말이 빠진 줄도 모른다. 그 원칙을 지킨다. */
import assert from 'node:assert';
import { draftFromText, toWordsText } from './draft.mjs';
import CHECK from '../book-check.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const TEXT = `
1일차
1. 관측(觀測) 자연 현상을 살펴 재는 것
 예) 별의 움직임을 관측했다.
2) 觀點 관점 : 사물을 바라보는 자기만의 자리
③ 객관 客觀 - 남의 눈으로 보듯 보는 것
다잡다 : 흐트러진 마음을 단단히 하다
예문: 마음을 다잡고 앉았다.
觀 볼 관 25획
測 잴 측 12
12
Day 2
여태 - 지금까지
觀測
이건 무슨 줄인지 모르겠다
`;

t('단원·낱말·한자·예문을 붙여넣기 형식으로 뽑는다', () => {
  const d = draftFromText(TEXT);
  assert.deepStrictEqual(d.lines, [
    '# 1일차',
    '관측 | 자연 현상을 살펴 재는 것 | 觀測 | 별의 움직임을 관측했다.',
    '관점 | 사물을 바라보는 자기만의 자리 | 觀點',
    '객관 | 남의 눈으로 보듯 보는 것 | 客觀',
    '다잡다 | 흐트러진 마음을 단단히 하다 | 마음을 다잡고 앉았다.',
    '觀 | 볼 관 | 25',
    '測 | 잴 측 | 12',
    '# Day 2',
    '여태 | 지금까지',
  ]);
  assert.deepStrictEqual(d.counts, { units: 2, words: 5, chars: 2, examples: 2 });
});

t('못 뽑은 줄은 번호·이유와 함께 review 로 내린다 (쪽 번호는 조용히 뺀다)', () => {
  const d = draftFromText(TEXT);
  assert.deepStrictEqual(d.unmatched.map((u) => u.line), ['觀測', '이건 무슨 줄인지 모르겠다']);
  assert.ok(/한자만/.test(d.unmatched[0].reason));
  assert.ok(d.unmatched.every((u) => u.no > 0));
});

t('초안이 관리 웹 파서(book-check)를 그대로 통과한다', () => {
  const r = CHECK.parseBookText(toWordsText(draftFromText(TEXT)), { id: 'draft-1', title: '초안' });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.book.units.map((u) => u.title), ['1일차', 'Day 2']);
  const w = r.book.words.find((x) => x.word === '관측');
  assert.strictEqual(w.hanja, '觀測'); assert.strictEqual(w.example, '별의 움직임을 관측했다.');
  const n = r.book.words.find((x) => x.word === '다잡다');
  assert.strictEqual(n.type, 'native'); assert.strictEqual(n.example, '마음을 다잡고 앉았다.');
  assert.strictEqual(r.book.chars.find((c) => c.ch === '觀').strokes, 25);
});

t('빈 입력·구분 기호 없는 고유어 줄은 억지로 뽑지 않는다', () => {
  assert.deepStrictEqual(draftFromText('').lines, []);
  const d = draftFromText('가늠하다 어림잡아 헤아리다');
  assert.strictEqual(d.lines.length, 0);
  assert.strictEqual(d.unmatched.length, 1, '구분 기호 없는 줄을 낱말로 짐작하면 뜻이 잘못 갈린다');
});

console.log(`\nOK — ${passed}개 통과`);
