import { guardianDeliveryAllowed, guardianDeliveryStudentIds } from './guardian-delivery-policy.js';

/**
 * 보호자 연락처·발송 동의 원장 — 학부모 피드백 실제 발송(parent-feedback-send.js)이
 * stable studentId로 전화번호를 찾아오는 유일한 곳이다.
 *
 * 개인정보(전화번호)를 다루므로 원장(scope='all')만 조회·수정할 수 있다. 원생 명단과
 * 함께 D1에만 저장되고 앱 화면 밖으로는 절대 나가지 않는다 —
 * 이 파일과 parent-feedback-send.js 말고는 이 테이블을 읽는 코드가 없어야 한다.
 *
 *   POST /guardian-contact { app, auth(admin), action:'list' }
 *   POST /guardian-contact { app, auth(admin), action:'set', studentId, phone, consent }
 */

const MAX_NAME = 40;

function normalizedDigits(value) {
  return String(value == null ? '' : value).replace(/[\s()-]/g, '');
}

function normalizeName(value) {
  return String(value == null ? '' : value).trim();
}

function normalizedRosterText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
}

function auditActor(auth) {
  return auth.role === 'manager' ? String(auth.id) : 'director';
}

function view(row) {
  if (!row) return null;
  return {
    studentId: row.student_id,
    studentName: row.student_name,
    phone: row.phone || '',
    consent: !!Number(row.consent),
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by || ''
  };
}

function viewAcaflowLink(row) {
  return {
    externalStudentNo: row.external_student_no,
    studentId: row.student_id,
    linkedAt: Number(row.linked_at)
  };
}

async function rosterStudents(env, app) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return [];
  try {
    const document = JSON.parse(row.data || '{}');
    const students = document && document.roster && document.roster.students;
    return Array.isArray(students) ? students : [];
  } catch (error) {
    return [];
  }
}

