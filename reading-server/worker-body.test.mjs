'use strict';
/* 작은 state + 무시되는 과대 필드로 Content-Length 우회를 재현한다. 합성 KV만 사용한다. */
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { readJsonBody } from './request-body.mjs';
import { naesinBodyLimit } from './naesin-api.mjs';
import { naesinKoBodyLimit } from './naesin-ko-api.mjs';
import { haruBodyLimit } from './haru-api.mjs';
import { hanjaBodyLimit } from './hanja-api.mjs';
import { letterBodyLimit } from './letter-api.mjs';

const CODE = 'BODYSYN01', PARENT = 'a'.repeat(32);
const encode = text => new TextEncoder().encode(text);
class FakeKV {
  constructor() {
    this.rows = new Map([
      ['token:synthetic-student', JSON.stringify({ code: CODE, admin: false })],
      ['token:synthetic-admin', JSON.stringify({ code: '__admin__', admin: true })],
      ['student:' + CODE, JSON.stringify({ code: CODE, name: '합성학생', consent: { at: '2026-01-01' } })],
      ['parent:' + PARENT, CODE],
    ]);
    this.writes = [];
  }
  async get(key, type) { const value = this.rows.get(key); return value == null ? null : type === 'json' ? JSON.parse(value) : value; }
  async put(key, value) { this.writes.push(key); this.rows.set(key, value); }
  async delete(key) { this.rows.delete(key); }
  async list({ prefix = '' } = {}) { return { keys: [...this.rows.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
}
function stream(bytes, chunkSize = 8191) {
  let offset = 0, cancelled = false;
  return {
    body: new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const next = Math.min(bytes.length, offset + chunkSize);
        controller.enqueue(bytes.slice(offset, next)); offset = next;
      },
      cancel() { cancelled = true; },
    }),
    cancelled: () => cancelled,
  };
}
async function call(p, raw, { header, streamed = false, admin = false, bearer, method = 'PUT' } = {}) {
  const DB = new FakeKV(), input = streamed ? stream(encode(raw)) : null;
  const request = new Request('https://synthetic.invalid' + p, {
    method, headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (bearer || (admin ? 'synthetic-admin' : 'synthetic-student')),
      ...(header == null ? {} : { 'Content-Length': String(header) }) },
    body: input ? input.body : raw, ...(input ? { duplex: 'half' } : {}),
  });
  const response = await worker.fetch(request, { DB, ASSETS: { fetch: async () => new Response('{"atoms":[],"coreByPhase":{}}') } }, {});
  return { response, DB, input };
}

for (const [p, limitOf] of [
  ['/api/naesin-ko/state', naesinKoBodyLimit], ['/api/naesin/state', naesinBodyLimit],
  ['/api/haru/state', haruBodyLimit], ['/api/hanja/state', hanjaBodyLimit],
  ['/api/letter/state', letterBodyLimit], ['/api/chunk/state', () => 300_000],
  ['/api/letter/parent/state?t=' + PARENT, letterBodyLimit], ['/api/chunk/parent/state?t=' + PARENT, () => 300_000],
]) {
  const limit = limitOf(p.split('?')[0]);
  const small = JSON.stringify({ state: { v: 1, issues: {}, packs: {} }, unused: '가나다' });
  assert.equal((await call(p, small, { streamed: true })).response.status, 200, p + ' 정상 기록이 막혔다');
  const big = JSON.stringify({ state: { v: 1, issues: {}, packs: {} }, unused: 'x'.repeat(limit + 50_000) });
  for (const options of [{}, { header: 1 }, { streamed: true }]) {
    const result = await call(p, big, options);
    assert.equal(result.response.status, 413, p + ' 길이 헤더가 없거나 틀린 과대 요청을 받았다');
    const body = await result.response.json();
    assert.ok(!('detail' in body), '과대 요청에 파싱 예외 원문을 내보내면 안 된다');
    assert.deepEqual(result.DB.writes, [], p + ' 과대 요청이 기록·일일 예산을 바꿨다');
    if (result.input) assert.ok(result.input.cancelled(), p + ' 과대 스트림을 끝까지 읽었다');
  }
  assert.equal((await call(p, '{bad')).response.status, 400, p + ' 잘못된 JSON의 기존 판정이 달라졌다');
  console.log('  ✓ ' + p + ' 정상·헤더 없음·거짓 길이·분할 스트림·파싱 오류');
}

const studioPath = '/api/naesin/admin/job';
const studioRaw = JSON.stringify({ unused: 'x'.repeat(naesinBodyLimit(studioPath) + 50_000) });
const studio = await call(studioPath, studioRaw, { admin: true, streamed: true, method: 'POST' });
assert.equal(studio.response.status, 413, '스튜디오가 과대 요청을 400으로 삼켰다');
assert.deepEqual(studio.DB.writes, []);
assert.ok(studio.input.cancelled(), '스튜디오 과대 스트림을 끝까지 읽었다');

const unauthorized = await call('/api/naesin-ko/state', studioRaw, { bearer: 'no-such-token' });
assert.equal(unauthorized.response.status, 401, '몸통 검사로 인증 관문을 바꾸면 안 된다');

/* 한글이 조각 경계에 걸려도 한 번에 디코딩하고 바이트 상한은 정확히 적용한다. */
const exact = encode('{"value":"가"}');
assert.deepEqual(await readJsonBody(new Request('https://synthetic.invalid', { method: 'POST', body: stream(exact, 1).body, duplex: 'half' }), exact.length), { value: '가' });
await assert.rejects(readJsonBody(new Request('https://synthetic.invalid', { method: 'POST', body: exact }), exact.length - 1), e => e.status === 413);
console.log('worker-body: Worker 8경로·스튜디오·인증·바이트 경계 통과');
