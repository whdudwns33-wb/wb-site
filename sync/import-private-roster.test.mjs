import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPrivateRosterDocument, verifyPrivateRosterReadback } from './import-private-roster.mjs';

const staff = [
  { id: 'teacher-a', name: '가선생' },
  { id: 'teacher-b', name: '나선생' }
];

function sources() {
  return {
    rosterSource: {
      updated: '2026-08-10', baseline: '2026-08', note: '이관',
      students: [
        { name: '가학생', grade: '중1', teacher: '가선생', subject: '수학', start: '2026-08', end: '', reason: '' },
        { name: '겸임학생', grade: '고1', teacher: '가선생 · 나선생', subject: '수학·국어', start: '2026-08', end: '', reason: '' }
      ]
    },
    textbooksSource: {
      students: [
        { name: '가학생', teacher: '가선생', bookId: 'BK01', at: '1단원', perWeek: 2, goal: '1회독' },
        { name: '겸임학생', teacher: '나선생', bookId: 'BK02', at: '', perWeek: 1, goal: '복습' }
      ]
    }
  };
}

function uuids() {
  let next = 0;
  return () => '00000000-0000-4000-8000-' + String(++next).padStart(12, '0');
}

function studentIds() {
  let next = 10000000;
  return () => String(++next);
}

test('build preserves stable ids, maps exact teachers, and does not mutate sources', () => {
  const input = sources();
  const before = JSON.parse(JSON.stringify(input));
  const existingDocument = {
    roster: { students: [{ id: 'student-existing', name: '가학생', grade: '중1' }] },
    bookStudents: [{
      id: 'book-existing', studentId: 'student-existing', name: '가학생', teacher: '나선생', bookId: 'BK01'
    }]
  };
  const first = buildPrivateRosterDocument({ ...input, staff, existingDocument, makeUuid: uuids(), makeStudentId: studentIds() });
  assert.deepEqual(input, before);
  assert.equal(first.roster.students[0].id, 'student-existing');
  assert.deepEqual(first.roster.students[1].teacherIds, ['teacher-a', 'teacher-b']);
  assert.equal(first.bookStudents[0].id, 'book-existing');
  assert.equal(first.bookStudents[0].studentId, 'student-existing');
  assert.deepEqual(first.bookStudents[1].teacherIds, ['teacher-b']);
  assert.match(first.roster.students[1].id, /^[1-9]\d{7}$/);
  assert.match(first.bookStudents[1].id, /^book-[A-Za-z0-9_-]+$/);

  const second = buildPrivateRosterDocument({ ...input, staff, existingDocument: first, makeUuid: () => { throw new Error('unused'); } });
  assert.deepEqual(second.roster.students.map(row => row.id), first.roster.students.map(row => row.id));
  assert.deepEqual(second.bookStudents.map(row => row.id), first.bookStudents.map(row => row.id));
});

test('build preserves a unique student id through grade advancement', () => {
  const input = sources();
  const first = buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() });
  input.rosterSource.students[0].grade = '중2';
  const second = buildPrivateRosterDocument({
    ...input, staff, existingDocument: first, makeUuid: () => { throw new Error('unused'); }
  });
  assert.equal(second.roster.students[0].id, first.roster.students[0].id);
  assert.equal(second.bookStudents[0].id, first.bookStudents[0].id);
});

test('an explicit existing student id preserves identity through a name correction', () => {
  const input = sources();
  const first = buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() });
  input.rosterSource.students[0].id = first.roster.students[0].id;
  input.rosterSource.students[0].name = '가학생수정';
  input.textbooksSource.students[0].name = '가학생수정';
  const second = buildPrivateRosterDocument({
    ...input, staff, existingDocument: first, makeUuid: () => { throw new Error('unused'); }
  });
  assert.equal(second.roster.students[0].id, first.roster.students[0].id);
  assert.equal(second.bookStudents[0].id, first.bookStudents[0].id);
});

test('ambiguous same-name grade shifts fail closed without explicit ids', () => {
  const input = sources();
  input.rosterSource.students = [
    { name: '동명학생', grade: '중2', teacher: '가선생', subject: '수학', start: '2026-08', end: '', reason: '' },
    { name: '동명학생', grade: '중3', teacher: '가선생', subject: '수학', start: '2026-08', end: '', reason: '' }
  ];
  input.textbooksSource.students = [];
  const existingDocument = {
    roster: { students: [
      { id: 'same-one', name: '동명학생', grade: '중1' },
      { id: 'same-two', name: '동명학생', grade: '중2' }
    ] },
    bookStudents: []
  };
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, existingDocument, makeUuid: uuids() }),
    { message: 'ROSTER_IDENTITY_AMBIGUOUS' }
  );
});

