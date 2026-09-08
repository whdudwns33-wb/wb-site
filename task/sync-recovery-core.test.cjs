'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('./sync-recovery-core.js');

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function makeRecord(overrides) {
  return recovery.buildArchive(Object.assign({
    scopeId: 'person:teacher_example', accessRole: 'staff', dataGeneration: 3, createdAt: 1800000000000,
    error: { status: 409, code: 'LESSON_SCHEDULE_ENDPOINT_REQUIRED' },
    changes: [
      { table: 'tasks', id: 'lesson_example', owner: 'teacher_example', updated_at: 1800000000000,
        data: { id: 'lesson_example', title: '창작 독해 수업', studentName: '예시학생',
          scheduleSlots: [{ day: 2, time: '16:00', duration: 60 }],
          materials: [{ name: '창작 독해 활동지', progress: '두 문단 비교' }], updatedAt: 1800000000000 } },
      { table: 'checks', k: 'lesson_example|2026-09-08', owner: 'teacher_example', updated_at: 1800000000000,
        data: { attendance: 'P', memo: '주장과 근거를 스스로 구분함. 다음에는 반론을 연습할 것.',
          steps: [true, false], score: 0, updatedAt: 1800000000000 } }
    ]
  }, overrides));
}

test('archives every pending lesson and check without mutating source references', () => {
  const initial = makeRecord();
  const changes = initial.changes;
  const record = makeRecord({ changes });
  assert.deepEqual(record.changes, changes);
  changes[0].data.materials[0].progress = '외부 변경';
  assert.equal(record.changes[0].data.materials[0].progress, '두 문단 비교');
  assert.equal(record.scopeId, 'person:teacher_example');
  assert.equal(record.accessRole, 'staff');
  assert.equal(record.dataGeneration, 3);
  assert.equal(record.createdAt, 1800000000000);
  assert.match(record.id, /^recovery-/);
});

test('omits nested credential fields and raw error payload but preserves lesson fields', () => {
  const changes = makeRecord().changes;
  changes[0].auth = { token: 'do-not-store-a' };
  Object.assign(changes[0].data, { myToken: 'do-not-store-b', syncSecret: 'do-not-store-c',
    adminPin: 'do-not-store-d', password: 'do-not-store-e', tokenCount: 7,
    lessonCode: 'L-CREATED', key: 'lesson-key', settings: { auth: { secret: 'do-not-store-f' },
      access_token: 'do-not-store-g', cookie: 'do-not-store-h', note: '단어 token을 설명함' } });
  changes[1].data.rows = [{ refreshToken: 'do-not-store-i', memo: '반드시 보존할 메모' }];
  const record = makeRecord({ changes, auth: { token: 'do-not-store-j' },
    error: { status: 409, code: 'BOOK_ORDER_SEALED', message: 'do-not-store-k', current: { secret: 'do-not-store-l' } } });
  assert.doesNotMatch(JSON.stringify(record), /do-not-store/);
  assert.equal(record.changes[0].data.tokenCount, 7);
  assert.equal(record.changes[0].data.lessonCode, 'L-CREATED');
  assert.equal(record.changes[0].data.key, 'lesson-key');
  assert.equal(record.changes[0].data.settings.note, '단어 token을 설명함');
  assert.equal(record.changes[1].data.rows[0].memo, '반드시 보존할 메모');
  assert.deepEqual(record.error, { status: 409, code: 'BOOK_ORDER_SEALED' });
});

test('requires an explicit public scope and matching access role', () => {
  ['', 'teacher_example', { mode: 'person', token: 'secret' }, 'person:bad/id'].forEach(scopeId => {
    assert.throws(() => makeRecord({ scopeId }), { code: 'ARCHIVE_SCOPE_INVALID' });
  });
  assert.throws(() => makeRecord({ accessRole: '' }), { code: 'ARCHIVE_ROLE_INVALID' });
  assert.throws(() => makeRecord({ accessRole: 'admin' }), { code: 'ARCHIVE_ROLE_INVALID' });
  assert.throws(() => makeRecord({ scopeId: 'admin' }), { code: 'ARCHIVE_ROLE_INVALID' });
  assert.equal(makeRecord({ scopeId: 'admin', accessRole: 'admin' }).accessRole, 'admin');
});

