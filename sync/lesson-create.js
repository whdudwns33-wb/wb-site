const LESSON_TEXT_LIMITS = {
  studentName: 80,
  grade: 24,
  subject: 60,
  className: 100,
  scheduleText: 600,
  materials: 2400,
  onlineProgram: 600,
  homework: 2400,
  studentTraits: 2400,
  goal: 1600,
  parentRequest: 1600,
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
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
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

function normalizeSlots(rawSlots, validFrom, lessonRole) {
  if (!Array.isArray(rawSlots)) return [];
  if (rawSlots.length > MAX_SCHEDULE_SLOTS) throw new Error('확정 시간은 최대 20개까지 입력할 수 있습니다');

  const normalized = rawSlots.map((raw, index) => {
    const days = [...new Set((Array.isArray(raw && raw.days) ? raw.days : [])
      .map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
    const startMinute = clockMinute(raw && raw.startTime);
    const endMinute = clockMinute(raw && raw.endTime);
    if (!days.length || startMinute === null || endMinute === null || endMinute <= startMinute) {
      throw new Error((index + 1) + '번째 확정 시간의 요일·시작·종료를 확인해 주세요');
    }
    return {
      days,
      startTime: clockText(startMinute),
      endTime: clockText(endMinute),
      validFrom,
      lessonRole,
      status: 'normal'
    };
  });

  const seen = new Set();
  const canonical = normalized.filter(slot => {
    const key = [slot.days.join(','), slot.startTime, slot.endTime].join('|');
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
  return slots.map(slot =>
    slot.days.map(day => DAY_LABELS[day]).join('·') + ' ' + slot.startTime + '-' + slot.endTime
  ).join(' / ');
}

function parseDayPrefix(value) {
  let source = String(value || '').normalize('NFKC').replace(/\s+/g, '');
  const days = [];
  if (source.includes('매일')) {
    days.push(0, 1, 2, 3, 4, 5, 6);
    source = source.replace(/매일/g, '');
  }
  if (source.includes('평일')) {
    days.push(1, 2, 3, 4, 5);
    source = source.replace(/평일/g, '');
  }
  source = source.replace(/방학(?:중|동안)/g, '').replace(/매주/g, '').replace(/수업/g, '').replace(/요일/g, '');
  const dayIndex = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };
  source = source.replace(/[일월화수목금토]/g, day => { days.push(dayIndex[day]); return ''; });
  source = source.replace(/[\s,·&+()]/g, '').replace(/(?:및|와|과)/g, '');
  return source === '' && days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
}

function scheduleTextCoverage(value) {
  const segments = String(value || '').split(new RegExp('(?:/|;|\\n)+')).map(item => item.trim()).filter(Boolean);
  if (!segments.length) return null;
  const coverage = [];
  for (const segment of segments) {
    const rangeRe = /((?:[01]?\d|2[0-3]):[0-5]\d)\s*(?:-|–|—|−|~|～)\s*((?:[01]?\d|2[0-3]):[0-5]\d)/g;
    const ranges = [...segment.matchAll(rangeRe)];
    if (ranges.length !== 1) return null;
    const match = ranges[0];
    const days = parseDayPrefix(segment.slice(0, match.index));
    const suffix = segment.slice(Number(match.index) + match[0].length)
      .replace(/[\s,·.()]/g, '').replace(/수업$/g, '');
    const startMinute = clockMinute(match[1]);
    const endMinute = clockMinute(match[2]);
    if (!days || suffix || startMinute === null || endMinute === null || endMinute <= startMinute) return null;
    const start = clockText(startMinute);
    const end = clockText(endMinute);
    days.forEach(day => coverage.push([day, start, end].join('|')));
  }
  return coverage.sort();
}

function slotCoverage(slots) {
  return slots.flatMap(slot => slot.days.map(day => [day, slot.startTime, slot.endTime].join('|'))).sort();
}

function sameCoverage(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
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

function contentIdentityText(input, slots, scheduleStatus, scheduleReviewReason) {
  const content = {
    studentName: input.studentName,
    grade: input.grade,
    subject: input.subject,
    className: input.className,
    lessonRole: input.lessonRole,
    scheduleText: input.scheduleText,
    slots: slots.map(slot => [slot.days, slot.startTime, slot.endTime]),
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
  return JSON.stringify(content);
}

function lessonGuide(input) {
  return [
    '■ 교재와 현재 진도\n' + input.materials,
    '■ 온라인 프로그램\n' + input.onlineProgram,
    '■ 숙제 루틴과 수행률\n' + input.homework,
    '■ 학생 특징\n' + input.studentTraits,
    '■ 지금 목표\n' + input.goal,
    '■ 특이사항·학부모 요청\n' + input.parentRequest
  ].join('\n\n');
}

export async function buildLessonTask(raw, staffId, origin, serverNow) {
  raw = raw && typeof raw === 'object' ? raw : {};
  for (const forbidden of [
    'id', 'taskId', 'groupId', 'staffId', 'origin', 'createdAt', 'updatedAt', 'deleted', 'steps',
    'lessonRevision', 'lessonAssignmentKey', 'lessonContentHash', 'lessonDedupeKey',
    'lessonFormVersion', 'intakeVersion', 'intakeSource'
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
  if (!input.subject && !input.className) throw new Error('과목 또는 반을 입력해 주세요');
  input.start = dateValue(raw.start);
  input.lessonRole = textValue(raw.lessonRole || input.className || input.subject, 120, true);

  const requestedStatus = String(raw.scheduleStatus || '');
  let slots = normalizeSlots(raw.scheduleSlots, input.start, input.lessonRole);
  if (requestedStatus === 'needs_review' && slots.length) {
    throw new Error('확인 필요 시간표에는 일부 확정 시간을 함께 저장할 수 없습니다');
  }
  if (!input.scheduleText) {
    if (!slots.length) throw new Error('수업 요일과 시간을 입력해 주세요');
    input.scheduleText = scheduleTextFromSlots(slots);
  } else if (slots.length) {
    const textCoverage = scheduleTextCoverage(input.scheduleText);
    if (!sameCoverage(textCoverage, slotCoverage(slots))) {
      slots = [];
      input.scheduleReviewReason = [
        input.scheduleReviewReason,
        '원문 시간과 확정 시간대가 달라 원장 확인이 필요합니다'
      ].filter(Boolean).join(' / ');
    }
  }
  const scheduleStatus = slots.length ? 'confirmed' : 'needs_review';
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
  if (!row) return false;
  try { return !JSON.parse(row.data).deleted; } catch (error) { return false; }
}

function normalizedRosterText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
}

async function validateLessonStudentAccess(env, app, task, auth) {
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
  const student = students.find(item => item && item.id === studentId && Array.isArray(item.teacherIds));
  if (!student) return { status: 409, error: '원생 명단에서 학생 식별자를 찾을 수 없습니다' };
  if (auth.scope === 'own' && !student.teacherIds.includes(auth.id)) {
    return { status: 403, error: '담당 학생의 수업만 등록할 수 있습니다' };
  }
  if (normalizedRosterText(student.name) !== normalizedRosterText(task.studentName) ||
      normalizedRosterText(student.grade) !== normalizedRosterText(task.grade)) {
    return { status: 409, error: '원생 명단의 이름·학년과 수업 정보가 일치하지 않습니다' };
  }
  return null;
}

function parseTaskRow(row) {
  if (!row) return null;
  try { return { task: JSON.parse(row.data), updatedAt: Number(row.updated_at) }; } catch (error) { return null; }
}

function isLessonIntake(task) {
  return task && (task.lessonFormVersion || task.intakeVersion || task.intakeSource === 'teacher_9_field_form');
}

function isLegacyLessonTask(task) {
  return !!task && !task.deleted && /^\[수업\]/.test(String(task.title || ''));
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
    const slots = normalizeSlots(task.scheduleSlots || [], task.start, role);
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
  return {
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
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(staffId) || !await activeStaff(env, app, staffId)) {
    return json({ ok: false, error: '활성 담당 선생님을 선택해 주세요' }, 409, origin);
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

  const sourceTaskId = body.sourceTaskId == null ? '' : String(body.sourceTaskId);
  if (sourceTaskId && !/^[A-Za-z0-9_-]{1,160}$/.test(sourceTaskId)) {
    return json({ ok: false, error: '수정할 수업 ID를 확인해 주세요' }, 400, origin);
  }

  let matches;
  if (sourceTaskId) {
    const sourceRow = parseTaskRow(await env.DB.prepare(
      'SELECT data,updated_at FROM tasks WHERE app=? AND id=? AND owner=? LIMIT 1'
    ).bind(app, sourceTaskId, staffId).first());
    if (!sourceRow) return json({ ok: false, error: '수정할 수업을 찾을 수 없습니다' }, 404, origin);
    if ((!isLessonIntake(sourceRow.task) && !(auth.scope === 'all' && isLegacyLessonTask(sourceRow.task))) ||
        (auth.scope !== 'all' && sourceRow.task.staffId && sourceRow.task.staffId !== staffId)) {
      return json({ ok: false, error: '이 수업은 수업 등록 및 변경 화면에서 정정할 수 없습니다' }, 409, origin);
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

  if (matches.length === 1) {
    const row = matches[0];
    const current = row.task;
    if (current.deleted) {
      return json({ ok: false, error: '삭제된 수업과 같은 배정입니다. 원장에게 복구를 요청해 주세요' }, 409, origin);
    }
    if (await contentHashForTask(current) === task.lessonContentHash) {
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
    const result = await env.DB.prepare(
      'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND updated_at=?'
    ).bind(
      JSON.stringify(corrected), corrected.updatedAt, corrected.updatedAt,
      app, current.id, staffId, databaseUpdatedAt
    ).run();
    const changes = Number(result && result.meta && result.meta.changes || 0);
    if (changes !== 1) {
      const latestRow = parseTaskRow(await env.DB.prepare(
        'SELECT data,updated_at FROM tasks WHERE app=? AND id=? AND owner=? LIMIT 1'
      ).bind(app, current.id, staffId).first());
      return revisionConflict(json, origin, latestRow ? latestRow.task : current);
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