test('explicit ids cannot be unknown or take an exact identity from another student', () => {
  const input = sources();
  const first = buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() });

  input.rosterSource.students[0].id = 'unknown-student';
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, existingDocument: first, makeUuid: uuids() }),
    { message: 'ROSTER_ID_UNKNOWN' }
  );

  input.rosterSource.students[0].id = first.roster.students[1].id;
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, existingDocument: first, makeUuid: uuids() }),
    { message: 'ROSTER_ID_MISMATCH' }
  );
});

test('an explicit id cannot take a unique-name student identity during grade advancement', () => {
  const input = sources();
  const first = buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() });
  input.rosterSource.students[0].grade = '중2';
  input.rosterSource.students[0].id = first.roster.students[1].id;
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, existingDocument: first, makeUuid: uuids() }),
    { message: 'ROSTER_ID_MISMATCH' }
  );
});

test('a genuinely new student receives a fresh id on a later import', () => {
  const input = sources();
  const first = buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() });
  input.rosterSource.students.push({
    name: '새학생', grade: '중1', teacher: '가선생', subject: '수학', start: '2026-08', end: '', reason: ''
  });
  const second = buildPrivateRosterDocument({
    ...input, staff, existingDocument: first, makeUuid: () => 'fresh-book', makeStudentId: () => '87654321'
  });
  assert.equal(second.roster.students[2].id, '87654321');
});

test('a supplied id for a fresh roster must be an eight-digit number', () => {
  const input = sources();
  input.rosterSource.students[0].id = 'student-custom';
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids(), makeStudentId: studentIds() }),
    { message: 'NEW_STUDENT_ID_INVALID' }
  );
});

test('same-name students use school, grade, then parent contacts as their registration identity', () => {
  const input = sources();
  input.rosterSource.students = [
    { name: '동명학생', school: '가초', grade: '3', phoneMother: '010-1111-1111', teacher: '가선생', subject: '', start: '2026-08', end: '', reason: '' },
    { name: '동명학생', school: '나초', grade: '3', phoneMother: '010-2222-2222', teacher: '가선생', subject: '', start: '2026-08', end: '', reason: '' },
    { name: '동명학생', school: '나초', grade: '3', phoneMother: '010-3333-3333', teacher: '가선생', subject: '', start: '2026-08', end: '', reason: '' }
  ];
  input.textbooksSource.students = [];
  const document = buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids(), makeStudentId: studentIds() });
  assert.equal(document.roster.students.length, 3);
  assert.deepEqual(document.roster.students.map(row => row.name), ['동명학생', '동명학생', '동명학생']);

  input.rosterSource.students.push({ ...input.rosterSource.students[2] });
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids(), makeStudentId: studentIds() }),
    { message: 'ROSTER_IDENTITY_COLLISION' }
  );
});

test('build rejects a missing teacher without putting the name in the error', () => {
  const input = sources();
  input.rosterSource.students[0].teacher = '없는선생';
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() }),
    error => error.message === 'TEACHER_NOT_FOUND' && !error.message.includes('없는선생')
  );
});

test('build rejects duplicate active staff names', () => {
  const input = sources();
  assert.throws(
    () => buildPrivateRosterDocument({
      ...input,
      staff: [{ id: 'teacher-a', name: '가선생' }, { id: 'teacher-other', name: '가선생' }],
      makeUuid: uuids()
    }),
    { message: 'STAFF_NAME_NOT_UNIQUE' }
  );
});

test('book student name must resolve to exactly one roster student', () => {
  const input = sources();
  input.rosterSource.students.push({
    name: '가학생', grade: '고2', teacher: '가선생', subject: '국어', start: '2026-08', end: '', reason: ''
  });
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() }),
    { message: 'BOOK_STUDENT_NAME_COLLISION' }
  );
});

test('book teacher must be a subset of the roster assignment', () => {
  const input = sources();
  input.textbooksSource.students[0].teacher = '나선생';
  assert.throws(
    () => buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() }),
    { message: 'BOOK_TEACHER_NOT_ASSIGNED' }
  );
});

test('post-import readback verifies student and assignment identities', () => {
  const input = sources();
  const document = buildPrivateRosterDocument({ ...input, staff, makeUuid: uuids() });
  const publicReadback = {
    roster: { ...document.roster, students: document.roster.students.map(({ teacherIds, ...row }) => row) },
    bookStudents: document.bookStudents.map(({ teacherIds, ...row }) => row)
  };
  assert.deepEqual(verifyPrivateRosterReadback(document, publicReadback), {
    rosterCount: 2, bookStudentCount: 2
  });

  publicReadback.bookStudents[0].studentId = publicReadback.roster.students[1].id;
  assert.throws(() => verifyPrivateRosterReadback(document, publicReadback), {
    message: 'ROSTER_READBACK_MISMATCH'
  });
});
