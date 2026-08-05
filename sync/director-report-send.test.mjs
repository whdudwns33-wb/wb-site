import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import worker from './worker-core.js';
import {
  buildDirectorReportText,
  buildSolapiAuthorization,
  directorReportConstants,
  kstDateFromMs,
  summarizeReportRows
} from './director-report-send.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/011_director_report_sends.sql', import.meta.url), 'utf8');
const TODAY = kstDateFromMs(Date.now());
const DOW = new Date(TODAY + 'T00:00:00Z').getUTCDay();

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.args = [];
  }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.first(this.sql, this.args); }
  all() { return this.db.all(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
}

class FakeDB {
  constructor() {
    this.staff = new Map();
    this.tasks = new Map();
    this.checks = new Map();
    this.tokens = new Map();
    this.sends = new Map();
  }
  prepare(sql) { return new Statement(this, sql); }
  addStaff(id, name = '테스트교사', deleted = false) {
    this.staff.set(id, { data: JSON.stringify({ id, name, deleted }) });
  }
  addTask(data, owner = data.staffId) {
    this.tasks.set(data.id, { owner, data: JSON.stringify(data) });
  }
  addCheck(k, data, owner = 'teacher-1') {
    this.checks.set(k, { owner, data: JSON.stringify(data) });
  }
  addToken(raw, staffId) { this.tokens.set(raw, { staff_id: staffId }); }
  async first(sql, args) {
    if (sql.startsWith('SELECT staff_id FROM tokens')) return this.tokens.get(args[2]) || null;
    if (sql.startsWith('SELECT data FROM staff WHERE app=? AND id=?')) return this.staff.get(args[1]) || null;
    if (sql.startsWith('SELECT * FROM director_report_sends WHERE app=? AND idempotency_key=?')) {
      return [...this.sends.values()].find(row => row.app === args[0] && row.idempotency_key === args[1]) || null;
    }
    throw new Error('Unhandled first SQL: ' + sql);
  }
  async all(sql, args) {
    if (sql.startsWith('SELECT id,data FROM tasks WHERE app=? AND owner=?')) {
      return { results: [...this.tasks.entries()]
        .filter(([, row]) => row.owner === args[1])
        .map(([id, row]) => ({ id, data: row.data })) };
    }
    if (sql.startsWith('SELECT k,data FROM checks WHERE app=? AND owner=? AND k LIKE ?')) {
      const suffix = String(args[2]).slice(1);
      return { results: [...this.checks.entries()]
        .filter(([k, row]) => row.owner === args[1] && k.endsWith(suffix))
        .map(([k, row]) => ({ k, data: row.data })) };
    }
    throw new Error('Unhandled all SQL: ' + sql);
  }
  async run(sql, args) {
    if (sql.startsWith('INSERT OR IGNORE INTO director_report_sends')) {
      const [app, send_id, idempotency_key, report_date, staff_id, recipient_slot,
        total_count, done_count, doing_count, todo_count, blocked_count, message_hash,
        created_at, updated_at] = args;
      const duplicate = [...this.sends.values()].some(row =>
        row.app === app && row.idempotency_key === idempotency_key);
      const sameStaff = [...this.sends.values()].filter(row =>
        row.app === app && row.report_date === report_date && row.staff_id === staff_id).length;
      const sameDay = [...this.sends.values()].filter(row =>
        row.app === app && row.report_date === report_date).length;
      if (duplicate || sameStaff >= 2 || sameDay >= 30) return { meta: { changes: 0 } };
      this.sends.set(send_id, {
        app, send_id, idempotency_key, report_date, staff_id, recipient_slot,
        total_count, done_count, doing_count, todo_count, blocked_count, message_hash,
        status: 'reserved', provider_group_id: null, provider_message_id: null,
        provider_status_code: null, safe_error_code: null, dispatch_started_at: null,
        created_at, updated_at
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status='dispatching'")) {
      const [dispatch_started_at, updated_at, app, sendId] = args;
      const row = this.sends.get(sendId);
      if (!row || row.app !== app || row.status !== 'reserved') return { meta: { changes: 0 } };
      Object.assign(row, { status: 'dispatching', dispatch_started_at, updated_at });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE director_report_sends SET status=?')) {
      const [status, provider_group_id, provider_message_id, provider_status_code,
        safe_error_code, updated_at, app, sendId] = args;
      const row = this.sends.get(sendId);
      if (!row || row.app !== app || row.status !== 'dispatching') return { meta: { changes: 0 } };
      Object.assign(row, { status, provider_group_id, provider_message_id,
        provider_status_code, safe_error_code, updated_at });
      return { meta: { changes: 1 } };
    }
    throw new Error('Unhandled run SQL: ' + sql);
  }
}

const adminAuth = { mode: 'admin', secret: 'director-secret' };
const personAuth = { mode: 'person', id: 'teacher-1', token: 'person-token' };
const fullConfig = {
  WB_SEND_MODE: 'test',
  WB_TEST_RECIPIENT_ID: 'TEST-SMS-001',
  WB_ACTUAL_TEST_SEND_APPROVED: 'true',
  SOLAPI_API_KEY: 'test-api-key',
  SOLAPI_API_SECRET: 'test-api-secret',
  SOLAPI_SENDER_NUMBER: '0212345678',
  SOLAPI_TEST_RECIPIENT_PHONE: '01012345678'
};

function dailyTask(id, extra = {}) {
  return { id, staffId: 'teacher-1', repeat: 'daily', deleted: false, ...extra };
}

function acceptedResponse(index = 1) {
  return new Response(JSON.stringify({
    groupInfo: { groupId: 'GROUP_' + index },
    messageList: [{ messageId: 'MESSAGE_' + index, statusCode: '2000', statusMessage: 'raw provider text' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function call(db, body, envPatch = {}) {
  const response = await worker.fetch(new Request('https://worker.example/director-report-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), {
    DB: db,
    TASK_ADMIN_SECRET: 'director-secret',
    CONSULT_ADMIN_SECRET: 'consult-secret',
    ...envPatch
  });
  return { status: response.status, body: await response.json() };
}

async function withFetch(stub, action) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); }
  finally { globalThis.fetch = original; }
}

test('schema migration is additive, constrained, and stores no phone, body, or raw provider response', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS director_report_sends/);
    assert.match(sql, /recipient_slot\s*=\s*'TEST-SMS-001'/);
    assert.match(sql, /UNIQUE \(app, idempotency_key\)/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
  const table = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf('CREATE INDEX'));
  assert.doesNotMatch(table, /phone|message_body|raw_response|provider_response/i);
});

test('KST date conversion is stable across the UTC day boundary', () => {
  assert.equal(kstDateFromMs(Date.parse('2026-08-03T14:59:59Z')), '2026-08-03');
  assert.equal(kstDateFromMs(Date.parse('2026-08-03T15:00:00Z')), '2026-08-04');
});

test('summary matches task UI recurrence and status priority without exposing task content', () => {
  const yesterday = new Date(Date.parse(TODAY + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const tasks = [
    dailyTask('done'),
    { ...dailyTask('blocked'), repeat: 'once', start: TODAY },
    { ...dailyTask('steps'), repeat: 'days', days: [DOW], steps: [{ id: 's1' }] },
    { ...dailyTask('target'), target: 5 },
    { ...dailyTask('step-priority'), steps: [{ id: 's1' }], target: 5 },
    dailyTask('todo'),
    { ...dailyTask('outside'), repeat: 'once', start: yesterday },
    { ...dailyTask('deleted'), deleted: true }
  ].map(data => ({ id: data.id, data: JSON.stringify(data) }));
  const checks = [
    ['done', { done: 1 }],
    ['blocked', { done: 1, blocked: 1 }],
    ['steps', { steps: { s1: 1 } }],
    ['target', { count: 1 }],
    ['step-priority', { count: 2, steps: {} }]
  ].map(([id, data]) => ({ k: id + '|' + TODAY, data: JSON.stringify({ taskId: id, date: TODAY, ...data }) }));
  assert.deepEqual(summarizeReportRows(tasks, checks, 'teacher-1', TODAY), {
    done: 1, total: 6, doing: 2, todo: 2, blocked: 1, pct: 17
  });
  const text = buildDirectorReportText(TODAY, '테스트교사', {
    done: 1, total: 6, doing: 2, todo: 2, blocked: 1, pct: 17
  });
  assert.match(text, /담당: 테스트교사/);
  assert.match(text, /수행률 17%/);
  assert.match(text, /상세 내용은 업무지시서 원장 화면에서 확인해 주세요/);
  assert.match(text, /https:\/\/whdudwns33-wb\.github\.io\/wb-site\/task\//);
  assert.doesNotMatch(text, /done|blocked|step-priority/);
});

test('WebCrypto HMAC authorization signs date plus salt', async () => {
  const date = '2026-08-04T01:02:03.000Z';
  const salt = 'fixed-salt';
  const header = await buildSolapiAuthorization('api-key', 'api-secret', date, salt);
  const signature = createHmac('sha256', 'api-secret').update(date + salt).digest('hex');
  assert.equal(header, 'HMAC-SHA256 apiKey=api-key, date=' + date + ', salt=' + salt + ', signature=' + signature);
});

test('authentication, own scope, active staff, and KST-today are enforced before fetch', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1');
  db.addStaff('teacher-2');
  db.addStaff('inactive', '비활성교사', true);
  db.addToken('person-token', 'teacher-1');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; throw new Error('must not fetch'); }, async () => {
    let result = await call(db, { reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 401);
    result = await call(db, { auth: personAuth, staffId: 'teacher-2', reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 403);
    result = await call(db, { auth: adminAuth, reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 400);
    result = await call(db, { auth: adminAuth, staffId: 'inactive', reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 404);
    result = await call(db, { auth: personAuth, reportDate: '2000-01-01' }, fullConfig);
    assert.equal(result.status, 400);
  });
  assert.equal(fetches, 0);
});

test('client summary and every recipient or message field are rejected with zero fetches', async () => {
  const forbidden = ['summary', 'phone', 'to', 'from', 'message', 'recipient', 'guardianId'];
  for (const key of forbidden) {
    const db = new FakeDB();
    db.addStaff('teacher-1');
    db.addToken('person-token', 'teacher-1');
    let fetches = 0;
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, { auth: personAuth, reportDate: TODAY, [key]: key === 'summary' ? { done: 999 } : 'forged' }, fullConfig);
      assert.equal(result.status, 400, key);
    });
    assert.equal(fetches, 0, key);
  }
  const nestedDb = new FakeDB();
  nestedDb.addStaff('teacher-1');
  nestedDb.addToken('person-token', 'teacher-1');
  const nested = await call(nestedDb, {
    auth: { ...personAuth, message: 'forged' }, reportDate: TODAY
  }, fullConfig);
  assert.equal(nested.status, 400);
});

test('every send gate and secret is required and missing configuration performs zero fetches', async () => {
  const required = Object.keys(fullConfig);
  for (const missing of required) {
    const db = new FakeDB();
    db.addStaff('teacher-1');
    db.addToken('person-token', 'teacher-1');
    const config = { ...fullConfig };
    delete config[missing];
    let fetches = 0;
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, { auth: personAuth, reportDate: TODAY }, config);
      assert.equal(result.status, 503, missing);
      assert.equal(result.body.code, 'TEST_SEND_DISABLED');
    });
    assert.equal(fetches, 0, missing);
  }
});

test('successful request sends one server-built LMS to the fixed secret slot and reports accepted as 접수', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1', '테스트교사');
  db.addToken('person-token', 'teacher-1');
  db.addTask(dailyTask('private-task', { title: '비공개 업무 제목', studentName: '학생비공개' }));
  db.addCheck('private-task|' + TODAY, { taskId: 'private-task', date: TODAY, done: true, note: '비공개 메모' });
  let captured;
  const result = await withFetch(async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return acceptedResponse(1);
  }, () => call(db, { auth: personAuth, reportDate: TODAY }, fullConfig));

  assert.equal(result.status, 200);
  assert.equal(result.body.recipientLabel, '원장님 본인');
  assert.equal(result.body.send.status, 'accepted');
  assert.equal(result.body.send.statusLabel, '접수');
  assert.equal(result.body.send.acceptedMeans, '접수');
  assert.deepEqual(result.body.summary, { done: 1, total: 1, doing: 0, todo: 0, blocked: 0, pct: 100 });
  assert.equal(captured.url, directorReportConstants.SOLAPI_SEND_URL);
  assert.match(captured.options.headers.Authorization, /^HMAC-SHA256 apiKey=test-api-key, date=.+, salt=.+, signature=[a-f0-9]{64}$/);
  assert.equal(captured.body.messages.length, 1);
  assert.equal(captured.body.messages[0].to, fullConfig.SOLAPI_TEST_RECIPIENT_PHONE);
  assert.equal(captured.body.messages[0].from, fullConfig.SOLAPI_SENDER_NUMBER);
  assert.equal(captured.body.messages[0].type, 'LMS');
  assert.equal(captured.body.messages[0].autoTypeDetect, false);
  assert.equal(captured.body.strict, true);
  assert.equal(captured.body.allowDuplicates, false);
  assert.equal(captured.body.showMessageList, true);
  assert.match(captured.body.messages[0].text, /담당: 테스트교사/);
  assert.doesNotMatch(captured.body.messages[0].text, /비공개 업무 제목|학생비공개|비공개 메모/);

  const ledger = [...db.sends.values()][0];
  const stored = JSON.stringify(ledger);
  assert.equal(ledger.recipient_slot, 'TEST-SMS-001');
  assert.doesNotMatch(stored, /01012345678|0212345678|비공개 업무 제목|학생비공개|비공개 메모|raw provider text/);
  assert.equal(Object.hasOwn(ledger, 'body'), false);
  assert.equal(Object.hasOwn(ledger, 'phone'), false);
});

