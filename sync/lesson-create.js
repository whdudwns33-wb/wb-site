import { studentChangeActorKey, studentChangeEventId, studentChangeEventStatement } from './student-change.js';
import { lessonCheckOwnerTransferStatement } from './lesson-history-transfer.js';
import { activeRosterStudent, lessonStudentIdsForStaff } from './book-order-student-scope.js';
import {
  isSessionPackTransferConflict,
  lessonSessionPackTransferStatements
} from './session-pack-transfer.js';
import { isTaskWriteCasConflict, taskWriteCasGuardStatement } from './task-write-cas.js';

const LESSON_TEXT_LIMITS = {
  studentName: 80,
  grade: 24,
  subject: 60,
  className: 100,
  lessonHours: 4,
  scheduleText: 600,
  materials: 2400,
  onlineProgram: 600,
  homework: 2400,
  studentTraits: 2400,
  goal: 1600,
  parentRequest: 1600,
  adminRequest: 1600,
  scheduleReviewReason: 300
};

const REQUIRED_TEXT_FIELDS = [
  'studentName',
  'grade',
  'materials',
  'onlineProgram',
  'homework',
  'studentTraits',
  'goal',
  'parentRequest'
];
const MAX_SCHEDULE_SLOTS = 20;
const MAX_BATCH_LESSONS = 10;
const MAX_STUDENT_BATCH_LESSONS = 50;
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_DISPLAY_RANK = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };
const LESSON_HOURS = new Set(['1T', '1.5T', '2T', '2.5T', '3T', '3.5T', '4T', '4.5T', '5T', '6T']);
const ROSTER_SUBJECTS = new Set(['국어', '영어', '수학', '사회', '과학', '독해사고력', '독해력수업', '독해력훈련', '사고력수학', '질답', '클리닉']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function textValue(value, limit, required) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  if (required && !text) throw new Error('필수 항목을 입력해 주세요');
  if (text.length > limit) throw new Error('입력 내용이 너무 깁니다');
  return text;
}

function optionalSafeId(value) {
  const id = String(value == null ? '' : value).trim();
  if (id && !SAFE_ID_RE.test(id)) throw new Error('학생 식별자를 확인해 주세요');
  return id;
}

function clockMinute(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 23) return null;
  return hour * 60 + Number(match[2]);
}

function clockText(minute) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

function dateValue(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('적용 시작일을 확인해 주세요');
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('적용 시작일을 확인해 주세요');
  }
  return text;
}

function normalizeWords(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[‐‑‒–—―−~～]/g, '-').replace(/\s+/g, ' ').trim();
}