export async function handleGuardianContact(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '보호자 연락처는 원장만 관리할 수 있습니다' }, 403, origin);

  const action = String(body.action || 'list');
  if (action === 'list') {
    const results = await Promise.all([
      env.DB.prepare('SELECT * FROM guardian_contacts_by_student WHERE app=? ORDER BY student_name, student_id').bind(app).all(),
      env.DB.prepare('SELECT * FROM acaflow_student_links WHERE app=? ORDER BY external_student_no').bind(app).all()
    ]);
    return json({
      ok: true,
      contacts: (results[0].results || []).map(view),
      acaflowLinks: (results[1].results || []).map(viewAcaflowLink),
      deliveryEnabledStudentIds: guardianDeliveryStudentIds(env)
    }, 200, origin);
  }

  if (action !== 'set') return json({ ok: false, error: 'action은 list 또는 set이어야 합니다' }, 400, origin);

  const students = await rosterStudents(env, app);
  let studentId = normalizeName(body.studentId);
  let student;
  if (studentId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(studentId)) {
      return json({ ok: false, error: '원생 명단에서 학생을 다시 선택해 주세요' }, 400, origin);
    }
    student = students.find(item => item && item.id === studentId) || null;
  } else {
    // 배포 전환 동안 예전 화면(studentName만 전송)도 안전하게 받는다. 현재 roster에서
    // 이름이 정확히 한 명일 때만 ID를 서버가 확정하며, 동명이면 추정하지 않고 막는다.
    const requestedName = normalizeName(body.studentName);
    const matches = students.filter(item => item &&
      normalizedRosterText(item.name) === normalizedRosterText(requestedName));
    if (matches.length !== 1) {
      return json({
        ok: false,
        error: matches.length > 1
          ? '동명이인 학생은 학생 ID를 포함해 다시 선택해 주세요'
          : '원생 명단에서 학생을 다시 선택해 주세요'
      }, 409, origin);
    }
    student = matches[0];
    studentId = normalizeName(student.id);
  }
  if (!student) return json({ ok: false, error: '현재 원생 명단에서 학생을 찾을 수 없습니다' }, 409, origin);
  const studentName = normalizeName(student.name);
  if (!studentName || studentName.length > MAX_NAME) {
    return json({ ok: false, error: '원생 명단의 학생 이름을 확인해 주세요' }, 409, origin);
  }
  if (body.studentName != null && normalizedRosterText(body.studentName) !== normalizedRosterText(studentName)) {
    return json({ ok: false, error: '선택한 학생 ID와 이름이 원생 명단에서 일치하지 않습니다' }, 409, origin);
  }

  const rawPhone = normalizedDigits(body.phone);
  let phone = null;
  if (rawPhone) {
    if (!/^01[016789]\d{7,8}$/.test(rawPhone)) {
      return json({ ok: false, error: '올바른 휴대폰 번호 형식이 아닙니다 (예: 01012345678)' }, 400, origin);
    }
    phone = rawPhone;
  }
  const consent = body.consent ? 1 : 0;
  if (consent && !guardianDeliveryAllowed(env, studentId)) {
    return json({ ok: false, code: 'GUARDIAN_DELIVERY_NOT_ALLOWED',
      error: '이 학생은 학부모 전달 테스트 대상이 아닙니다' }, 403, origin);
  }
  if (consent && !phone) {
    return json({ ok: false, error: '연락처 없이는 발송 동의를 켤 수 없습니다' }, 400, origin);
  }

  const externalStudentNo = normalizeName(body.externalStudentNo);
  if (externalStudentNo && !/^[A-Za-z0-9._-]{1,128}$/.test(externalStudentNo)) {
    return json({ ok: false, error: '아카플로우 학생번호 형식을 확인해 주세요' }, 400, origin);
  }
  let existingLink = null;
  if (externalStudentNo) {
    const links = await env.DB.prepare(
      'SELECT * FROM acaflow_student_links WHERE app=? AND (external_student_no=? OR student_id=?)'
    ).bind(app, externalStudentNo, studentId).all();
    const rows = links.results || [];
    existingLink = rows.find(row => row.external_student_no === externalStudentNo && row.student_id === studentId) || null;
    if (rows.some(row => row.external_student_no !== externalStudentNo || row.student_id !== studentId)) {
      return json({ ok: false, error: '아카플로우 학생번호가 다른 WB 원생과 이미 연결되어 있습니다' }, 409, origin);
    }
  }

  const now = Date.now();
  const contactStatement = env.DB.prepare(
    'INSERT INTO guardian_contacts_by_student ' +
    '(app, student_id, student_name, phone, consent, updated_at, updated_by) VALUES (?,?,?,?,?,?,?) ' +
    'ON CONFLICT (app, student_id) DO UPDATE SET student_name=excluded.student_name, ' +
    'phone=excluded.phone, consent=excluded.consent, updated_at=excluded.updated_at, updated_by=excluded.updated_by'
  ).bind(app, studentId, studentName, phone, consent, now, auditActor(auth));
  try {
    if (externalStudentNo && !existingLink) {
      await env.DB.batch([
        contactStatement,
        env.DB.prepare(
          'INSERT INTO acaflow_student_links (app, external_student_no, student_id, linked_at, linked_by) VALUES (?,?,?,?,?)'
        ).bind(app, externalStudentNo, studentId, now, auditActor(auth))
      ]);
    } else {
      await contactStatement.run();
    }
  } catch (error) {
    if (externalStudentNo) {
      return json({ ok: false, error: '아카플로우 학생번호 연결이 다른 관리자 작업과 충돌했습니다' }, 409, origin);
    }
    throw error;
  }

  const row = await env.DB.prepare(
    'SELECT * FROM guardian_contacts_by_student WHERE app=? AND student_id=? LIMIT 1'
  ).bind(app, studentId).first();
  return json({ ok: true, contact: view(row), acaflowLink: externalStudentNo ? {
    externalStudentNo: externalStudentNo, studentId: studentId, linkedAt: existingLink ? Number(existingLink.linked_at) : now
  } : null }, 200, origin);
}
