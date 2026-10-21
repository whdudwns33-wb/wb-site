import { isRequired } from './staff-work-login.js';

// 개인 확인은 기존 인증 결과만 읽는다. 기본행 생성·세션 갱신은 하지 않는다.
export async function handleSelfIdentity(env, body, auth, origin, json) {
  const unavailable = () => json({ ok: false, authScope: 'identity_check', code: 'IDENTITY_UNAVAILABLE', error: '계정 정보를 확인할 수 없습니다. 관리자에게 문의해 주세요.' }, 503, origin);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(env.WB_PRIVATE_CHAT_ORGANIZATION_ID || ''))) return unavailable();
  if (auth.inspection) return json({ ok: true, identity: { status: 'inspection', loginMethod: 'inspection' } }, 200, origin);
  if (!auth.id) return json({ ok: true, identity: { status: 'shared_admin', loginMethod: 'shared_admin' } }, 200, origin);
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind('task', auth.id).first();
  let staff;
  try { staff = row && JSON.parse(row.data); } catch { return unavailable(); }
  if (!staff || staff.deleted || (staff.id && staff.id !== auth.id) || typeof staff.name !== 'string' || !staff.name.trim()) return unavailable();
  const profile = await env.DB.prepare("SELECT login_enabled,CASE WHEN length(pin_hash)=64 AND pin_hash NOT GLOB '*[^a-f0-9]*' AND length(pin_salt) IN (32,64) AND pin_salt NOT GLOB '*[^a-f0-9]*' AND pin_iterations=100000 THEN 1 ELSE 0 END configured FROM staff_private_profiles WHERE app=? AND staff_id=? LIMIT 1")
    .bind('task', auth.id).first();
  if (!profile) return unavailable();
  return json({ ok: true, identity: {
    status: 'person', name: staff.name, id: auth.id,
    loginMethod: isRequired(env, auth, profile) ? 'personal_device_work_login' : 'personal_device',
    loginConfigured: Number(profile.configured) === 1 && Number(profile.login_enabled) === 1
  } }, 200, origin);
}