function normalizeSlots(rawSlots, validFrom, lessonRole, fallbackLessonHours) {
  if (!Array.isArray(rawSlots)) return [];
  if (rawSlots.length > MAX_SCHEDULE_SLOTS) throw new Error('확정 시간은 최대 20개까지 입력할 수 있습니다');

  const normalized = rawSlots.map((raw, index) => {
    const days = [...new Set((Array.isArray(raw && raw.days) ? raw.days : [])
      .map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
    const startMinute = clockMinute(raw && raw.startTime);
    const endMinute = clockMinute(raw && raw.endTime);
    const lessonHours = textValue(raw && raw.lessonHours || fallbackLessonHours, 4, false);
    if (!days.length || startMinute === null || endMinute === null || endMinute <= startMinute || !LESSON_HOURS.has(lessonHours)) {
      throw new Error((index + 1) + '번째 확정 시간의 요일·시작·종료·수업시수를 확인해 주세요');
    }
    return {
      days,
      startTime: clockText(startMinute),
      endTime: clockText(endMinute),
      lessonHours,
      validFrom,
      lessonRole,
      status: 'normal'
    };
  });

  const seen = new Set();
  const canonical = normalized.filter(slot => {
    const key = [slot.days.join(','), slot.startTime, slot.endTime, slot.lessonHours].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) =>
    Math.min(...left.days) - Math.min(...right.days) ||
    left.startTime.localeCompare(right.startTime) ||
    left.endTime.localeCompare(right.endTime) ||
    left.days.join(',').localeCompare(right.days.join(','))
  );

  for (let leftIndex = 0; leftIndex < canonical.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < canonical.length; rightIndex += 1) {
      const left = canonical[leftIndex];
      const right = canonical[rightIndex];
      if (!left.days.some(day => right.days.includes(day))) continue;
      if (clockMinute(left.startTime) < clockMinute(right.endTime) &&
          clockMinute(right.startTime) < clockMinute(left.endTime)) {
        throw new Error('같은 요일에 겹치는 확정 시간이 있습니다');
      }
    }
  }

  return canonical.map((slot, index) => ({ ...slot, slotId: 'slot-' + (index + 1) }));
}

function scheduleTextFromSlots(slots) {
  const grouped = new Map();
  slots.forEach(slot => {
    const key = [slot.startTime, slot.endTime, slot.lessonHours].join('|');
    const current = grouped.get(key) || { days: [], startTime: slot.startTime, endTime: slot.endTime, lessonHours: slot.lessonHours };
    current.days.push(...slot.days);
    current.days = [...new Set(current.days)];
    grouped.set(key, current);
  });
  return Array.from(grouped.values()).sort((left, right) =>
    Math.min(...left.days.map(day => DAY_DISPLAY_RANK[day])) - Math.min(...right.days.map(day => DAY_DISPLAY_RANK[day])) ||
    left.startTime.localeCompare(right.startTime) || left.endTime.localeCompare(right.endTime)
  ).map(slot =>
    slot.days.slice().sort((left, right) => DAY_DISPLAY_RANK[left] - DAY_DISPLAY_RANK[right])
      .map(day => DAY_LABELS[day]).join('·') + ' ' + slot.startTime + '-' + slot.endTime + ' · ' + slot.lessonHours
  ).join(' / ');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function assignmentIdentityText(staffId, lesson) {
  if (lesson.studentId) {
    return [
      normalizeWords(staffId).replace(/\s+/g, ''),
      'student-id:' + lesson.studentId,
      normalizeWords(lesson.subject).replace(/\s+/g, ''),
      normalizeWords(lesson.className).replace(/\s+/g, ''),
      normalizeWords(lesson.lessonRole).replace(/\s+/g, '')
    ].join('\u001f');
  }
  return [staffId, lesson.studentName, lesson.grade, lesson.subject, lesson.className, lesson.lessonRole]
    .map(value => normalizeWords(value).replace(/\s+/g, '')).join('\u001f');
}

export async function lessonAssignmentKeyForStaff(task, staffId) {
  return 'sha256:' + await sha256Hex(assignmentIdentityText(staffId, task));
}

function contentIdentityText(input, slots, scheduleStatus, scheduleReviewReason) {
  const content = {
    studentName: input.studentName,
    grade: input.grade,
    subject: input.subject,
    className: input.className,
    lessonRole: input.lessonRole,
    scheduleText: input.scheduleText,
    slots: slots.map(slot => [slot.days, slot.startTime, slot.endTime, slot.lessonHours]),
    scheduleStatus,
    scheduleReviewReason,
    materials: input.materials,
    onlineProgram: input.onlineProgram,
    homework: input.homework,
    studentTraits: input.studentTraits,
    goal: input.goal,
    parentRequest: input.parentRequest,
    start: input.start
  };
  if (input.studentId) content.studentId = input.studentId;
  if (input.adminRequest !== '없음') content.adminRequest = input.adminRequest;
  return JSON.stringify(content);
}

function lessonGuide(input) {
  return [
    '■ 교재와 현재 진도\n' + input.materials,
    '■ 온라인 프로그램\n' + input.onlineProgram,
    '■ 숙제 루틴과 수행률\n' + input.homework,
    '■ 학생 특징\n' + input.studentTraits,
    '■ 지금 목표\n' + input.goal,
    '■ 특이사항·학부모 요청\n' + input.parentRequest,
    '■ 관리자 요청사항\n' + input.adminRequest
  ].join('\n\n');
}

export async function buildLessonTask(raw, staffId, origin, serverNow) {
  raw = raw && typeof raw === 'object' ? raw : {};
  for (const forbidden of [
    'id', 'taskId', 'groupId', 'staffId', 'origin', 'createdAt', 'updatedAt', 'deleted', 'steps',
    'lessonRevision', 'lessonAssignmentKey', 'lessonContentHash', 'lessonDedupeKey',
    'lessonFormVersion', 'intakeVersion', 'intakeSource',
    'weekendAttendanceMode', 'weekendAllowedDays', 'weekendMonthlyTarget', 'weekendFlexibleFrom'
  ]) {
    if (Object.prototype.hasOwnProperty.call(raw, forbidden)) {
      const error = new Error('서버가 정하는 필드는 보낼 수 없습니다');
      error.status = 403;
      throw error;
    }
  }

  const input = {};
  input.studentId = optionalSafeId(raw.studentId);
  for (const [key, limit] of Object.entries(LESSON_TEXT_LIMITS)) {
    input[key] = textValue(raw[key], limit, REQUIRED_TEXT_FIELDS.includes(key));
  }
  input.adminRequest = input.adminRequest || '없음';
  if (!input.subject && !input.className) throw new Error('과목 또는 반을 입력해 주세요');
  if (input.lessonHours && !LESSON_HOURS.has(input.lessonHours)) throw new Error('수업시수는 1T, 1.5T, 2T, 2.5T, 3T, 3.5T, 4T, 4.5T, 5T, 6T 중에서 선택해 주세요');
  input.start = dateValue(raw.start);
  input.lessonRole = textValue(raw.lessonRole || input.className || input.subject, 120, true);

  const requestedStatus = String(raw.scheduleStatus || '');
  let slots = normalizeSlots(raw.scheduleSlots, input.start, input.lessonRole, input.lessonHours);
  if (requestedStatus === 'needs_review' && slots.length) {
    throw new Error('확인 필요 시간표에는 일부 확정 시간을 함께 저장할 수 없습니다');
  }
  if (slots.length) {
    input.scheduleText = scheduleTextFromSlots(slots);
    input.scheduleReviewReason = '';
  } else if (!input.scheduleText) {
    throw new Error('수업 요일과 시간을 입력해 주세요');
  }
  const scheduleStatus = slots.length ? 'confirmed' : 'needs_review';
  const slotLessonHours = [...new Set(slots.map(slot => slot.lessonHours).filter(Boolean))];
  input.lessonHours = slotLessonHours.length === 1 ? slotLessonHours[0] : '';
  const scheduleReviewReason = scheduleStatus === 'needs_review'
    ? (input.scheduleReviewReason || '구조화된 요일·시작·종료 시간이 아직 확정되지 않았습니다') : '';

  const assignmentHash = await sha256Hex(assignmentIdentityText(staffId, input));
  const contentHash = await sha256Hex(contentIdentityText(input, slots, scheduleStatus, scheduleReviewReason));
  const id = 'lesson-' + assignmentHash.slice(0, 32);
  const days = [...new Set(slots.flatMap(slot => slot.days))].sort((a, b) => a - b);
  const time = slots.length ? slots.map(slot => slot.startTime).sort()[0] : '';
  const subjectLabel = [...new Set([input.subject, input.className].filter(Boolean))].join(' · ');
  const onlinePrograms = input.onlineProgram === '없음'
    ? [] : input.onlineProgram.split(/\s*[·,/]\s*/).filter(Boolean);

  return {
    id,
    groupId: 'lesson-form-' + assignmentHash.slice(0, 16),
    staffId,
    title: '[수업] ' + input.studentName + ' (' + input.grade + ') — ' + subjectLabel,
    detail: [input.grade, subjectLabel, input.scheduleText, input.onlineProgram !== '없음' ? input.onlineProgram : '']
      .filter(Boolean).join(' · '),
    guide: lessonGuide(input),
    steps: [
      '지난 숙제·온라인 수행 확인',
      '교재와 오늘 진도 진행',
      '이해도·오답·학생 반응 확인',
      '다음 숙제 안내',
      '실제 진도와 특이사항 기록'
    ].map((label, index) => ({ id: id + '-step-' + (index + 1), label })),
    target: 0,
    unit: '건',
    time,
    priority: 'normal',
    repeat: slots.length ? 'days' : 'once',
    days,
    start: input.start,
    end: '',
    carry: false,
    origin,
    createdAt: serverNow,
    updatedAt: serverNow,
    deleted: false,
    studentId: input.studentId,
    studentName: input.studentName,
    grade: input.grade,
    subject: input.subject,
    className: input.className,
    lessonRole: input.lessonRole,
    lessonHours: input.lessonHours,
    scheduleText: input.scheduleText,
    scheduleSlots: slots,
    scheduleStatus,
    scheduleReviewReason,
    materials: input.materials,
    onlineProgram: input.onlineProgram,
    onlinePrograms,
    homework: input.homework,
    studentTraits: input.studentTraits,
    goal: input.goal,
    parentRequest: input.parentRequest,
    adminRequest: input.adminRequest,
    taskKind: 'lesson_instruction',
    lessonFormVersion: 1,
    intakeVersion: 1,
    lessonRevision: 1,
    lessonAssignmentKey: 'sha256:' + assignmentHash,
    lessonContentHash: 'sha256:' + contentHash,
    lessonDedupeKey: 'sha256:' + assignmentHash,
    intakeSource: 'teacher_9_field_form'
  };
}

async function activeStaff(env, app, staffId) {
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  if (!row) return null;
  try {
    const staff = JSON.parse(row.data);
    return staff && !staff.deleted ? staff : null;
  } catch (error) { return null; }
}

function normalizedRosterText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
}

function validRosterFirstClassDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? text : '';
}

