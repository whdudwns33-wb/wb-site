import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateRosterDocument } from './roster.js';

const APP = 'task';
const APP_ORIGIN = 'https://whdudwns33-wb.github.io';
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requiredText(value, code) {
  if (typeof value !== 'string' || !value.trim()) fail(code);
  return value.trim();
}

function safeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(code);
  return value;
}

function teacherNames(value) {
  const names = requiredText(value, 'TEACHER_NAME_INVALID').split('·').map(name => name.trim());
  if (names.some(name => !name) || new Set(names).size !== names.length) fail('TEACHER_NAME_INVALID');
  return names;
}

function staffByName(staff) {
  if (!Array.isArray(staff)) fail('STAFF_LIST_INVALID');
  const result = new Map();
  const ids = new Set();
  staff.forEach(row => {
    if (!row || typeof row !== 'object') fail('STAFF_RECORD_INVALID');
    const id = safeId(row.id, 'STAFF_RECORD_INVALID');
    const name = requiredText(row.name, 'STAFF_RECORD_INVALID');
    if (ids.has(id)) fail('STAFF_ID_NOT_UNIQUE');
    if (result.has(name)) fail('STAFF_NAME_NOT_UNIQUE');
    ids.add(id);
    result.set(name, id);
  });
  return result;
}

function teacherIdentity(value, staffNames) {
  const names = teacherNames(value);
  const ids = names.map(name => {
    if (!staffNames.has(name)) fail('TEACHER_NOT_FOUND');
    return staffNames.get(name);
  });
  return { teacher: names.join('·'), teacherIds: ids };
}

const studentKey = (name, grade) => name + '\u0000' + grade;
const assignmentKey = (studentId, bookId) => studentId + '\u0000' + bookId;

function indexExisting(existingDocument) {
  const byStudent = new Map();
  const studentsByName = new Map();
  const byAssignment = new Map();
  const studentIds = new Set();
  const reservedIds = new Set();
  if (existingDocument == null) return { byStudent, studentsByName, byAssignment, studentIds, reservedIds };
  if (!existingDocument || !existingDocument.roster || !Array.isArray(existingDocument.roster.students) ||
      !Array.isArray(existingDocument.bookStudents)) fail('EXISTING_DOCUMENT_INVALID');

  const existingStudentIds = new Set();
  existingDocument.roster.students.forEach(row => {
    const id = safeId(row && row.id, 'EXISTING_DOCUMENT_INVALID');
    const name = requiredText(row && row.name, 'EXISTING_DOCUMENT_INVALID');
    const grade = requiredText(row && row.grade, 'EXISTING_DOCUMENT_INVALID');
    const key = studentKey(name, grade);
    if (byStudent.has(key)) fail('EXISTING_STUDENT_COLLISION');
    if (reservedIds.has(id)) fail('EXISTING_ID_COLLISION');
    byStudent.set(key, id);
    if (!studentsByName.has(name)) studentsByName.set(name, []);
    studentsByName.get(name).push({ id, name, grade });
    existingStudentIds.add(id);
    studentIds.add(id);
    reservedIds.add(id);
  });

  existingDocument.bookStudents.forEach(row => {
    const id = safeId(row && row.id, 'EXISTING_DOCUMENT_INVALID');
    const studentId = safeId(row && row.studentId, 'EXISTING_DOCUMENT_INVALID');
    const bookId = safeId(row && row.bookId, 'EXISTING_DOCUMENT_INVALID');
    teacherNames(row && row.teacher);
    if (!existingStudentIds.has(studentId)) fail('EXISTING_DOCUMENT_INVALID');
    const key = assignmentKey(studentId, bookId);
    if (byAssignment.has(key)) fail('EXISTING_ASSIGNMENT_COLLISION');
    if (reservedIds.has(id)) fail('EXISTING_ID_COLLISION');
    byAssignment.set(key, id);
    reservedIds.add(id);
  });
  return { byStudent, studentsByName, byAssignment, studentIds, reservedIds };
}

function freshId(prefix, reservedIds, makeUuid) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = prefix + String(makeUuid());
    if (SAFE_ID.test(candidate) && !reservedIds.has(candidate)) {
      reservedIds.add(candidate);
      return candidate;
    }
  }
  fail('ID_GENERATION_FAILED');
}

