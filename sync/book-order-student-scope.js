const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseJson(value) {
  try { return JSON.parse(value); } catch (error) { return null; }
}

function kstDate(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isLessonTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
  const lessonFormVersion = Number(task.lessonFormVersion);
  const intakeVersion = Number(task.intakeVersion);
  return task.taskKind === 'lesson_instruction' ||
    (Number.isInteger(lessonFormVersion) && lessonFormVersion >= 1) ||
    (Number.isInteger(intakeVersion) && intakeVersion >= 1);
}

function isCurrentLessonRow(row, staffId, referenceDate) {
  const task = row && parseJson(row.data);
  if (!task || task.deleted || !isLessonTask(task)) return false;
  if (!SAFE_ID.test(String(row.id || '')) || String(task.id || '') !== String(row.id)) return false;
  if (String(row.owner || '') !== staffId || String(task.staffId || '') !== staffId) return false;
  if (!SAFE_ID.test(String(task.studentId || ''))) return false;
  const start = String(task.start || '');
  const end = String(task.end || '');
  // 새 수업 시작 전에 교재를 주문할 수 있어야 하므로 미래 start도 등록 수업으로 포함한다.
  // 다만 형식이 손상됐거나 이미 종료된 수업은 후보 정본에서 fail closed 한다.
  if ((start && !ISO_DATE.test(start)) || (end && (!ISO_DATE.test(end) || end < referenceDate))) return false;
  return true;
}

function rosterTransition(student) {
  return /^(?:휴원|퇴원)\s+\d{4}-\d{2}-\d{2}(?:\s|$)/.test(String(student && student.reason || ''));
}

export function activeRosterStudent(student, referenceMonth) {
  if (!student || !SAFE_ID.test(String(student.id || '')) || rosterTransition(student)) return false;
  const start = String(student.start || '');
  const end = String(student.end || '');
  return (!start || start <= referenceMonth) && (!end || end > referenceMonth);
}

export async function lessonStudentIdsForStaff(env, app, staffId, now = Date.now()) {
  const normalizedStaffId = String(staffId || '');
  if (!SAFE_ID.test(normalizedStaffId)) return new Set();
  const rows = await env.DB.prepare(
    'SELECT id,owner,data FROM tasks WHERE app=? AND owner=? AND json_valid(data)'
  ).bind(app, normalizedStaffId).all();
  const referenceDate = kstDate(now);
  return new Set((rows.results || [])
    .filter(row => isCurrentLessonRow(row, normalizedStaffId, referenceDate))
    .map(row => String(parseJson(row.data).studentId)));
}

export async function bookOrderStudentIdsForAuth(env, app, document, auth, now = Date.now()) {
  const month = kstDate(now).slice(0, 7);
  const activeIds = new Set((document && document.roster && document.roster.students || [])
    .filter(student => activeRosterStudent(student, month))
    .map(student => String(student.id)));
  if (auth && auth.scope === 'all') return activeIds;
  if (!auth || auth.scope !== 'own') return new Set();
  const lessonIds = await lessonStudentIdsForStaff(env, app, auth.id, now);
  return new Set([...lessonIds].filter(studentId => activeIds.has(studentId)));
}

/**
 * own-scope 교재 write가 수업 담당 변경과 경쟁해도 이전 담당자가 저장하지 못하도록
 * 실제 INSERT/UPDATE 문에 붙이는 D1 guard다. 관리 범위는 빈 guard를 반환한다.
 */
export function ownBookStudentWriteGuard(auth, app, studentIds, now = Date.now()) {
  if (!auth || auth.scope !== 'own') return { sql: '', binds: [] };
  const referenceDate = kstDate(now);
  const referenceMonth = referenceDate.slice(0, 7);
  return {
    sql:
      ' AND NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE NOT (' +
        'EXISTS (SELECT 1 FROM private_rosters roster, json_each(roster.data,\'$.roster.students\') roster_student ' +
          'WHERE roster.app=? AND json_valid(roster.data) ' +
          "AND CAST(json_extract(roster_student.value,'$.id') AS TEXT)=CAST(selected.value AS TEXT) " +
          "AND COALESCE(json_extract(roster_student.value,'$.start'),'')<=? " +
          "AND (COALESCE(json_extract(roster_student.value,'$.end'),'')='' " +
            "OR json_extract(roster_student.value,'$.end')>?) " +
          "AND COALESCE(json_extract(roster_student.value,'$.reason'),'') NOT GLOB '휴원 [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' " +
          "AND COALESCE(json_extract(roster_student.value,'$.reason'),'') NOT GLOB '퇴원 [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*') " +
        'AND EXISTS (SELECT 1 FROM tasks lesson WHERE lesson.app=? AND lesson.owner=? AND json_valid(lesson.data) ' +
          "AND lesson.id=CAST(json_extract(lesson.data,'$.id') AS TEXT) " +
          "AND CAST(json_extract(lesson.data,'$.staffId') AS TEXT)=? " +
          "AND CAST(json_extract(lesson.data,'$.studentId') AS TEXT)=CAST(selected.value AS TEXT) " +
          "AND COALESCE(json_extract(lesson.data,'$.deleted'),0)=0 " +
          "AND json_type(lesson.data)='object' " +
          "AND (json_extract(lesson.data,'$.taskKind')='lesson_instruction' " +
            "OR CAST(COALESCE(json_extract(lesson.data,'$.lessonFormVersion'),0) AS INTEGER)>=1 " +
            "OR CAST(COALESCE(json_extract(lesson.data,'$.intakeVersion'),0) AS INTEGER)>=1) " +
          "AND (COALESCE(json_extract(lesson.data,'$.start'),'')='' OR " +
            "(typeof(json_extract(lesson.data,'$.start'))='text' AND json_extract(lesson.data,'$.start') " +
              "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')) " +
          "AND (COALESCE(json_extract(lesson.data,'$.end'),'')='' OR " +
            "(typeof(json_extract(lesson.data,'$.end'))='text' AND json_extract(lesson.data,'$.end') " +
              "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND json_extract(lesson.data,'$.end')>=?))" +
      ')))',
    binds: [JSON.stringify(studentIds), app, referenceMonth, referenceMonth,
      app, String(auth.id || ''), String(auth.id || ''), referenceDate]
  };
}