function sameLessonAssignmentIdentity(current, candidate) {
  return String(current && current.studentId || '') !== '' &&
    String(current.studentId) === String(candidate && candidate.studentId || '') &&
    ['subject', 'className', 'lessonRole'].every(key =>
      normalizedRosterText(current[key]) === normalizedRosterText(candidate && candidate[key]));
}

async function validateLessonStudentAccess(env, app, task, auth, options = {}) {
  const studentId = String(task && task.studentId || '');
  if (!studentId) {
    return auth.scope === 'own'
      ? { status: 400, error: '담당 원생 명단에서 학생을 선택해 주세요' }
      : null;
  }
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1')
    .bind(app).first();
  if (!row) return { status: 409, error: '원생 명단이 아직 준비되지 않았습니다' };
  let students;
  try {
    const document = JSON.parse(row.data || '{}');
    students = document && document.roster && document.roster.students;
  } catch (error) { return { status: 500, error: '저장된 원생 명단을 확인해 주세요' }; }
  if (!Array.isArray(students)) return { status: 500, error: '저장된 원생 명단을 확인해 주세요' };
  const student = students.find(item => item && item.id === studentId);
  if (!student) return { status: 409, error: '원생 명단에서 학생 식별자를 찾을 수 없습니다' };
  const referenceMonth = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  if (!activeRosterStudent(student, referenceMonth)) {
    return { status: 409, error: '현재 재원 중인 학생의 수업만 등록할 수 있습니다' };
  }
  if (auth.scope === 'own') {
    const assignedStudentIds = await lessonStudentIdsForStaff(env, app, auth.id);
    if (!assignedStudentIds.has(studentId)) {
      return { status: 403, error: '현재 담당 수업 학생만 등록할 수 있습니다' };
    }
  }
  if (normalizedRosterText(student.name) !== normalizedRosterText(task.studentName) ||
      normalizedRosterText(student.grade) !== normalizedRosterText(task.grade)) {
    return { status: 409, error: '원생 명단의 이름·학년과 수업 정보가 일치하지 않습니다' };
  }
  const firstClassDate = validRosterFirstClassDate(student.firstClassDate);
  if (options.enforceFirstClassDate && firstClassDate && String(task.start || '') < firstClassDate) {
    return { status: 409, error: '수업 적용 시작일은 원생 첫 수업 시작일 ' + firstClassDate + ' 이후여야 합니다' };
  }
  return null;
}

