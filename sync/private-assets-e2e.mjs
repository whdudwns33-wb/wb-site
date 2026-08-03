import assert from 'node:assert/strict';

const base = process.env.WB_TEST_URL || 'http://127.0.0.1:8791';
const origin = process.env.WB_TEST_ORIGIN || 'https://whdudwns33-wb.github.io';
const taskSecret = process.env.WB_TEST_TASK_SECRET;
const consultSecret = process.env.WB_TEST_CONSULT_SECRET;
if (!taskSecret || !consultSecret) throw new Error('WB_TEST_TASK_SECRET와 WB_TEST_CONSULT_SECRET가 필요합니다.');

async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, headers: response.headers, data };
}

const adminAuth = { mode: 'admin', secret: taskSecret };
const adminRoster = await post('/private-asset', { app: 'task', auth: adminAuth, key: 'roster' });
assert.equal(adminRoster.status, 200);
assert.equal(adminRoster.data.data.students.length, 35);
assert.equal(adminRoster.data.hash, 'A6BFBDE544F54AE9B663FABE86E5A527A444CE4F3D023D4D3C0CCE234BED1C9B');
assert.equal(adminRoster.headers.get('cache-control'), 'no-store');

const adminBooks = await post('/private-asset', { app: 'task', auth: adminAuth, key: 'textbooks' });
assert.equal(adminBooks.status, 200);
assert.equal(adminBooks.data.data.students.length, 25);
assert.equal(adminBooks.data.data.books.length, 20);
assert.equal(adminBooks.data.data.vendors.length, 4);

const issued = await post('/bootstrap', { app: 'task', auth: adminAuth, staffId: 'staff_a' });
assert.equal(issued.status, 200);
const exchanged = await post('/exchange', { app: 'task', staffId: 'staff_a', code: issued.data.code });
assert.equal(exchanged.status, 200);
const personAuth = { mode: 'person', id: 'staff_a', token: exchanged.data.token };

const personRoster = await post('/private-asset', {
  app: 'task', auth: personAuth, key: 'roster', teacher: '다른 직원'
});
assert.equal(personRoster.status, 200);
assert.equal(personRoster.data.data.students.length, 15);
assert.ok(personRoster.data.data.students.every(student =>
  String(student.teacher || '').split(/[·,\/]/).map(value => value.trim()).includes('김남기')));
assert.deepEqual(Object.keys(personRoster.data.data).sort(), ['baseline', 'note', 'students', 'updated']);

const personBooks = await post('/private-asset', { app: 'task', auth: personAuth, key: 'textbooks' });
assert.equal(personBooks.status, 200);
assert.equal(personBooks.data.data.students.length, 0);
assert.equal(personBooks.data.data.books.length, 20);
assert.equal(personBooks.data.data.vendors.length, 4);
assert.deepEqual(Object.keys(personBooks.data.data).sort(), ['books', 'note', 'students', 'updated', 'vendors']);
const hashedSearchAuth = await post('/search', {
  app: 'task', auth: personAuth, q: '중등 수학 강좌'
});
assert.equal(hashedSearchAuth.status, 400);
assert.match(hashedSearchAuth.data.error, /검색 키가 설정되지 않았습니다/);
const hashedCurriculumAuth = await post('/curriculum', {
  app: 'task', auth: personAuth, url: 'http://127.0.0.1/private'
});
assert.equal(hashedCurriculumAuth.status, 400);
assert.match(hashedCurriculumAuth.data.error, /올바른 공개 강좌 주소/);

const consultDenied = await post('/private-asset', {
  app: 'consult', auth: { mode: 'admin', secret: consultSecret }, key: 'roster'
});
assert.equal(consultDenied.status, 404);
const invalidDenied = await post('/private-asset', {
  app: 'task', auth: { mode: 'admin', secret: 'invalid' }, key: 'roster'
});
assert.equal(invalidDenied.status, 401);

const revoked = await post('/revoke', { app: 'task', auth: adminAuth, staffId: 'staff_a' });
assert.equal(revoked.status, 200);
const afterRevoke = await post('/private-asset', { app: 'task', auth: personAuth, key: 'roster' });
assert.equal(afterRevoke.status, 401);

console.log(JSON.stringify({
  adminRoster: 35,
  adminTextbookStudents: 25,
  personRoster: 15,
  personTextbookStudents: 0,
  consultDenied: consultDenied.status,
  afterRevoke: afterRevoke.status
}));