test('admin can send only for an explicitly selected active staff member and consult stays blocked', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1');
  db.addTask(dailyTask('task-a'));
  let fetches = 0;
  await withFetch(async () => acceptedResponse(++fetches), async () => {
    const result = await call(db, {
      auth: adminAuth, staffId: 'teacher-1', reportDate: TODAY
    }, fullConfig);
    assert.equal(result.status, 200);
    assert.equal(result.body.recipientLabel, '원장님 본인');
  });
  assert.equal(fetches, 1);

  let consultFetches = 0;
  await withFetch(async () => { consultFetches += 1; return acceptedResponse(); }, async () => {
    const response = await worker.fetch(new Request('https://worker.example/director-report-send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' }, staffId: 'teacher-1', reportDate: TODAY })
    }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret', ...fullConfig });
    assert.equal(response.status, 400);
  });
  assert.equal(consultFetches, 0);
});

test('same snapshot is idempotent and concurrent double click invokes the provider once', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1');
  db.addToken('person-token', 'teacher-1');
  db.addTask(dailyTask('task-a'));
  let fetches = 0;
  const [first, second] = await withFetch(async () => {
    fetches += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return acceptedResponse(fetches);
  }, () => Promise.all([
    call(db, { auth: personAuth, reportDate: TODAY }, fullConfig),
    call(db, { auth: personAuth, reportDate: TODAY }, fullConfig)
  ]));
  assert.equal(fetches, 1);
  assert.equal(db.sends.size, 1);
  assert.equal(first.body.send.sendId, second.body.send.sendId);
  assert.ok(first.body.idempotent || second.body.idempotent);
});