function batchRosterLabels(value) {
  return String(value || '').split(/[·,]/).map(label => label.trim()).filter(Boolean);
}

function batchRosterKstDate(now) {
  const values = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now)).forEach(part => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return values.year + '-' + values.month + '-' + values.day;
}

async function planBatchRosterLinks(env, app, planned, serverNow) {
  const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1')
    .bind(app).first();
  if (!row) return { error: '원생 명단이 아직 준비되지 않았습니다', status: 409 };
  let document;
  try { document = JSON.parse(row.data || '{}'); }
  catch (error) { return { error: '저장된 원생 명단을 확인해 주세요', status: 500 }; }
  const students = document && document.roster && document.roster.students;
  if (!Array.isArray(students)) return { error: '저장된 원생 명단을 확인해 주세요', status: 500 };
  const byId = new Map(students.map(student => [String(student && student.id || ''), student]));
  const beforeByStudentId = new Map();

  for (const item of planned) {
    const task = item.task;
    const student = byId.get(String(task.studentId || ''));
    if (!student) {
      return { error: '원생 명단에서 학생 식별자를 찾을 수 없습니다', status: 409 };
    }
    if (!beforeByStudentId.has(task.studentId)) {
      beforeByStudentId.set(task.studentId, JSON.stringify([student.subjects, student.subject]));
    }
    const subjects = Array.isArray(student.subjects) ? student.subjects.map(String) : batchRosterLabels(student.subject);
    if (ROSTER_SUBJECTS.has(task.subject)) subjects.push(task.subject);
    student.subjects = [...new Set(subjects.filter(subject => ROSTER_SUBJECTS.has(subject)))];
    student.subject = student.subjects.join('·');
  }

  const updatedCount = [...beforeByStudentId].filter(([studentId, before]) => {
    const student = byId.get(studentId);
    return JSON.stringify([student.subjects, student.subject]) !== before;
  }).length;
  if (!updatedCount) return { changed: false, updatedCount: 0 };
  document.roster.updated = batchRosterKstDate(serverNow);
  const expectedUpdatedAt = Number(row.updated_at);
  const updatedAt = Math.max(serverNow + planned.length, expectedUpdatedAt + 1);
  return {
    changed: true,
    updatedCount,
    expectedUpdatedAt,
    updatedAt,
    statement: env.DB.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=? AND updated_at=?')
      .bind(JSON.stringify(document), updatedAt, app, expectedUpdatedAt)
  };
}

function parseTaskRow(row) {
  if (!row) return null;
  try {
    return { task: JSON.parse(row.data), owner: row.owner == null ? '' : String(row.owner), updatedAt: Number(row.updated_at) };
  } catch (error) { return null; }
}

function isMakeupLessonInstance(task) {
  return !!task && (String(task.lessonInstanceType || '') === 'makeup' ||
    String(task.makeupCaseId || '').trim());
}

function isLessonIntake(task) {
  return task && !isMakeupLessonInstance(task) &&
    (task.lessonFormVersion || task.intakeVersion || task.intakeSource === 'teacher_9_field_form');
}

function isLegacyLessonTask(task) {
  return !!task && !task.deleted && !isMakeupLessonInstance(task) && /^\[수업\]/.test(String(task.title || ''));
}

async function findAssignmentRows(env, app, staffId, candidate) {
  const direct = parseTaskRow(await env.DB.prepare(
    'SELECT data,updated_at FROM tasks WHERE app=? AND id=? AND owner=? LIMIT 1'
  ).bind(app, candidate.id, staffId).first());
  if (direct) return [direct];

  const listed = await env.DB.prepare(
    'SELECT data,updated_at FROM tasks WHERE app=? AND owner=?'
  ).bind(app, staffId).all();
  const wanted = assignmentIdentityText(staffId, candidate);
  return (listed && Array.isArray(listed.results) ? listed.results : [])
    .map(parseTaskRow)
    .filter(Boolean)
    .filter(row => isLessonIntake(row.task) && assignmentIdentityText(staffId, row.task) === wanted);
}

async function contentHashForTask(task) {
  if (typeof task.lessonContentHash === 'string' && task.lessonContentHash.startsWith('sha256:')) {
    return task.lessonContentHash;
  }
  try {
    const role = task.lessonRole || task.className || task.subject;
    const slots = normalizeSlots(task.scheduleSlots || [], task.start, role, task.lessonHours);
    const status = slots.length ? 'confirmed' : 'needs_review';
    const reason = status === 'needs_review'
      ? (task.scheduleReviewReason || '구조화된 요일·시작·종료 시간이 아직 확정되지 않았습니다') : '';
    const hash = await sha256Hex(contentIdentityText(task, slots, status, reason));
    return 'sha256:' + hash;
  } catch (error) {
    return '';
  }
}

function revisionOf(task) {
  const revision = Number(task && task.lessonRevision);
  return Number.isInteger(revision) && revision >= 1 ? revision : 1;
}

function revisionConflict(json, origin, current, message) {
  return json({
    ok: false,
    error: message || '다른 곳에서 먼저 수정되었습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요',
    code: 'lesson_revision_conflict',
    task: current,
    revision: revisionOf(current)
  }, 409, origin);
}