export function buildPrivateRosterDocument({
  rosterSource,
  textbooksSource,
  staff,
  existingDocument = null,
  makeUuid = randomUUID
}) {
  if (!rosterSource || typeof rosterSource !== 'object' || !Array.isArray(rosterSource.students)) {
    fail('ROSTER_SOURCE_INVALID');
  }
  if (!textbooksSource || typeof textbooksSource !== 'object' || !Array.isArray(textbooksSource.students)) {
    fail('TEXTBOOK_SOURCE_INVALID');
  }
  if (typeof makeUuid !== 'function') fail('ID_GENERATOR_INVALID');

  const staffNames = staffByName(staff);
  const existing = indexExisting(existingDocument);
  const sourceStudentKeys = new Set();
  const sourceByName = new Map();
  const rosterByName = new Map();

  const sourceStudents = rosterSource.students.map(row => {
    if (!row || typeof row !== 'object') fail('ROSTER_STUDENT_INVALID');
    const name = requiredText(row.name, 'ROSTER_STUDENT_INVALID');
    const grade = requiredText(row.grade, 'ROSTER_STUDENT_INVALID');
    const key = studentKey(name, grade);
    if (sourceStudentKeys.has(key)) fail('ROSTER_IDENTITY_COLLISION');
    sourceStudentKeys.add(key);
    const suppliedId = Object.prototype.hasOwnProperty.call(row, 'id')
      ? safeId(row.id, 'ROSTER_STUDENT_INVALID') : '';
    const item = { row, name, grade, key, suppliedId };
    if (!sourceByName.has(name)) sourceByName.set(name, []);
    sourceByName.get(name).push(item);
    return item;
  });

  sourceByName.forEach((sourceRows, name) => {
    const oldRows = existing.studentsByName.get(name) || [];
    if (!oldRows.length || (oldRows.length === 1 && sourceRows.length === 1)) return;
    const sameGrades = oldRows.length === sourceRows.length &&
      oldRows.every(oldRow => sourceRows.some(sourceRow => sourceRow.grade === oldRow.grade));
    if (!sameGrades && sourceRows.some(sourceRow => !sourceRow.suppliedId)) {
      fail('ROSTER_IDENTITY_AMBIGUOUS');
    }
  });

  const claimedExistingIds = new Set();
  const students = sourceStudents.map(item => {
    const { row, name, grade, key, suppliedId } = item;
    const teacher = teacherIdentity(row.teacher, staffNames);
    const exactId = existing.byStudent.get(key) || '';
    if (suppliedId && existingDocument !== null && !existing.studentIds.has(suppliedId)) {
      fail('ROSTER_ID_UNKNOWN');
    }
    if (suppliedId && exactId && suppliedId !== exactId) fail('ROSTER_ID_MISMATCH');
    const oldRows = existing.studentsByName.get(name) || [];
    const uniqueNameId = oldRows.length === 1 && sourceByName.get(name).length === 1 ? oldRows[0].id : '';
    if (suppliedId && uniqueNameId && suppliedId !== uniqueNameId) fail('ROSTER_ID_MISMATCH');
    const id = suppliedId || exactId || uniqueNameId || freshId('student-', existing.reservedIds, makeUuid);
    if (existing.studentIds.has(id)) {
      if (claimedExistingIds.has(id)) fail('ROSTER_ID_REUSED');
      claimedExistingIds.add(id);
    }
    existing.reservedIds.add(id);
    const result = {
      id,
      name,
      grade,
      teacher: teacher.teacher,
      subject: row.subject,
      start: row.start,
      end: row.end,
      reason: row.reason,
      teacherIds: teacher.teacherIds
    };
    if (Object.prototype.hasOwnProperty.call(row, 'memo')) result.memo = row.memo;
    if (!rosterByName.has(name)) rosterByName.set(name, []);
    rosterByName.get(name).push(result);
    return result;
  });

  const sourceAssignmentKeys = new Set();
  const bookStudents = textbooksSource.students.map(row => {
    if (!row || typeof row !== 'object') fail('BOOK_STUDENT_INVALID');
    const name = requiredText(row.name, 'BOOK_STUDENT_INVALID');
    const matches = rosterByName.get(name) || [];
    if (!matches.length) fail('BOOK_STUDENT_NOT_FOUND');
    if (matches.length !== 1) fail('BOOK_STUDENT_NAME_COLLISION');
    const student = matches[0];
    const teacher = teacherIdentity(row.teacher, staffNames);
    if (teacher.teacherIds.some(id => !student.teacherIds.includes(id))) fail('BOOK_TEACHER_NOT_ASSIGNED');
    const bookId = safeId(row.bookId, 'BOOK_STUDENT_INVALID');
    const key = assignmentKey(student.id, bookId);
    if (sourceAssignmentKeys.has(key)) fail('BOOK_ASSIGNMENT_COLLISION');
    sourceAssignmentKeys.add(key);
    return {
      id: existing.byAssignment.get(key) || freshId('book-', existing.reservedIds, makeUuid),
      studentId: student.id,
      name,
      teacher: teacher.teacher,
      bookId,
      at: row.at,
      perWeek: row.perWeek,
      goal: row.goal,
      teacherIds: teacher.teacherIds
    };
  });

  const roster = {
    updated: rosterSource.updated,
    baseline: rosterSource.baseline,
    students
  };
  if (Object.prototype.hasOwnProperty.call(rosterSource, 'note')) roster.note = rosterSource.note;
  return validateRosterDocument({ roster, bookStudents });
}