test('staff daily limit is two distinct server snapshots and global daily limit is thirty', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1');
  db.addToken('person-token', 'teacher-1');
  db.addTask(dailyTask('task-a', { target: 2 }));
  let fetches = 0;
  await withFetch(async () => acceptedResponse(++fetches), async () => {
    let result = await call(db, { auth: personAuth, reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 200);
    db.addCheck('task-a|' + TODAY, { taskId: 'task-a', date: TODAY, count: 1 });
    result = await call(db, { auth: personAuth, reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 200);
    db.addCheck('task-a|' + TODAY, { taskId: 'task-a', date: TODAY, done: true, count: 2 });
    result = await call(db, { auth: personAuth, reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 429);
    assert.equal(result.body.code, 'DAILY_SEND_LIMIT');
  });
  assert.equal(fetches, 2);

  const globalDb = new FakeDB();
  globalDb.addStaff('teacher-1');
  globalDb.addToken('person-token', 'teacher-1');
  globalDb.addTask(dailyTask('task-a'));
  for (let index = 0; index < 30; index += 1) {
    globalDb.sends.set('seed-' + index, {
      app: 'task', send_id: 'seed-' + index, idempotency_key: 'key-' + index,
      report_date: TODAY, staff_id: 'other-' + index, status: 'accepted'
    });
  }
  let globalFetches = 0;
  await withFetch(async () => { globalFetches += 1; return acceptedResponse(); }, async () => {
    const result = await call(globalDb, { auth: personAuth, reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 429);
  });
  assert.equal(globalFetches, 0);
});

test('timeout or network uncertainty becomes unknown and is never automatically retried', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1');
  db.addToken('person-token', 'teacher-1');
  db.addTask(dailyTask('task-a'));
  let fetches = 0;
  await withFetch(async () => { fetches += 1; throw new Error('sensitive network detail 01099999999'); }, async () => {
    let result = await call(db, { auth: personAuth, reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 202);
    assert.equal(result.body.send.status, 'unknown');
    assert.equal(result.body.send.errorCode, 'SOLAPI_NETWORK');
    assert.doesNotMatch(JSON.stringify(result.body), /sensitive network detail|01099999999/);
    result = await call(db, { auth: personAuth, reportDate: TODAY }, fullConfig);
    assert.equal(result.status, 202);
    assert.equal(result.body.idempotent, true);
  });
  assert.equal(fetches, 1);
  assert.doesNotMatch(JSON.stringify([...db.sends.values()]), /sensitive network detail|01099999999/);
});

test('provider HTTP errors are redacted and never retried', async () => {
  for (const [statusCode, expectedState] of [[400, 'rejected'], [503, 'unknown']]) {
    const db = new FakeDB();
    db.addStaff('teacher-1');
    db.addToken('person-token', 'teacher-1');
    db.addTask(dailyTask('task-a'));
    let fetches = 0;
    const result = await withFetch(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ errorMessage: 'provider secret 01099999999' }), { status: statusCode });
    }, () => call(db, { auth: personAuth, reportDate: TODAY }, fullConfig));
    assert.equal(result.body.send.status, expectedState);
    assert.doesNotMatch(JSON.stringify(result.body), /provider secret|01099999999/);
    assert.equal(fetches, 1);
  }
});
const OPS_TOKEN = 'A'.repeat(43);