function correctedTask(candidate, current, serverNow, actorRole) {
  const currentUpdatedAt = Number(current.updatedAt) || 0;
  const updatedAt = Math.max(Number(serverNow) || 0, currentUpdatedAt + 1);
  const id = current.id;
  const next = {
    ...candidate,
    id,
    groupId: current.groupId || candidate.groupId,
    staffId: candidate.staffId,
    steps: candidate.steps.map((step, index) => ({ ...step, id: id + '-step-' + (index + 1) })),
    origin: current.origin,
    createdAt: current.createdAt,
    updatedAt,
    lessonRevision: revisionOf(current) + 1,
    previousUpdatedAt: currentUpdatedAt || null,
    updatedByScope: actorRole
  };
  for (const key of [
    'weekendAttendanceMode', 'weekendAllowedDays', 'weekendMonthlyTarget', 'weekendFlexibleFrom'
  ]) {
    if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
  }
  return next;
}

export async function handleLessonCreate(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '업무지시서에서만 등록할 수 있습니다' }, 400, origin);
  body = body && typeof body === 'object' ? body : {};
  let staffId;
  let taskOrigin;
  if (auth.scope === 'own') {
    if (body.staffId && String(body.staffId) !== auth.id) {
      return json({ ok: false, error: '다른 선생님 수업은 등록할 수 없습니다' }, 403, origin);
    }
    staffId = auth.id;
    taskOrigin = 'staff';
  } else {
    staffId = String(body.staffId || '');
    taskOrigin = auth.role === 'manager' ? 'manager' : 'admin';
  }
  const targetStaff = /^[A-Za-z0-9_-]{1,128}$/.test(staffId) ? await activeStaff(env, app, staffId) : null;
  if (!targetStaff) {
    return json({ ok: false, error: '활성 담당 선생님을 선택해 주세요' }, 409, origin);
  }

  const sourceTaskId = body.sourceTaskId == null ? '' : String(body.sourceTaskId);
  if (sourceTaskId && !/^[A-Za-z0-9_-]{1,160}$/.test(sourceTaskId)) {
    return json({ ok: false, error: '수정할 수업 ID를 확인해 주세요' }, 400, origin);
  }
  if (auth.scope === 'own' && !sourceTaskId) {
    return json({
      ok: false,
      error: '새 과목 수업은 원장님께 학생 수업 등록 요청을 보내 주세요',
      code: 'lesson_assignment_approval_required'
    }, 403, origin);
  }

  let expectedRevision = null;
  if (body.expectedRevision != null) {
    expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return json({ ok: false, error: '수정 버전을 확인해 주세요' }, 400, origin);
    }
  }

  let expectedUpdatedAt = null;
  if (body.expectedUpdatedAt != null) {
    expectedUpdatedAt = Number(body.expectedUpdatedAt);
    if (!Number.isFinite(expectedUpdatedAt) || expectedUpdatedAt <= 0) {
      return json({ ok: false, error: '수정 기준 시각을 확인해 주세요' }, 400, origin);
    }
  }

  let task;
  try {
    task = await buildLessonTask(body.lesson, staffId, taskOrigin, Date.now());
  } catch (error) {
    return json({ ok: false, error: String(error && error.message || error) }, Number(error && error.status) || 400, origin);
  }
  const studentAccess = await validateLessonStudentAccess(env, app, task, auth);
  if (studentAccess) return json({ ok: false, error: studentAccess.error }, studentAccess.status, origin);

  let matches;
  let sourceOwner = staffId;
  let sourceStaff = targetStaff;
  if (sourceTaskId) {
    const sourceRow = parseTaskRow(await env.DB.prepare(
      'SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1'
    ).bind(app, sourceTaskId).first());
    if (!sourceRow) return json({ ok: false, error: '수정할 수업을 찾을 수 없습니다' }, 404, origin);
    sourceOwner = String(sourceRow.owner || sourceRow.task.staffId || '');
    if (auth.scope !== 'all' && sourceOwner !== staffId) {
      return json({ ok: false, error: '수정할 수업을 찾을 수 없습니다' }, 404, origin);
    }
    sourceStaff = sourceOwner === staffId ? targetStaff : await activeStaff(env, app, sourceOwner);
    if ((!isLessonIntake(sourceRow.task) && !(auth.scope === 'all' && isLegacyLessonTask(sourceRow.task))) ||
        (auth.scope !== 'all' && sourceRow.task.staffId && sourceRow.task.staffId !== staffId)) {
      return json({ ok: false, error: '이 수업은 수업 등록 및 변경 화면에서 정정할 수 없습니다' }, 409, origin);
    }
    if (String(sourceRow.task.studentId || '') !== String(task.studentId || '')) {
      const reassignmentAccess = await validateLessonStudentAccess(env, app, task, auth, {
        enforceFirstClassDate: true
      });
      if (reassignmentAccess) return json({ ok: false, error: reassignmentAccess.error }, reassignmentAccess.status, origin);
    }
    if (auth.scope === 'own' && !sameLessonAssignmentIdentity(sourceRow.task, task)) {
      return json({
        ok: false,
        error: '학생 또는 과목 배정 변경은 원장님께 수업 변경을 요청해 주세요',
        code: 'lesson_assignment_identity_locked'
      }, 403, origin);
    }
    const identityRows = await findAssignmentRows(env, app, staffId, task);
    if (identityRows.some(row => row.task.id !== sourceTaskId)) {
      return json({ ok: false, error: '변경하려는 학생·학년·과목 수업이 이미 등록되어 있습니다' }, 409, origin);
    }
    matches = [sourceRow];
  } else {
    matches = await findAssignmentRows(env, app, staffId, task);
  }
  if (matches.length > 1) {
    return json({
      ok: false,
      error: '같은 학생·과목·반 수업이 여러 건입니다. 원장이 먼저 중복을 정리해 주세요',
      code: 'lesson_assignment_ambiguous'
    }, 409, origin);
  }

  if (!sourceTaskId && matches.length === 0) {
    const newLessonAccess = await validateLessonStudentAccess(env, app, task, auth, {
      enforceFirstClassDate: true
    });
    if (newLessonAccess) return json({ ok: false, error: newLessonAccess.error }, newLessonAccess.status, origin);
  }

  if (matches.length === 1) {
    const row = matches[0];
    const current = row.task;
    const teacherTransferred = sourceTaskId && auth.scope === 'all' && sourceOwner !== staffId;
    if (current.deleted) {
      return json({ ok: false, error: '삭제된 수업과 같은 배정입니다. 원장에게 복구를 요청해 주세요' }, 409, origin);
    }
    if (!teacherTransferred && await contentHashForTask(current) === task.lessonContentHash) {
      return json({
        ok: true,
        task: current,
        created: false,
        duplicate: true,
        updated: false,
        idempotent: true,
        revision: revisionOf(current)
      }, 200, origin);
    }

    if (auth.scope === 'own' && current.origin !== 'staff') {
      return json({
        ok: false,
        error: '원장이 등록한 수업은 직접 수정할 수 없습니다. 원장에게 정정을 요청해 주세요',
        code: 'lesson_update_forbidden'
      }, 403, origin);
    }

    const currentRevision = revisionOf(current);
    if (expectedRevision === null && expectedUpdatedAt === null) {
      return revisionConflict(
        json, origin, current,
        '이미 등록된 수업과 내용이 다릅니다. 최신 내용을 확인한 뒤 정정 저장해 주세요'
      );
    }
    if (expectedRevision !== null && expectedRevision !== currentRevision) {
      return revisionConflict(json, origin, current);
    }
    if (expectedUpdatedAt !== null && expectedUpdatedAt !== Number(current.updatedAt)) {
      return revisionConflict(json, origin, current);
    }

    const corrected = correctedTask(task, current, Date.now(), taskOrigin);
    const databaseUpdatedAt = Number.isFinite(row.updatedAt) ? row.updatedAt : Number(current.updatedAt);
    let result;
    if (teacherTransferred) {
      const statements = [env.DB.prepare(
        'UPDATE tasks SET owner=?,data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND updated_at=?'
      ).bind(
        staffId, JSON.stringify(corrected), corrected.updatedAt, corrected.updatedAt,
        app, current.id, sourceOwner, databaseUpdatedAt
      )];
      let packTransfer;
      try {
        packTransfer = await lessonSessionPackTransferStatements(env, app, {
          beforeTask: current, afterTask: corrected, oldOwner: sourceOwner, newOwner: staffId,
          taskUpdatedAt: corrected.updatedAt, updatedBy: studentChangeActorKey(auth)
        });
      } catch (error) {
        if (isSessionPackTransferConflict(error)) {
          return json({ ok: false, code: 'session_pack_transfer_conflict',
            error: String(error.message || error) }, 409, origin);
        }
        throw error;
      }
      statements.push(...packTransfer.statements);
      statements.push(lessonCheckOwnerTransferStatement(
        env, app, current.id, sourceOwner, staffId, corrected.updatedAt
      ));
      const effectiveDate = batchRosterKstDate(corrected.updatedAt);
      const eventId = await studentChangeEventId('lesson-create-teacher\n' + corrected.id + '\n' + corrected.lessonRevision);
      statements.push(studentChangeEventStatement(env, app, {
        eventId, studentId: String(corrected.studentId), taskId: corrected.id,
        eventType: 'teacher_assignment', changedFields: ['staffId'],
        details: {
          beforeStaffId: sourceOwner, beforeStaffName: String(sourceStaff && sourceStaff.name || ''),
          afterStaffId: staffId, afterStaffName: String(targetStaff.name || '')
        },
        audienceStaffIds: [sourceOwner, staffId],
        effectiveDate, requiresAck: true, changedAt: corrected.updatedAt,
        changedBy: studentChangeActorKey(auth)
      }));
      let applied;
      try {
        applied = await env.DB.batch(statements);
      } catch (error) {
        if (isSessionPackTransferConflict(error)) {
          return json({ ok: false, code: 'session_pack_transfer_conflict',
            error: '회차권 또는 수업 담당자가 먼저 변경되었습니다. 최신 내용을 확인해 주세요' }, 409, origin);
        }
        throw error;
      }
      result = applied[0];
    } else {
      result = await env.DB.prepare(
        'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND updated_at=?'
      ).bind(
        JSON.stringify(corrected), corrected.updatedAt, corrected.updatedAt,
        app, current.id, staffId, databaseUpdatedAt
      ).run();
    }
    const changes = Number(result && result.meta && result.meta.changes || 0);
    if (changes !== 1) {
      const latestRow = parseTaskRow(await env.DB.prepare(
        'SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1'
      ).bind(app, current.id).first());
      return revisionConflict(json, origin, latestRow ? latestRow.task : current);
    }
    if (auth.scope === 'all' && SAFE_ID_RE.test(String(corrected.studentId || ''))) {
      const tracked = [
        'studentName', 'grade', 'subject', 'className', 'lessonHours', 'scheduleText', 'scheduleSlots', 'start',
        'materials', 'onlineProgram', 'homework', 'studentTraits', 'goal', 'parentRequest', 'adminRequest', 'guide'
      ];
      const changedFields = tracked.filter(key => JSON.stringify(current[key] || '') !== JSON.stringify(corrected[key] || ''));
      if (changedFields.length) {
        const eventId = await studentChangeEventId('lesson-create\n' + corrected.id + '\n' + corrected.lessonRevision);
        await studentChangeEventStatement(env, app, {
          eventId, studentId: String(corrected.studentId), taskId: corrected.id,
          eventType: 'work_instruction', changedFields,
          details: {
            before: Object.fromEntries(changedFields.map(key => [key, current[key] == null ? '' : current[key]])),
            after: Object.fromEntries(changedFields.map(key => [key, corrected[key] == null ? '' : corrected[key]]))
          },
          audienceStaffIds: [staffId], requiresAck: true, changedAt: corrected.updatedAt,
          changedBy: studentChangeActorKey(auth)
        }).run();
      }
    }
    return json({
      ok: true,
      task: corrected,
      created: false,
      duplicate: false,
      updated: true,
      idempotent: false,
      previousRevision: currentRevision,
      revision: corrected.lessonRevision
    }, 200, origin);
  }

  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).bind(app, task.id, staffId, JSON.stringify(task), task.updatedAt, task.updatedAt).run();
  const changes = Number(result && result.meta && result.meta.changes || 0);
  if (changes !== 1) {
    const raced = parseTaskRow(await env.DB.prepare(
      'SELECT data,updated_at FROM tasks WHERE app=? AND id=? AND owner=? LIMIT 1'
    ).bind(app, task.id, staffId).first());
    if (raced && await contentHashForTask(raced.task) === task.lessonContentHash) {
      return json({
        ok: true, task: raced.task, created: false, duplicate: true,
        updated: false, idempotent: true, revision: revisionOf(raced.task)
      }, 200, origin);
    }
    return revisionConflict(json, origin, raced ? raced.task : task);
  }
  return json({
    ok: true, task, created: true, duplicate: false,
    updated: false, idempotent: false, revision: 1
  }, 200, origin);
}

