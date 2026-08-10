/**
 * 보호자 연락처·발송 동의 원장 — 학부모 피드백 실제 발송(parent-feedback-send.js)이
 * 전화번호를 찾아오는 유일한 곳이다.
 *
 * 개인정보(전화번호)를 다루므로 원장(scope='all')만 조회·수정할 수 있다. 원생 명단과
 * 함께 D1에만 저장되고 앱 화면 밖으로는 절대 나가지 않는다 —
 * 이 파일과 parent-feedback-send.js 말고는 이 테이블을 읽는 코드가 없어야 한다.
 *
 *   POST /guardian-contact { app, auth(admin), action:'list' }
 *   POST /guardian-contact { app, auth(admin), action:'set', studentName, phone, consent }
 */

const MAX_NAME = 40;

function normalizedDigits(value) {
  return String(value == null ? '' : value).replace(/[\s()-]/g, '');
}

function normalizeName(value) {
  return String(value == null ? '' : value).trim();
}

function view(row) {
  if (!row) return null;
  return {
    studentName: row.student_name,
    phone: row.phone || '',
    consent: !!Number(row.consent),
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by || ''
  };
}

export async function handleGuardianContact(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '보호자 연락처는 원장만 관리할 수 있습니다' }, 403, origin);

  const action = String(body.action || 'list');
  if (action === 'list') {
    const result = await env.DB.prepare(
      'SELECT * FROM guardian_contacts WHERE app=? ORDER BY student_name'
    ).bind(app).all();
    return json({ ok: true, contacts: (result.results || []).map(view) }, 200, origin);
  }

  if (action !== 'set') return json({ ok: false, error: 'action은 list 또는 set이어야 합니다' }, 400, origin);

  const studentName = normalizeName(body.studentName);
  if (!studentName) return json({ ok: false, error: '학생 이름이 필요합니다' }, 400, origin);
  if (studentName.length > MAX_NAME) return json({ ok: false, error: '학생 이름이 너무 깁니다' }, 413, origin);

  const rawPhone = normalizedDigits(body.phone);
  let phone = null;
  if (rawPhone) {
    if (!/^01[016789]\d{7,8}$/.test(rawPhone)) {
      return json({ ok: false, error: '올바른 휴대폰 번호 형식이 아닙니다 (예: 01012345678)' }, 400, origin);
    }
    phone = rawPhone;
  }
  const consent = body.consent ? 1 : 0;
  if (consent && !phone) {
    return json({ ok: false, error: '연락처 없이는 발송 동의를 켤 수 없습니다' }, 400, origin);
  }

  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO guardian_contacts (app, student_name, phone, consent, updated_at, updated_by) VALUES (?,?,?,?,?,?) ' +
    'ON CONFLICT (app, student_name) DO UPDATE SET phone=excluded.phone, consent=excluded.consent, ' +
    'updated_at=excluded.updated_at, updated_by=excluded.updated_by'
  ).bind(app, studentName, phone, consent, now, 'director').run();

  const row = await env.DB.prepare('SELECT * FROM guardian_contacts WHERE app=? AND student_name=? LIMIT 1')
    .bind(app, studentName).first();
  return json({ ok: true, contact: view(row) }, 200, origin);
}
