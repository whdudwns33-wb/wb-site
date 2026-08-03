import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { normalizeSyncCursor } from './worker-core.js';

const TABLE_RANK = { staff: 0, tasks: 1, checks: 2 };

function comparePosition(a, b) {
  return Number(a.srv_at) - Number(b.srv_at) ||
    Number(a.table_rank) - Number(b.table_rank) ||
    String(a.row_key).localeCompare(String(b.row_key));
}

function row(table, key, srvAt) {
  return {
    table_name: table,
    table_rank: TABLE_RANK[table],
    row_key: key,
    owner: table === 'staff' ? key : 'owner-1',
    data: JSON.stringify({ id: key, updatedAt: srvAt }),
    updated_at: srvAt,
    srv_at: srvAt
  };
}

function fakeDb(rows) {
  const ordered = [...rows].sort(comparePosition);
  return {
    prepare(sql) {
      assert.match(sql, /UNION ALL/);
      assert.match(sql, /table_rank > ?/);
      assert.match(sql, /row_key > ?/);
      assert.match(sql, /ORDER BY srv_at ASC, table_rank ASC, row_key ASC LIMIT 2001/);
      return {
        bind(...params) {
          const [srvAtA, srvAtB, rankA, rankB, key] = params.slice(-5);
          assert.equal(srvAtA, srvAtB);
          assert.equal(rankA, rankB);
          const cursor = { srv_at: srvAtA, table_rank: rankA, row_key: key };
          return {
            async all() {
              return {
                results: ordered.filter(candidate => comparePosition(candidate, cursor) > 0).slice(0, 2001)
              };
            }
          };
        }
      };
    }
  };
}

async function pull(env, cursor) {
  const response = await worker.fetch(new Request('https://worker.test/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: 'task',
      auth: { mode: 'admin', secret: 'task-secret' },
      since: cursor.srv_at,
      cursor,
      changes: []
    })
  }), env);
  return { status: response.status, data: await response.json() };
}

async function pullAll(rows) {
  const env = { DB: fakeDb(rows), TASK_ADMIN_SECRET: 'task-secret', ALLOW_ORIGIN: '' };
  let cursor = { srv_at: 0, table_rank: -1, key: '' };
  const received = [];
  const pages = [];
  for (let guard = 0; guard < 10; guard++) {
    const result = await pull(env, cursor);
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    assert.ok(result.data.changes.length <= 2000);
    pages.push(result.data);
    received.push(...result.data.changes);
    const next = result.data.cursor;
    if (result.data.more) assert.notDeepEqual(next, cursor);
    cursor = next;
    if (!result.data.more) return { received, pages, cursor };
  }
  throw new Error('pagination did not finish');
}

test('legacy since is promoted without skipping rows at the same timestamp', () => {
  assert.deepEqual(normalizeSyncCursor({ since: 123 }), {
    srv_at: 123,
    table_rank: -1,
    key: ''
  });
  assert.equal(normalizeSyncCursor({ cursor: { srv_at: 1, table_rank: 3, key: '' } }), null);
});

test('older rows left in a large table are not skipped by a newer row in another table', async () => {
  const rows = Array.from({ length: 2500 }, (_, index) =>
    row('checks', 'check-' + String(index).padStart(4, '0'), 100));
  rows.push(row('staff', 'newer-staff', 200));

  const result = await pullAll(rows);
  assert.deepEqual(result.pages.map(page => [page.changes.length, page.more]), [
    [2000, true],
    [501, false]
  ]);
  assert.equal(result.received.length, 2501);
  assert.equal(new Set(result.received.map(change => change.table + ':' + change.key)).size, 2501);
  assert.equal(result.received.at(-1).key, 'newer-staff');
});

test('same-timestamp rows continue in table-rank and key order across pages', async () => {
  const rows = [];
  for (const table of ['staff', 'tasks', 'checks']) {
    for (let index = 0; index < 1000; index++) {
      rows.push(row(table, table + '-' + String(index).padStart(4, '0'), 500));
    }
  }

  const result = await pullAll(rows);
  assert.deepEqual(result.pages.map(page => [page.changes.length, page.more]), [
    [2000, true],
    [1000, false]
  ]);
  assert.deepEqual(result.pages[0].cursor, {
    srv_at: 500,
    table_rank: 1,
    key: 'tasks-0999'
  });
  assert.equal(new Set(result.received.map(change => change.table + ':' + change.key)).size, 3000);
});

test('terminal cursor overlaps its timestamp so a later lower-key write is not skipped', async () => {
  const initial = [row('tasks', 'task-z', 700)];
  const firstEnv = {
    DB: fakeDb(initial), TASK_ADMIN_SECRET: 'task-secret', ALLOW_ORIGIN: ''
  };
  const first = await pull(firstEnv, { srv_at: 0, table_rank: -1, key: '' });
  assert.equal(first.data.more, false);
  assert.deepEqual(first.data.cursor, { srv_at: 700, table_rank: -1, key: '' });

  const later = initial.concat(row('staff', 'staff-a', 700));
  const secondEnv = {
    DB: fakeDb(later), TASK_ADMIN_SECRET: 'task-secret', ALLOW_ORIGIN: ''
  };
  const second = await pull(secondEnv, first.data.cursor);
  assert.equal(second.status, 200);
  assert.deepEqual(second.data.changes.map(change => change.table + ':' + change.key),
    ['staff:staff-a', 'tasks:task-z']);
});
test('malformed composite cursor is rejected before querying D1', async () => {
  const env = {
    DB: { prepare() { throw new Error('D1 must not be queried'); } },
    TASK_ADMIN_SECRET: 'task-secret',
    ALLOW_ORIGIN: ''
  };
  const result = await pull(env, { srv_at: 1, table_rank: 9, key: '' });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /커서/);
});
