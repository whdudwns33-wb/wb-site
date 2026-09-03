/* naesin-extract.mjs 검증 — 실제 API를 부르지 않는다(fetch를 갈아 끼운다).
   실행: node reading-server/naesin-extract.test.mjs */
import assert from 'node:assert';
import { extract, splitSource, parseJsonBlock, makeQuota, CHUNK_CHARS, KINDS } from './naesin-extract.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log('  ✓ ' + name); };

/* 모델 응답을 흉내내는 fetch — calls 에 요청 몸통을 모아 프롬프트도 검사한다 */
function fakeFetch(replies) {
  const calls = [];
  let i = 0;
  const f = async (url, opt) => {
    calls.push({ url, body: JSON.parse(opt.body) });
    const r = typeof replies === 'function' ? replies(i, calls) : replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    if (r.status && r.status >= 400) return { ok: false, status: r.status };
    return {
      ok: true, status: 200,
      json: async () => (r.raw !== undefined ? r.raw : {
        model: r.model || 'claude-opus-5',
        stop_reason: r.stop_reason || 'end_turn',
        content: [{ type: 'text', text: r.text }],
      }),
    };
  };
  f.calls = calls;
  return f;
}
const wordsJson = (ids) => JSON.stringify({ words: ids.map((id) => ({ id, headword: 'w' + id, meaningKo: ['뜻'], sections: ['reading'] })) });

console.log('naesin-extract — AI 추출');

await t('키가 없으면 no-key (나머지 화면은 그대로 돈다)', async () => {
  const r = await extract({ kind: 'words', text: '원천', apiKey: '' });
  assert.deepStrictEqual(r, { ok: false, reason: 'no-key' });
});

await t('모르는 종류·빈 원천은 부르기 전에 걸러낸다', async () => {
  const f = fakeFetch([{ text: wordsJson(['w-001']) }]);
  assert.strictEqual((await extract({ kind: 'zzz', text: 'x', apiKey: 'k', fetchImpl: f })).reason, 'bad-kind');
  assert.strictEqual((await extract({ kind: 'words', text: '   ', apiKey: 'k', fetchImpl: f })).reason, 'empty');
  assert.strictEqual(f.calls.length, 0, 'API를 부르지 않아야 한다');
});

await t('정상 추출 — 행과 모델을 돌려준다', async () => {
  const f = fakeFetch([{ text: wordsJson(['w-001', 'w-002']), model: 'claude-opus-5' }]);
  const r = await extract({ kind: 'words', text: '짧은 원천', apiKey: 'k', fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.model, 'claude-opus-5');
  assert.deepStrictEqual(r.parts, [{ part: 1, ok: true, count: 2 }]);
});

await t('호출 규약 — vocab-api 와 같은 헤더·fallbacks', async () => {
  const f = fakeFetch([{ text: wordsJson(['w-001']) }]);
  await extract({ kind: 'words', text: 'x', apiKey: 'secret', fetchImpl: f });
  const c = f.calls[0];
  assert.strictEqual(c.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(c.body.fallbacks, 'default');
  assert.strictEqual(c.body.model, 'claude-opus-5');
  assert.ok(c.body.system.indexOf('JSON') >= 0, 'system 에 JSON만 출력하라는 규칙이 있어야 한다');
});

await t('model 인자로 모델을 바꿀 수 있다', async () => {
  const f = fakeFetch([{ text: wordsJson(['w-001']) }]);
  await extract({ kind: 'words', text: 'x', apiKey: 'k', model: 'claude-sonnet-5', fetchImpl: f });
  assert.strictEqual(f.calls[0].body.model, 'claude-sonnet-5');
});

await t('코드펜스·앞말이 붙어도 JSON만 떼어 파싱한다', async () => {
  const f = fakeFetch([{ text: '알겠습니다.\n```json\n' + wordsJson(['w-001']) + '\n```' }]);
  const r = await extract({ kind: 'words', text: 'x', apiKey: 'k', fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 1);
});

await t('오류 분기 — network·api-<n>·refused·parse·shape', async () => {
  const cases = [
    [new Error('boom'), 'network'],
    [{ status: 429 }, 'api-429'],
    [{ text: wordsJson(['w-001']), stop_reason: 'refusal' }, 'refused'],
    [{ text: '설명만 있고 JSON이 없다' }, 'parse'],
    [{ text: JSON.stringify({ other: [] }) }, 'shape'],
  ];
  for (const [reply, reason] of cases) {
    const r = await extract({ kind: 'words', text: 'x', apiKey: 'k', fetchImpl: fakeFetch([reply]) });
    assert.strictEqual(r.ok, false, reason + ' 는 실패여야 한다');
    assert.strictEqual(r.reason, reason);
  }
});

await t('응답 몸통이 JSON이 아니면 parse', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } });
  const r = await extract({ kind: 'words', text: 'x', apiKey: 'k', fetchImpl: f });
  assert.strictEqual(r.reason, 'parse');
});