test('refuses malformed snapshots rather than silently losing unsent data', () => {
  const changes = makeRecord().changes;
  changes[0].data.cycle = changes;
  assert.throws(() => makeRecord({ changes }), { code: 'ARCHIVE_DATA_INVALID' });
  assert.throws(() => makeRecord({ changes: [null] }), { code: 'ARCHIVE_DATA_INVALID' });
  assert.throws(() => makeRecord({ dataGeneration: -1 }), { code: 'ARCHIVE_METADATA_INVALID' });
  assert.throws(() => makeRecord({ createdAt: 0 }), { code: 'ARCHIVE_METADATA_INVALID' });
});

test('durably saves and reloads a scoped archive after read-back validation', () => {
  const storage = memoryStorage();
  const record = makeRecord();
  const result = recovery.saveArchive(storage, record);
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(recovery.readArchives(storage, record.scopeId), { ok: true, records: [record] });
  assert.equal(storage.length, 1);
});

test('deduplicates identical snapshots across repeated attempts and property order changes', () => {
  const storage = memoryStorage();
  const record = makeRecord();
  recovery.saveArchive(storage, record);
  const changes = record.changes.map(change => Object.fromEntries(Object.entries(change).reverse()));
  const duplicate = makeRecord({ changes, createdAt: record.createdAt + 60000, error: { status: 409, code: 'STALE_REVISION' } });
  const result = recovery.saveArchive(storage, duplicate);
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.record, record);
  assert.equal(storage.length, 1);
});

test('never deduplicates away changed work, a new generation, or a different role', () => {
  const storage = memoryStorage();
  const first = makeRecord();
  recovery.saveArchive(storage, first);
  const changes = makeRecord().changes;
  changes[1].data.memo += '\n새로 작성한 수업 메모';
  [makeRecord({ changes }), makeRecord({ dataGeneration: 4 }), makeRecord({ accessRole: 'manager' })].forEach(record => {
    assert.equal(recovery.saveArchive(storage, record).duplicate, false);
  });
  assert.equal(storage.length, 4);
  assert.equal(recovery.readArchives(storage, first.scopeId).records.length, 4);
});

test('does not evict older archives when many snapshots accumulate', () => {
  const storage = memoryStorage();
  for (let i = 0; i < 110; i++) {
    const record = makeRecord({ dataGeneration: i, createdAt: 1800000000000 + i });
    assert.equal(recovery.saveArchive(storage, record).ok, true);
  }
  const records = recovery.readArchives(storage, 'person:teacher_example').records;
  assert.equal(records.length, 110);
  assert.equal(records[109].dataGeneration, 0);
});

test('quota and disabled-storage failures never claim a safe archive or erase prior entries', () => {
  const storage = memoryStorage();
  const first = makeRecord();
  recovery.saveArchive(storage, first);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(recovery.saveArchive(storage, makeRecord({ dataGeneration: 4 })).ok, false);
  assert.deepEqual(recovery.readArchives(storage, first.scopeId).records, [first]);
  const disabled = { get length() { throw new Error('SecurityError'); } };
  assert.equal(recovery.saveArchive(disabled, first).ok, false);
});

test('silent write failure or corrupted read-back fails closed', () => {
  const record = makeRecord();
  const ignored = memoryStorage();
  ignored.setItem = () => {};
  assert.equal(recovery.saveArchive(ignored, record).ok, false);
  const corrupted = memoryStorage();
  const originalSet = corrupted.setItem;
  corrupted.setItem = (key, value) => originalSet(key, value.replace('두 문단 비교', '다른 내용'));
  assert.equal(recovery.saveArchive(corrupted, record).ok, false);
});

test('corrupted archives prevent destructive recovery and are not overwritten', () => {
  const storage = memoryStorage();
  const record = makeRecord();
  const key = recovery.archiveKey(record.scopeId, record.id);
  storage.setItem(key, '{broken');
  assert.equal(recovery.readArchives(storage, record.scopeId).code, 'ARCHIVE_CORRUPT');
  assert.equal(recovery.saveArchive(storage, record).ok, false);
  assert.equal(storage.getItem(key), '{broken');
});