function opsEnv(overrides = {}) {
  const config = {
    token: OPS_TOKEN,
    nonce: 'ops-once-test-1',
    staffId: 'teacher-1',
    reportDate: TODAY,
    expiresAt: Date.now() + (5 * 60 * 1000),
    ...overrides
  };
  return { WB_DIRECTOR_REPORT_ONESHOT: JSON.stringify(config) };
}

function opsBody(overrides = {}) {
  return {
    auth: { mode: 'ops_once', secret: OPS_TOKEN },
    staffId: 'teacher-1',
    reportDate: TODAY,
    ...overrides
  };
}

test('ops_once stays disabled while the global approval gate is closed', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1');
  db.addTask(dailyTask('task-a'));
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const result = await call(db, opsBody(), {
      ...fullConfig,
      ...opsEnv(),
      WB_ACTUAL_TEST_SEND_APPROVED: 'false'
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'TEST_SEND_DISABLED');
  });
  assert.equal(fetches, 0);
  assert.equal(db.sends.size, 0);
});

test('ops_once nonce is idempotent across repeats, concurrency, and a changed summary', async () => {
  const db = new FakeDB();
  db.addStaff('teacher-1');
  db.addTask(dailyTask('task-a'));
  let fetches = 0;
  const env = { ...fullConfig, ...opsEnv() };
  const [first, second] = await withFetch(async () => {
    fetches += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return acceptedResponse(fetches);
  }, () => Promise.all([
    call(db, opsBody(), env),
    call(db, opsBody(), env)
  ]));
  assert.equal(fetches, 1);
  assert.equal(first.body.sendId, second.body.sendId);
  assert.equal(db.sends.size, 1);

  db.addTask(dailyTask('task-added-after-first-send'));
  const third = await withFetch(async () => {
    fetches += 1;
    return acceptedResponse(fetches);
  }, () => call(db, opsBody(), env));
  assert.equal(third.body.sendId, first.body.sendId);
  assert.equal(fetches, 1);
  assert.equal(db.sends.size, 1);
});