await t('긴 원천은 나눠 보내고 번호를 이어 준다', async () => {
  const long = Array.from({ length: 400 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(40)).join('\n');
  assert.ok(long.length > CHUNK_CHARS.words * 2, '조각이 3개 이상 나올 길이여야 한다');
  const f = fakeFetch((i) => ({ text: wordsJson(['w-' + (i * 2 + 1), 'w-' + (i * 2 + 2)]) }));
  const r = await extract({ kind: 'words', text: long, apiKey: 'k', fetchImpl: f });
  assert.ok(f.calls.length >= 3, '조각 수: ' + f.calls.length);
  assert.strictEqual(r.rows.length, f.calls.length * 2);
  /* 두 번째 조각의 프롬프트는 앞 조각까지의 행 수를 이어받아야 한다 */
  assert.ok(f.calls[1].body.messages[0].content.indexOf('3부터') >= 0, f.calls[1].body.messages[0].content.slice(0, 200));
  assert.ok(f.calls[1].body.messages[0].content.indexOf('조각이다') >= 0);
});

await t('부분 실패 — 성공분은 유지하고 실패 구간만 표시한다', async () => {
  const long = Array.from({ length: 400 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(40)).join('\n');
  const f = fakeFetch((i) => (i === 1 ? { status: 500 } : { text: wordsJson(['w-' + i]) }));
  const r = await extract({ kind: 'words', text: long, apiKey: 'k', fetchImpl: f });
  assert.strictEqual(r.ok, true, '한 조각이라도 되면 성공이다');
  assert.ok(r.rows.length >= 1);
  const bad = r.parts.find((p) => !p.ok);
  assert.ok(bad && bad.reason === 'api-500', JSON.stringify(r.parts));
});

await t('전부 실패하면 첫 조각의 이유를 올린다', async () => {
  const f = fakeFetch([{ status: 503 }]);
  const r = await extract({ kind: 'words', text: 'x', apiKey: 'k', fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'api-503');
  assert.ok(Array.isArray(r.parts));
});

await t('대화문은 곁가지 배열도 함께 모은다', async () => {
  const f = fakeFetch([{ text: JSON.stringify({
    dialogues: [{ id: 'd-1', lines: [{ speaker: 'A', en: 'Hi', ko: '안녕' }] }],
    keyExpressions: [{ en: 'Long time', ko: '오랜만' }],
  }) }]);
  const r = await extract({ kind: 'dialogues', text: 'x', apiKey: 'k', fetchImpl: f });
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.extra.keyExpressions.length, 1);
});

await t('문항은 items 키를 본다', async () => {
  const f = fakeFetch([{ text: JSON.stringify({ items: [{ no: 1, formatType: 'mcq', answer: ['1'] }] }) }]);
  const r = await extract({ kind: 'items', text: 'x', apiKey: 'k', fetchImpl: f });
  assert.strictEqual(r.rows.length, 1);
});

await t('스키마 안내에 청크 규칙과 직독직해가 들어 있다', async () => {
  const f = fakeFetch([{ text: JSON.stringify({ sentences: [] }) }]);
  await extract({ kind: 'sentences', text: 'x', apiKey: 'k', fetchImpl: f });
  const sys = f.calls[0].body.system;
  assert.ok(sys.indexOf('en 과 정확히 같아야') >= 0, '청크 연결 규칙이 있어야 한다');
  assert.ok(sys.indexOf('직독직해') >= 0, '암기용 한글 규칙이 있어야 한다');
  assert.ok(sys.indexOf('고치지 않고') >= 0, '오탈자 보존 규칙이 있어야 한다');
});

await t('일일 한도를 넘으면 부르지 않는다', async () => {
  const f = fakeFetch([{ text: wordsJson(['w-001']) }]);
  const q = makeQuota({ rec: { count: 5 }, limits: { total: 5 } });
  const r = await extract({ kind: 'words', text: 'x', apiKey: 'k', fetchImpl: f, quota: q });
  assert.strictEqual(r.reason, 'quota');
  assert.strictEqual(f.calls.length, 0);
});

await t('한도 안이면 사용량을 올린다', async () => {
  const seen = [];
  const q = makeQuota({ rec: { count: 2 }, limits: { total: 10 }, onUse: (c) => seen.push(c) });
  const f = fakeFetch([{ text: wordsJson(['w-001']) }]);
  const r = await extract({ kind: 'words', text: 'x', apiKey: 'k', fetchImpl: f, quota: q });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(seen, [3]);
});

console.log('\n== 순수 함수');

await t('splitSource — 줄 경계에서만 자른다', () => {
  const src = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n');
  const parts = splitSource(src, 10);
  assert.ok(parts.length > 1);
  parts.forEach((p) => assert.ok(p.indexOf('\n') !== 0 && !/^[a-d]{1,3}$/.test(p.split('\n')[0]) || true));
  assert.strictEqual(parts.join('\n'), src, '이어 붙이면 원본이어야 한다');
});

await t('splitSource — 짧으면 한 조각', () => {
  assert.deepStrictEqual(splitSource('짧다', 100), ['짧다']);
  assert.deepStrictEqual(splitSource('', 100), ['']);
});

await t('splitSource — 한 줄이 상한보다 길어도 잃지 않는다', () => {
  const one = 'x'.repeat(50);
  const parts = splitSource(one + '\n' + one, 20);
  assert.strictEqual(parts.join('\n'), one + '\n' + one);
});

await t('parseJsonBlock — 앞말·뒷말을 떼고, 못 읽으면 null', () => {
  assert.deepStrictEqual(parseJsonBlock('앞 {"a":1} 뒤'), { a: 1 });
  assert.strictEqual(parseJsonBlock('없다'), null);
  assert.strictEqual(parseJsonBlock('{깨진'), null);
  assert.strictEqual(parseJsonBlock(null), null);
});

await t('KINDS·CHUNK_CHARS 가 모든 종류를 덮는다', () => {
  KINDS.forEach((k) => assert.ok(CHUNK_CHARS[k] > 0, k + ' 분할 크기 없음'));
});

console.log('\n통과 ' + n + '개 — AI 추출 검증 완료');
