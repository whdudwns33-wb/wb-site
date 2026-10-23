import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTaskExport, handleTaskExport } from './task-export.js';
import worker from './worker-core.js';

const READ_SECRET = 'test-only-task-read-secret-not-a-real-credential';

function row(data) {
  return { id: data.id, data: JSON.stringify(data) };
}

function makeDb(tasks = [], staff = []) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      statements.push(sql);
      assert.match(sql, /^SELECT id,data FROM (tasks|staff) WHERE app=\?$/);
      const source = /FROM tasks/.test(sql) ? tasks : staff;
      return {
        bind(app) {
          assert.equal(app, 'task');
          return { async all() { return { results: source }; } };
        }
      };
    }
  };
}

function request(body, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  return new Request('https://wb-sync.example/task-export', {
    method: options.method || 'POST',
    headers,
    body: options.method === 'GET' ? undefined : JSON.stringify(body)
  });
}

test('전용 Bearer가 없거나 잘못되면 DB를 읽지 않고 거절한다', async () => {
  for (const [secret, token, status] of [
    ['', READ_SECRET, 503],
    [READ_SECRET, '', 401],
    [READ_SECRET, 'admin-secret-must-not-be-reused-012345678901234567890123456789', 401]
  ]) {
    const DB = makeDb();
    const response = await handleTaskExport(
      request({ app: 'task', action: 'list_work_orders' }, { token }),
      { TASK_MCP_READ_SECRET: secret, DB }
    );
    assert.equal(response.status, status);
    assert.equal(DB.statements.length, 0);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('브라우저 Origin, 다른 앱, 쓰기·추가 필드는 거절한다', async () => {
  const env = { TASK_MCP_READ_SECRET: READ_SECRET, DB: makeDb() };
  const browserResponse = await handleTaskExport(
    request({ app: 'task', action: 'list_work_orders' }, {
      token: READ_SECRET,
      headers: { Origin: 'https://whdudwns33-wb.github.io' }
    }),
    env
  );
  assert.equal(browserResponse.status, 403);

  for (const body of [
    { app: 'consult', action: 'list_work_orders' },
    { app: 'task', action: 'write_work_orders' },
    { app: 'task', action: 'list_work_orders', auth: { mode: 'admin', secret: 'x' } }
  ]) {
    const response = await handleTaskExport(request(body, { token: READ_SECRET }), env);
    assert.equal(response.status, 400);
  }
  assert.equal(env.DB.statements.length, 0);
});

test('기존 관리자 JSON과 같은 일반 업무 허용 필드만 투영한다', () => {
  const staff = [row({ id: 'staff-a', name: '김담당', deleted: true, phone: 'STAFF_PHONE_SENTINEL' })];
  const tasks = [
    row({
      id: 'task-a', groupId: 'group-a', staffId: 'staff-a', title: '재고 조사', detail: '교구 수량 확인',
      guide: '창고부터 확인', steps: [{ id: 'step-a', label: '수량 세기', private: 'STEP_SECRET' }],
      target: '2', unit: '곳', time: '09:00', priority: 'high', repeat: 'days', days: ['1', 9],
      start: '2026-10-01', end: '2026-10-31', carry: false, origin: 'admin', createdAt: '100', updatedAt: 200,
      studentName: 'STUDENT_SENTINEL', phone: 'PHONE_SENTINEL', token: 'TOKEN_SENTINEL'
    }),
    row({ id: 'deleted', staffId: 'staff-a', title: 'DELETED_SENTINEL', deleted: true }),
    row({ id: 'book', staffId: 'staff-a', title: '[주문] BOOK_SENTINEL' }),
    row({ id: 'lesson', staffId: 'staff-a', title: '[수업] LESSON_SENTINEL' }),
    row({ id: 'consult', staffId: 'staff-a', title: '[컨설팅] CONSULT_SENTINEL' }),
    row({ id: 'session', staffId: 'staff-a', title: 'SESSION_SENTINEL', taskKind: 'lesson_instruction' }),
    row({ id: 'makeup', staffId: 'staff-a', title: 'MAKEUP_SENTINEL', makeupCaseId: 'case-a' })
  ];

  const result = buildTaskExport(tasks, staff, { now: '2026-10-23T00:00:00.000Z', limit: 50 });
  assert.equal(result.data.schema, 'wb-task-transfer-v1');
  assert.equal(result.data.app, 'task');
  assert.equal(result.data.exportedAt, '2026-10-23T00:00:00.000Z');
  assert.equal(result.data.items.length, 1);
  assert.deepEqual(Object.keys(result.data.items[0]).sort(), [
    'carry', 'createdAt', 'days', 'detail', 'end', 'groupId', 'guide', 'origin', 'priority', 'repeat',
    'staffId', 'staffName', 'start', 'steps', 'target', 'taskId', 'time', 'title', 'unit', 'updatedAt'
  ]);
  assert.deepEqual(result.data.items[0].steps, [{ id: 'step-a', label: '수량 세기' }]);
  assert.deepEqual(result.data.items[0].days, [1]);
  assert.equal(result.data.items[0].staffName, '김담당');

  const json = JSON.stringify(result);
  for (const forbidden of [
    'STAFF_PHONE_SENTINEL', 'STEP_SECRET', 'STUDENT_SENTINEL', 'PHONE_SENTINEL', 'TOKEN_SENTINEL',
    'DELETED_SENTINEL', 'BOOK_SENTINEL', 'LESSON_SENTINEL', 'CONSULT_SENTINEL', 'SESSION_SENTINEL', 'MAKEUP_SENTINEL'
  ]) assert.ok(!json.includes(forbidden), forbidden);
});

test('날짜·담당자 필터와 결정적 페이지 상한을 적용한다', async () => {
  const staff = [
    row({ id: 'staff-a', name: '가 담당' }),
    row({ id: 'staff-b', name: '나 담당' })
  ];
  const tasks = [
    row({ id: 'older', staffId: 'staff-a', title: '월요일 업무', repeat: 'days', days: [1], start: '2026-10-01', updatedAt: 10 }),
    row({ id: 'newer-b', staffId: 'staff-a', title: '매일 업무 B', repeat: 'daily', start: '2026-10-01', updatedAt: 30 }),
    row({ id: 'newer-a', staffId: 'staff-a', title: '매일 업무 A', repeat: 'daily', start: '2026-10-01', updatedAt: 30 }),
    row({ id: 'other', staffId: 'staff-b', title: '다른 담당', repeat: 'daily', start: '2026-10-01', updatedAt: 40 })
  ];
  const DB = makeDb(tasks, staff);
  const first = await handleTaskExport(
    request({ app: 'task', action: 'list_work_orders', date: '2026-10-26', staffId: 'staff-a', limit: 2 }, { token: READ_SECRET }),
    { TASK_MCP_READ_SECRET: READ_SECRET, DB }
  );
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /no-store/);
  assert.equal(first.headers.get('access-control-allow-origin'), null);
  const firstPayload = await first.json();
  assert.deepEqual(firstPayload.data.items.map(item => item.taskId), ['newer-a', 'newer-b']);
  assert.equal(firstPayload.page.total, 3);
  assert.match(firstPayload.page.nextCursor, /^v1\.\d+\.newer-b$/);
  assert.match(firstPayload.notice, /개인정보/);

  const moved = JSON.parse(tasks[0].data);
  moved.updatedAt = 1000;
  tasks[0] = row(moved);
  const second = await handleTaskExport(
    request({ app: 'task', action: 'list_work_orders', date: '2026-10-26', staffId: 'staff-a', cursor: firstPayload.page.nextCursor, limit: 2 }, { token: READ_SECRET }),
    { TASK_MCP_READ_SECRET: READ_SECRET, DB }
  );
  const secondPayload = await second.json();
  assert.deepEqual(secondPayload.data.items.map(item => item.taskId), ['older']);
  assert.equal(secondPayload.page.nextCursor, null);
  assert.equal(DB.statements.length, 4);
  assert.ok(DB.statements.every(sql => /^SELECT /.test(sql)));
});

test('조회 위치·개수·필터 형식을 엄격히 제한한다', async () => {
  const env = { TASK_MCP_READ_SECRET: READ_SECRET, DB: makeDb() };
  for (const body of [
    { app: 'task', action: 'list_work_orders', cursor: '-1' },
    { app: 'task', action: 'list_work_orders', limit: 201 },
    { app: 'task', action: 'list_work_orders', staffId: '../all' },
    { app: 'task', action: 'list_work_orders', date: '2026/10/23' },
    { app: 'task', action: 'list_work_orders', date: '2026-02-30' }
  ]) {
    const response = await handleTaskExport(request(body, { token: READ_SECRET }), env);
    assert.equal(response.status, 400);
  }
  assert.equal(env.DB.statements.length, 0);
});

test('공용 Worker는 Origin 없는 task-export를 일반 CORS·app 라우팅 전에 처리한다', async () => {
  const DB = makeDb([row({ id: 'task-a', staffId: 'staff-a', title: '읽기 업무', updatedAt: 1 })], [
    row({ id: 'staff-a', name: '김담당' })
  ]);
  const response = await worker.fetch(
    request({ app: 'task', action: 'list_work_orders', limit: 1 }, { token: READ_SECRET }),
    {
      TASK_MCP_READ_SECRET: READ_SECRET,
      ALLOW_ORIGIN: 'https://whdudwns33-wb.github.io',
      DB
    },
    {}
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.items[0].title, '읽기 업무');
  assert.equal(payload.data.app, 'task');
});
