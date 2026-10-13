// 요청 본문을 푸시 서비스로 보내지 않는다. 기기에는 일반 알림만 표시한다.
const DAY = 86400000;
export async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function b64(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function safeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash &&
      ((u.hostname === 'fcm.googleapis.com' && /^\/(wp|fcm)\//.test(u.pathname)) ||
       (u.hostname === 'updates.push.services.mozilla.com' && u.pathname.startsWith('/wpush/')) ||
       (u.hostname === 'web.push.apple.com' && u.pathname.startsWith('/')) ||
       (/^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname) && u.pathname.startsWith('/')));
  } catch { return false; }
}
function managers(env) {
  return new Set([env.TASK_MANAGER_STAFF_IDS, env.TASK_MANAGER_STAFF_IDS_CONFIG]
    .flatMap(v => String(v || '').split(',')).map(v => v.trim()).filter(Boolean));
}
async function ready(env) {
  return !!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_push_jobs'").first();
}
function configured(env) { return !!(env.TASK_PUSH_PUBLIC_KEY && env.TASK_PUSH_PRIVATE_JWK); }
export async function vapid(env, endpoint, now) {
  const enc = new TextEncoder();
  const header = b64(enc.encode(JSON.stringify({typ:'JWT', alg:'ES256'})));
  const payload = b64(enc.encode(JSON.stringify({
    aud:new URL(endpoint).origin, exp:Math.floor(now / 1000) + 3600,
    sub:'https://whdudwns33-wb.github.io/wb-site/task/'
  })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.TASK_PUSH_PRIVATE_JWK),
    {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, enc.encode(header + '.' + payload));
  return 'vapid t=' + header + '.' + payload + '.' + b64(sig) + ', k=' + env.TASK_PUSH_PUBLIC_KEY;
}
export async function handleTaskPush(env, app, body, origin, auth, json) {
  if (app !== 'task' || !['person','admin'].includes(body.auth?.mode)) {
    return json({ok:false, error:'본인 기기 또는 원장 인증으로 알림을 설정해 주세요'},403,origin);
  }
  if (!await ready(env)) return json({ok:false,error:'요청 알림 서버 준비 중입니다'},503,origin);
  const staffId = auth.id || 'director', authKind = body.auth.mode;
  const authHash = await digest(authKind === 'admin' ? body.auth.secret : body.auth.token);
  if (body.action === 'key') return json({ok:true,available:configured(env),
    publicKey:configured(env) ? env.TASK_PUSH_PUBLIC_KEY : ''},200,origin);
  const endpoint = body.endpoint;
  if (!safeEndpoint(endpoint)) return json({ok:false,error:'지원하지 않는 브라우저 알림 주소입니다'},400,origin);
  const id = await digest(endpoint);
  const current = await env.DB.prepare('SELECT * FROM task_push_subscriptions WHERE endpoint_id=?').bind(id).first();
  // 같은 브라우저를 다른 직원이 쓰더라도 이전 직원 구독을 탈취하거나 그대로 승계하지 않는다.
  if (current && (current.staff_id !== staffId || current.auth_hash !== authHash || current.auth_kind !== authKind)) {
    return json({ok:false,error:'다른 연결에서 등록한 알림입니다. 브라우저 사이트 알림을 초기화한 뒤 다시 켜 주세요'},409,origin);
  }
  if (body.action === 'status') return json({ok:true,enabled:!!current?.active},200,origin);
  if (body.action === 'unsubscribe') {
    await env.DB.prepare('UPDATE task_push_subscriptions SET active=0,updated_at=? WHERE endpoint_id=?')
      .bind(Date.now(),id).run();
    return json({ok:true},200,origin);
  }
  if (body.action !== 'subscribe') return json({ok:false,error:'지원하지 않는 알림 작업입니다'},400,origin);
  if (!configured(env)) return json({ok:false,error:'요청 알림 서버 키가 아직 설정되지 않았습니다'},503,origin);
  const count = await env.DB.prepare('SELECT COUNT(*) n FROM task_push_subscriptions WHERE staff_id=? AND active=1')
    .bind(staffId).first();
  if (!current?.active && Number(count.n) >= 10) return json({ok:false,error:'알림 기기는 직원당 10대까지 연결할 수 있습니다'},409,origin);
  const now = Date.now();
  // 비활성 상태에서 먼저 과거 대기 건을 정리한다. 다시 켠 직후 도착한 새 요청은 지우지 않는다.
  if (current && !current.active) await env.DB.prepare("UPDATE task_push_jobs SET status='skipped' WHERE endpoint_id=? AND status IN ('pending','sending')")
    .bind(id).run();
  await env.DB.prepare('INSERT INTO task_push_subscriptions(endpoint_id,endpoint,staff_id,auth_kind,auth_hash,manager,active,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(endpoint_id) DO UPDATE SET active=1,manager=excluded.manager,updated_at=excluded.updated_at')
    .bind(id,endpoint,staffId,authKind,authHash,auth.scope === 'all' ? 1 : 0,now,now).run();
  return json({ok:true,enabled:true},200,origin);
}
async function authorized(env, sub, now) {
  if (!sub.active) return false;
  if (sub.auth_kind === 'admin') return !!env.TASK_ADMIN_SECRET && sub.auth_hash === await digest(env.TASK_ADMIN_SECRET);
  const staff = await env.DB.prepare("SELECT data FROM staff WHERE app='task' AND id=?").bind(sub.staff_id).first();
  if (!staff) return false;
  const data = JSON.parse(staff.data);
  if (data.deleted || data.owner || !data.name) return false;
  const tokens = await env.DB.prepare("SELECT token,created_at FROM tokens WHERE app='task' AND staff_id=? AND revoked=0")
    .bind(sub.staff_id).all();
  for (const token of tokens.results || []) {
    if (token.token.startsWith('sha256:')) {
      if (token.token === 'sha256:' + sub.auth_hash && token.created_at >= now - 90 * DAY) return true;
    } else if (await digest(token.token) === sub.auth_hash) return true;
  }
  return false;
}
async function stillRelevant(env, job, sub, now) {
  if (job.created_at < now - DAY) return false;
  if (job.kind === 'teacher') {
    if (sub.auth_kind !== 'admin' && !managers(env).has(sub.staff_id)) return false;
    return !!await env.DB.prepare("SELECT 1 FROM teacher_live_requests r WHERE r.app='task' AND r.request_id=? " +
      "AND NOT EXISTS(SELECT 1 FROM teacher_live_request_receipt_events e WHERE e.app=r.app AND e.request_id=r.request_id " +
      "AND e.admin_id=? AND e.event_type='acknowledged')").bind(job.source_id,sub.staff_id).first();
  }
  const day = new Date(now + 9 * 3600000).toISOString().slice(0,10);
  return !!await env.DB.prepare("SELECT 1 FROM admin_directives d JOIN admin_directive_revisions r ON r.app=d.app AND r.directive_id=d.directive_id " +
    "AND r.revision=d.current_revision WHERE d.app='task' AND d.directive_id=? AND r.revision=? AND d.status='active' " +
    "AND r.starts_date<=? AND (r.expires_date IS NULL OR r.expires_date>=?) " +
    "AND EXISTS(SELECT 1 FROM json_each(r.audience_staff_ids) WHERE value=?) " +
    "AND NOT EXISTS(SELECT 1 FROM admin_directive_receipt_events e WHERE e.app=d.app AND e.directive_id=d.directive_id " +
    "AND e.revision=r.revision AND e.staff_id=? AND e.event_type='acknowledged')")
    .bind(job.source_id,job.revision,day,day,sub.staff_id,sub.staff_id).first();
}
// 즉시 전송 + 기존 10분 cron 재시도. 알림 오류가 원래 요청 저장 성공을 뒤집지 않는다.
export async function dispatchTaskPush(env, now = Date.now(), fetchFn = fetch) {
  if (!configured(env) || !await ready(env)) return {accepted:0};
  await env.DB.prepare("UPDATE task_push_jobs SET status='failed' WHERE status IN ('pending','sending') AND attempts>=3 AND next_at<=?").bind(now).run();
  const jobs = await env.DB.prepare("SELECT * FROM task_push_jobs WHERE status IN ('pending','sending') AND attempts<3 AND next_at<=? ORDER BY created_at LIMIT 50")
    .bind(now).all();
  let accepted = 0;
  await Promise.all((jobs.results || []).map(async job => {
    const lease = await env.DB.prepare("UPDATE task_push_jobs SET status='sending',next_at=?,attempts=attempts+1 " +
      "WHERE endpoint_id=? AND event_key=? AND status IN ('pending','sending') AND next_at<=?")
      .bind(now+60000,job.endpoint_id,job.event_key,now).run();
    if (!lease.meta?.changes) return;
    let status='skipped', next=now;
    try {
      const sub = await env.DB.prepare('SELECT * FROM task_push_subscriptions WHERE endpoint_id=?').bind(job.endpoint_id).first();
      if (sub && safeEndpoint(sub.endpoint) && await authorized(env,sub,now) && await stillRelevant(env,job,sub,now)) {
        const response = await fetchFn(sub.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
          headers:{TTL:'86400',Urgency:'high',Authorization:await vapid(env,sub.endpoint,now)}});
        if (response.status >= 200 && response.status < 300) { status='accepted'; accepted++; }
        else if (response.status === 404 || response.status === 410) {
          await env.DB.prepare('UPDATE task_push_subscriptions SET active=0 WHERE endpoint_id=?').bind(job.endpoint_id).run();
        } else { status = job.attempts < 2 ? 'pending' : 'failed'; next=now+600000; }
      }
    } catch { status=job.attempts < 2 ? 'pending' : 'failed'; next=now+600000; }
    await env.DB.prepare('UPDATE task_push_jobs SET status=?,next_at=? WHERE endpoint_id=? AND event_key=? AND status=\'sending\' AND next_at=?')
      .bind(status,next,job.endpoint_id,job.event_key,now+60000).run();
  }));
  return {accepted};
}