test('archive reads reject injected credentials, mismatched identity and changed content', () => {
  const record = makeRecord();
  [copy => { copy.changes[0].data.token = 'do-not-show'; },
    copy => { copy.scopeId = 'person:other_teacher'; },
    copy => { copy.changes[1].data.memo = '우발적으로 손상된 내용'; }].forEach(tamper => {
    const storage = memoryStorage();
    const copy = JSON.parse(JSON.stringify(record));
    tamper(copy);
    storage.setItem(recovery.archiveKey(record.scopeId, record.id), JSON.stringify(copy));
    assert.equal(recovery.readArchives(storage, record.scopeId).ok, false);
  });
});

test('reads and explicit clearing remain inside the current public auth scope', () => {
  const storage = memoryStorage();
  const first = makeRecord();
  const other = makeRecord({ scopeId: 'person:other_teacher' });
  const admin = makeRecord({ scopeId: 'admin', accessRole: 'admin' });
  [first, other, admin].forEach(record => recovery.saveArchive(storage, record));
  storage.setItem('wb-task-state', 'preserved');
  assert.deepEqual(recovery.readArchives(storage, first.scopeId).records, [first]);
  assert.deepEqual(recovery.clearArchives(storage, first.scopeId), { ok: true, removed: 1 });
  assert.deepEqual(recovery.readArchives(storage, other.scopeId).records, [other]);
  assert.deepEqual(recovery.readArchives(storage, admin.scopeId).records, [admin]);
  assert.equal(storage.getItem('wb-task-state'), 'preserved');
});

test('clearing detects storage refusal and preserves malformed archive targets', () => {
  const storage = memoryStorage();
  const record = makeRecord();
  recovery.saveArchive(storage, record);
  storage.removeItem = () => {};
  assert.equal(recovery.clearArchives(storage, record.scopeId).ok, false);
  const key = recovery.archiveKey(record.scopeId, record.id);
  storage.setItem(key, '{}');
  assert.equal(recovery.clearArchives(storage, record.scopeId).ok, false);
  assert.equal(storage.getItem(key), '{}');
});

test('only ordinary HTTP 409 conflicts are recoverable by archive and refetch', () => {
  ['LESSON_SCHEDULE_ENDPOINT_REQUIRED', 'MAKEUP_ENDPOINT_REQUIRED', 'BOOK_ORDER_SEALED',
    'BOOK_ORDER_CREATE_REQUIRED', 'SESSION4_ATTENDANCE_LOCKED', '', 'FUTURE_CONFLICT'].forEach(code => {
    assert.equal(recovery.isRecoverableError({ status: 409, code }), true, code);
  });
  [null, { status: 409, code: 'DATA_GENERATION_MISMATCH' }, { status: 403 },
    { status: 401 }, { status: 500 }, { code: 'LESSON_SCHEDULE_ENDPOINT_REQUIRED' }].forEach(error => {
    assert.equal(recovery.isRecoverableError(error), false);
  });
});

test('explains conflicts, timeout, network and auth errors without echoing arbitrary messages', () => {
  assert.match(recovery.errorText({ code: 'LESSON_SCHEDULE_ENDPOINT_REQUIRED' }), /수업·시간표/);
  assert.match(recovery.errorText({ code: 'SESSION4_ATTENDANCE_LOCKED' }), /출결/);
  assert.match(recovery.errorText({ code: 'SYNC_TIMEOUT' }), /응답이 늦어/);
  assert.match(recovery.errorText({ name: 'AbortError' }), /응답이 늦어/);
  assert.match(recovery.errorText(new TypeError('Failed to fetch')), /인터넷 연결/);
  assert.match(recovery.errorText({ status: 403 }), /권한/);
  assert.match(recovery.errorText({ status: 409 }), /충돌/);
  assert.doesNotMatch(recovery.errorText({ message: 'do-not-show-sensitive-text' }), /do-not-show/);
});

test('human recovery rows retain complete memo and record identity while excluding credentials', () => {
  const record = makeRecord();
  record.changes[1].data.token = 'do-not-show';
  const rows = recovery.displayRows(record);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '창작 독해 수업');
  assert.equal(rows[0].label, '수업·업무');
  assert.equal(rows[1].key, 'lesson_example|2026-09-08');
  assert.match(rows[1].details, /주장과 근거를 스스로 구분함/);
  assert.equal(JSON.parse(rows[1].details).data.score, 0);
  assert.doesNotMatch(JSON.stringify(rows), /do-not-show/);
});