export async function handleLessonCreateBatch(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '업무지시서에서만 등록할 수 있습니다' }, 400, origin);
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '관리자만 수업을 일괄 등록할 수 있습니다' }, 403, origin);
  }
  body = body && typeof body === 'object' ? body : {};
  const requested = Array.isArray(body.lessons) ? body.lessons : [];
  const declaredBatchKind = body.batchKind == null || body.batchKind === '' ? 'lessons' : String(body.batchKind);
  if (!['lessons', 'students'].includes(declaredBatchKind)) {
    return json({ ok: false, error: '수업 일괄 등록 방식을 확인해 주세요' }, 400, origin);
  }
  const requestedStudentIds = new Set(requested.map(item => String(item && item.lesson && item.lesson.studentId || '')).filter(Boolean));
  const batchKind = requestedStudentIds.size > 1 ? 'students' : declaredBatchKind;
  const maxBatchLessons = batchKind === 'students' ? MAX_STUDENT_BATCH_LESSONS : MAX_BATCH_LESSONS;
  if (!requested.length || requested.length > maxBatchLessons) {
    return json({ ok: false, error: '한 번에 등록할 수업은 1건 이상 ' + maxBatchLessons + '건 이하입니다' }, 400, origin);
  }

  const taskOrigin = auth.role === 'manager' ? 'manager' : 'admin';
  const serverNow = Date.now();
  const planned = [];
  const seenTaskIds = new Set();
  const seenStudentIds = new Set();
  const activeStaffIds = new Map();
  let sharedStudentId = '';
  let sharedTemplateKey = '';

  for (let index = 0; index < requested.length; index += 1) {
    const item = requested[index];
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['staffId', 'lesson'].includes(key))) {
      return json({ ok: false, error: (index + 1) + '번째 수업 형식을 확인해 주세요' }, 400, origin);
    }
    const staffId = String(item.staffId || '');
    if (!SAFE_ID_RE.test(staffId)) {
      return json({ ok: false, error: (index + 1) + '번째 수업의 담당 선생님을 확인해 주세요' }, 400, origin);
    }
    if (!activeStaffIds.has(staffId)) activeStaffIds.set(staffId, await activeStaff(env, app, staffId));
    if (!activeStaffIds.get(staffId)) {
      return json({ ok: false, error: (index + 1) + '번째 수업의 활성 담당 선생님을 선택해 주세요' }, 409, origin);
    }

    let task;
    try { task = await buildLessonTask(item.lesson, staffId, taskOrigin, serverNow + index); }
    catch (error) {
      return json({ ok: false, error: (index + 1) + '번째 수업: ' + String(error && error.message || error) }, Number(error && error.status) || 400, origin);
    }
    if (!task.studentId) {
      return json({ ok: false, error: (index + 1) + '번째 수업의 원생을 studentId로 선택해 주세요' }, 400, origin);
    }
    if (batchKind === 'students') {
      if (seenStudentIds.has(task.studentId)) {
        return json({ ok: false, error: '같은 학생이 수업 일괄 등록 안에 중복되어 있습니다' }, 409, origin);
      }
      seenStudentIds.add(task.studentId);
      const templateKey = JSON.stringify({
        staffId: task.staffId,
        subject: task.subject,
        className: task.className,
        lessonRole: task.lessonRole,
        lessonHours: task.lessonHours,
        scheduleText: task.scheduleText,
        scheduleSlots: task.scheduleSlots,
        scheduleStatus: task.scheduleStatus,
        materials: task.materials,
        onlineProgram: task.onlineProgram,
        homework: task.homework,
        studentTraits: task.studentTraits,
        goal: task.goal,
        parentRequest: task.parentRequest,
        adminRequest: task.adminRequest,
        start: task.start,
        end: task.end
      });
      if (!sharedTemplateKey) sharedTemplateKey = templateKey;
      if (templateKey !== sharedTemplateKey) {
        return json({ ok: false, error: '여러 학생 일괄 등록에는 담당자·과목·요일·시간·시수가 같은 수업만 넣을 수 있습니다' }, 400, origin);
      }
    } else {
      if (!sharedStudentId) sharedStudentId = task.studentId;
      if (task.studentId !== sharedStudentId) {
        return json({ ok: false, error: '한 번의 일괄 등록에는 같은 학생의 수업만 넣을 수 있습니다' }, 400, origin);
      }
    }
    const studentAccess = await validateLessonStudentAccess(env, app, task, auth);
    if (studentAccess) {
      return json({ ok: false, error: (index + 1) + '번째 수업: ' + studentAccess.error }, studentAccess.status, origin);
    }
    if (seenTaskIds.has(task.id)) {
      return json({ ok: false, error: '같은 담당자·과목의 수업이 일괄 등록 안에 중복되어 있습니다' }, 409, origin);
    }
    seenTaskIds.add(task.id);

    const matches = await findAssignmentRows(env, app, staffId, task);
    if (matches.length > 1) {
      return json({ ok: false, error: (index + 1) + '번째 수업과 같은 배정이 여러 건입니다. 중복을 먼저 정리해 주세요' }, 409, origin);
    }
    if (matches.length === 1) {
      const current = matches[0].task;
      if (current.deleted) {
        return json({ ok: false, error: (index + 1) + '번째 수업은 삭제된 수업과 같은 배정입니다' }, 409, origin);
      }
      if (await contentHashForTask(current) !== task.lessonContentHash) {
        return json({ ok: false, error: (index + 1) + '번째 수업은 이미 등록되어 있고 내용이 다릅니다' }, 409, origin);
      }
      planned.push({ task: current, created: false });
    } else {
      const newLessonAccess = await validateLessonStudentAccess(env, app, task, auth, {
        enforceFirstClassDate: true
      });
      if (newLessonAccess) {
        return json({ ok: false, error: (index + 1) + '번째 수업: ' + newLessonAccess.error }, newLessonAccess.status, origin);
      }
      planned.push({ task, created: true });
    }
  }

  const created = planned.filter(item => item.created);
  const rosterPlan = await planBatchRosterLinks(env, app, planned, serverNow);
  if (rosterPlan.error) return json({ ok: false, error: rosterPlan.error }, rosterPlan.status, origin);
  if (created.length || rosterPlan.changed) {
    if (!env.DB || typeof env.DB.batch !== 'function') {
      return json({ ok: false, error: '일괄 저장 기능을 사용할 수 없습니다' }, 503, origin);
    }
    const statements = [];
    if (rosterPlan.changed) {
      statements.push(rosterPlan.statement);
      statements.push(await taskWriteCasGuardStatement(env, app, 'lesson_create_batch_roster', [
        rosterPlan.expectedUpdatedAt, rosterPlan.updatedAt,
        ...planned.map(item => String(item.task.id || '')).sort()
      ].join('\n'), rosterPlan.updatedAt));
    }
    statements.push(...created.map(item => env.DB.prepare(
      'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
    ).bind(app, item.task.id, item.task.staffId, JSON.stringify(item.task), item.task.updatedAt, item.task.updatedAt)));
    try {
      const results = await env.DB.batch(statements);
      if (!Array.isArray(results) || results.length !== statements.length ||
          results.some(result => Number(result && result.meta && result.meta.changes || 0) !== 1)) {
        throw new Error('batch_insert_incomplete');
      }
    } catch (error) {
      if (isTaskWriteCasConflict(error)) {
        return json({ ok: false, error: '원생 명단이 다른 작업에서 변경되었습니다. 새로고침 후 다시 등록해 주세요' }, 409, origin);
      }
      return json({ ok: false, error: '수업 일괄 저장 중 다른 등록과 충돌했습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
    }
  }

  return json({
    ok: true,
    batchKind,
    tasks: planned.map(item => item.task),
    createdCount: created.length,
    duplicateCount: planned.length - created.length,
    rosterUpdated: !!rosterPlan.changed,
    rosterUpdatedCount: rosterPlan.updatedCount || 0,
    rosterUpdatedAt: rosterPlan.updatedAt || 0,
    idempotent: created.length === 0 && !rosterPlan.changed
  }, 200, origin);
}