test('ops_once rejects malformed, expired, overlong, mismatched, or expanded credentials', async () => {
  const yesterday = new Date(Date.parse(TODAY + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const cases = [
    { name: 'secret absent', body: opsBody(), env: {} },
    { name: 'wrong token', body: opsBody({ auth: { mode: 'ops_once', secret: 'B'.repeat(43) } }), env: opsEnv() },
    { name: 'short token', body: opsBody({ auth: { mode: 'ops_once', secret: 'short' } }), env: opsEnv({ token: 'short' }) },
    { name: 'expired', body: opsBody(), env: opsEnv({ expiresAt: Date.now() - 1 }) },
    { name: 'over ttl', body: opsBody(), env: opsEnv({ expiresAt: Date.now() + (16 * 60 * 1000) }) },
    { name: 'wrong staff', body: opsBody({ staffId: 'teacher-2' }), env: opsEnv() },
    { name: 'wrong date', body: opsBody({ reportDate: yesterday }), env: opsEnv() },
    { name: 'auth extra key', body: opsBody({ auth: { mode: 'ops_once', secret: OPS_TOKEN, id: 'teacher-1' } }), env: opsEnv() },
    { name: 'config extra key', body: opsBody(), env: opsEnv({ extra: 'forbidden' }) }
  ];
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    for (const item of cases) {
      const db = new FakeDB();
      db.addStaff('teacher-1');
      const result = await call(db, item.body, { ...fullConfig, ...item.env });
      assert.equal(result.status, 401, item.name);
      assert.equal(db.sends.size, 0, item.name);
    }
  });
  assert.equal(fetches, 0);
});

test('ops_once credential is limited to director-report-send and cannot authorize sync', async () => {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'task',
      auth: { mode: 'ops_once', secret: OPS_TOKEN },
      since: 0,
      changes: []
    })
  }), {
    DB: new FakeDB(),
    TASK_ADMIN_SECRET: 'director-secret',
    CONSULT_ADMIN_SECRET: 'consult-secret',
    ...opsEnv()
  });
  assert.equal(response.status, 401);
});
