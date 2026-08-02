import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const ORIGIN = 'https://whdudwns33-wb.github.io';
const ADMIN_SECRET = 'test-admin-secret';

function request(path, body) {
  return new Request('https://worker.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body)
  });
}

function env(extra = {}) {
  return Object.assign({
    ALLOW_ORIGIN: ORIGIN,
    CONSULT_ADMIN_SECRET: ADMIN_SECRET,
    TASK_ADMIN_SECRET: 'task-secret',
    NAVER_ID: 'naver-id',
    NAVER_SECRET: 'naver-secret'
  }, extra);
}

async function adminCall(path, fields = {}) {
  return worker.fetch(request(path, {
    app: 'consult',
    auth: { mode: 'admin', secret: ADMIN_SECRET },
    ...fields
  }), env(), {});
}

test('검색 결과에서 후기·교재를 제외하고 강좌 상세만 남긴다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [
      {
        title: '<b>현우진 뉴런 수학 강좌</b>',
        link: 'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=123',
        description: '수강 강의 정보'
      },
      {
        title: '현우진 뉴런 수강평 후기',
        link: 'https://www.megastudy.net/teacher_v2/chr/chrreview.asp?chr_cd=123',
        description: '후기'
      },
      {
        title: '현우진 뉴런 교재 문제집',
        link: 'https://www.megastudy.net/book/detail.asp?id=123',
        description: '교재 소개'
      }
    ]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const response = await adminCall('/search', { q: '현우진 뉴런 수학', platform: '메가스터디' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.items.length, 1);
    assert.match(data.items[0].url, /lecture_detailview/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('403 강좌 페이지는 오류 대신 직접 붙여넣기 안내를 반환한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('forbidden', { status: 403 });
  try {
    const response = await adminCall('/curriculum', {
      url: 'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=123'
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.text, '');
    assert.match(data.hint, /자동 가져오기를 제한|직접 붙여넣/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('허용된 강좌 페이지에서 강의목차를 정규화한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    '<table><tr><td>1강</td><td>수의 개념</td><td>12:30</td></tr><tr><td>2강</td><td>연산</td><td>09:00</td></tr></table>',
    { status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
  );
  try {
    const response = await adminCall('/curriculum', {
      url: 'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=123'
    });
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.match(data.text, /^1강 /);
    assert.match(data.text, /수의 개념/);
    assert.doesNotMatch(data.text, /선배 추천/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('리디렉션마다 호스트를 다시 검사해 외부 주소 이동을 차단한다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
  };
  try {
    const response = await adminCall('/curriculum', {
      url: 'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=123'
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.match(data.hint, /허용되지 않은 주소/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('허용목록 밖 주소는 네트워크 요청 전에 거부한다', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };
  try {
    const response = await adminCall('/curriculum', { url: 'https://example.com/course/1' });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.ok, false);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2MB를 넘는 강좌 문서는 읽지 않고 직접 입력으로 전환한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('oversize', {
    status: 200,
    headers: { 'Content-Type': 'text/html', 'Content-Length': String(2 * 1024 * 1024 + 1) }
  });
  try {
    const response = await adminCall('/curriculum', {
      url: 'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=123'
    });
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.match(data.hint, /너무 커서/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('개인 인증은 접두 해시만 조회하고 DB 해시 bearer를 거부한다', async () => {
  const token = 'student-link-token';
  const expectedDigest = Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(token)
  )), byte => byte.toString(16).padStart(2, '0')).join('');
  const expectedStored = 'sha256:' + expectedDigest;
  const queries = [];
  const DB = {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() {
          queries.push({ sql, bindings: bindings.slice() });
          if (sql.includes('FROM tokens')) {
            return bindings[1] === expectedStored ? { token: expectedStored, staff_id: 'STU-1' } : null;
          }
          if (sql.includes('FROM staff')) {
            return { data: JSON.stringify({ id: 'STU-1', deleted: false, manager: false }) };
          }
          return null;
        },
        async run() { return { success: true, meta: { changes: 1 } }; }
      };
    }
  };
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; return new Response('forbidden', { status: 403 }); };
  try {
    const response = await worker.fetch(request('/curriculum', {
      app: 'consult',
      auth: { mode: 'person', id: 'STU-1', token },
      url: 'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=123'
    }), env({ DB }), {});
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.deepEqual(queries[0].bindings.slice(0, 2), ['consult', expectedStored]);
    assert.equal(typeof queries[0].bindings[2], 'number');
    assert.equal(queries.some(query => query.bindings.includes(token)), false);
    assert.equal(networkCalls, 1);

    const beforeRejected = queries.length;
    for (const bearer of [expectedDigest, expectedStored]) {
      const rejected = await worker.fetch(request('/curriculum', {
        app: 'consult', auth: { mode: 'person', id: 'STU-1', token: bearer },
        url: 'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=123'
      }), env({ DB }), {});
      assert.equal(rejected.status, 401);
    }
    assert.equal(queries.length, beforeRejected);
    assert.equal(networkCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
