import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './student-worker.js';
import mainWorker from './worker.js';

function request(path, init = {}) {
  return new Request('https://student.example' + path, init);
}

test('학생 Worker는 GET 정적 자산만 전용 ASSETS로 넘긴다', async () => {
  let seen = '';
  const response = await worker.fetch(request('/'), {
    ASSETS: { fetch(value) { seen = new URL(value.url).pathname; return new Response('student'); } }
  });
  assert.equal(await response.text(), 'student');
  assert.equal(seen, '/');
});

test('학생 세션 API는 exact same-origin과 세 public action만 허용한다', async () => {
  const configured = { WB_STUDENT_PORTAL_BASE_URL: 'https://student.example/' };
  const foreign = await worker.fetch(request('/student-portal', {
    method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'task', action: 'view' })
  }), configured);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), 'null');

  const admin = await worker.fetch(request('/student-portal', {
    method: 'POST', headers: { Origin: 'https://student.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'task', action: 'access_list', auth: 'secret' })
  }), configured);
  assert.equal(admin.status, 403);

  const invalidCode = await worker.fetch(request('/student-portal', {
    method: 'POST', headers: { Origin: 'https://student.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'task', action: 'exchange', code: 'not-a-code' })
  }), configured);
  assert.equal(invalidCode.status, 400);

  const alias = await worker.fetch(new Request('https://preview.student.example/student-portal', {
    method: 'POST', headers: { Origin: 'https://preview.student.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'task', action: 'view' })
  }), configured);
  assert.equal(alias.status, 403);
});

test('학생 Worker는 누락·null·유사 Origin을 거부하고 기본 Worker는 public 학생 action을 거부한다', async () => {
  const configured = { WB_STUDENT_PORTAL_BASE_URL: 'https://student.example/' };
  for (const origin of [null, 'null', 'https://student.examp1e', 'https://student.example.']) {
    const headers = { 'Content-Type': 'application/json' };
    if (origin != null) headers.Origin = origin;
    const response = await worker.fetch(request('/student-portal', {
      method: 'POST', headers, body: JSON.stringify({ app: 'task', action: 'view' })
    }), configured);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'null');
  }

  const mainResponse = await mainWorker.fetch(request('/student-portal', {
    method: 'POST',
    headers: { Origin: 'https://student.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'task', action: 'view' })
  }), { ALLOW_ORIGIN: 'https://student.example' });
  assert.equal(mainResponse.status, 403);
  assert.match(await mainResponse.text(), /학생 앱 전용 주소/);
});

test('학생 Worker의 오류는 내부 예외와 업무 API를 노출하지 않는다', async () => {
  const missing = await worker.fetch(request('/sync', {
    method: 'POST', headers: { Origin: 'https://student.example' }
  }), {});
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /stack|token|phone|tasks|guardian/i);
});