export function verifyPrivateRosterReadback(expected, actual) {
  if (!expected || !expected.roster || !Array.isArray(expected.roster.students) ||
      !Array.isArray(expected.bookStudents) || !actual || !actual.roster ||
      !Array.isArray(actual.roster.students) || !Array.isArray(actual.bookStudents)) {
    fail('ROSTER_READBACK_INVALID');
  }
  const studentIds = rows => rows.map(row => safeId(row && row.id, 'ROSTER_READBACK_INVALID')).sort();
  const assignments = rows => rows.map(row => [
    safeId(row && row.id, 'ROSTER_READBACK_INVALID'),
    safeId(row && row.studentId, 'ROSTER_READBACK_INVALID'),
    safeId(row && row.bookId, 'ROSTER_READBACK_INVALID')
  ].join('\u0000')).sort();
  if (JSON.stringify(studentIds(expected.roster.students)) !== JSON.stringify(studentIds(actual.roster.students)) ||
      JSON.stringify(assignments(expected.bookStudents)) !== JSON.stringify(assignments(actual.bookStudents))) {
    fail('ROSTER_READBACK_MISMATCH');
  }
  return {
    rosterCount: actual.roster.students.length,
    bookStudentCount: actual.bookStudents.length
  };
}

async function post(baseUrl, path, body) {
  let response;
  try {
    response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': APP_ORIGIN },
      body: JSON.stringify(body)
    });
  } catch (error) { fail('NETWORK_FAILED'); }
  let data;
  try { data = await response.json(); }
  catch (error) { fail('API_RESPONSE_INVALID'); }
  if (!response.ok || !data || data.ok !== true) {
    const error = new Error('API_REQUEST_FAILED');
    error.code = 'API_REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadActiveStaff(baseUrl, auth) {
  const rows = new Map();
  let since = 0;
  for (let round = 0; round < 100; round++) {
    const result = await post(baseUrl, '/sync', { app: APP, auth, since, changes: [] });
    (result.changes || []).forEach(change => {
      if (change && change.table === 'staff') rows.set(String(change.key || ''), change.data);
    });
    if (!result.more) {
      return Array.from(rows, ([id, data]) => ({ id, data }))
        .filter(row => row.data && !row.data.deleted)
        .map(row => ({ id: row.id, name: row.data.name }));
    }
    const next = Number(result.now);
    if (!Number.isFinite(next) || next <= since) fail('SYNC_PAGINATION_STALLED');
    since = next;
  }
  fail('SYNC_PAGINATION_LIMIT');
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { fail('SOURCE_READ_FAILED'); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) fail('USAGE_INVALID');
  const secret = String(process.env.TASK_ADMIN_SECRET || '').trim();
  if (!secret) fail('TASK_ADMIN_SECRET_MISSING');
  let url;
  try { url = new URL(String(process.env.SYNC_URL || '')); }
  catch (error) { fail('SYNC_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('SYNC_URL_INVALID');
  }
  const baseUrl = url.toString().replace(/\/+$/, '');
  const auth = { mode: 'admin', secret };

  const [rosterSource, textbooksSource] = await Promise.all(args.map(readJson));
  const staff = await loadActiveStaff(baseUrl, auth);
  let existingDocument = null;
  try {
    const existing = await post(baseUrl, '/roster', { app: APP, auth, action: 'get' });
    existingDocument = { roster: existing.roster, bookStudents: existing.bookStudents };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const document = buildPrivateRosterDocument({ rosterSource, textbooksSource, staff, existingDocument });
  await post(baseUrl, '/roster', { app: APP, auth, action: 'replace', document });
  const saved = await post(baseUrl, '/roster', { app: APP, auth, action: 'get' });
  const verified = verifyPrivateRosterReadback(document, saved);
  console.log(JSON.stringify({
    staffCount: staff.length,
    rosterCount: verified.rosterCount,
    bookStudentCount: verified.bookStudentCount,
    readbackVerified: true
  }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    console.error(error && error.code || 'IMPORT_FAILED');
    process.exitCode = 1;
  });
}
