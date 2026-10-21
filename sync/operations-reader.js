// 읽기 권한은 관리 scope와 분리한다. 요청 본문이나 수정 가능한 직원 이름으로 승격하지 않는다.
export function isOperationsReader(env, app, auth) {
  return app === 'task' && auth?.scope === 'own' && !!auth.id &&
    String(env.TASK_OPERATIONS_READER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(auth.id);
}

export async function handleOperationsRead(env, app, body, origin, auth, json) {
  if (!isOperationsReader(env, app, auth) || body.action !== 'snapshot') {
    return json({ok:false,error:'운영 조회 권한이 필요합니다'},403,origin);
  }
  const staffRows = await env.DB.prepare('SELECT data FROM staff WHERE app=?').bind(app).all();
  const taskRows = await env.DB.prepare(
    "SELECT id,data FROM tasks WHERE app=? AND json_valid(data) " +
    "AND COALESCE(json_extract(data,'$.deleted'),0)=0"
  ).bind(app).all();
  const tasks = (taskRows.results || []).map(r => JSON.parse(r.data)).filter(t =>
    /^\[(수업|컨설팅)\]/.test(t.title || ''));
  const ids = new Set(tasks.map(t => t.id));
  const from = String(body.from || ''), to = String(body.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) ||
      to < from || Date.parse(to)-Date.parse(from)>7*86400000) {
    return json({ok:false,error:'조회 날짜 범위를 확인해 주세요'},400,origin);
  }
  const checkRows = await env.DB.prepare(
    "SELECT k,data FROM checks WHERE app=? AND substr(k,1,2)<>'__' AND substr(k,-10)>=? AND substr(k,-10)<=?"
  ).bind(app,from,to).all();
  const checks = {};
  for (const row of checkRows.results || []) {
    if (!ids.has(String(row.k).split('|')[0])) continue;
    const data = JSON.parse(row.data);
    // 현황판 출결만 필요하다. 다른 선생님의 내부 메모와 직원 근무 기록은 보내지 않는다.
    checks[row.k] = {att:data.att || '', date:data.date, done:!!data.done};
  }
  const staff = (staffRows.results || []).map(r => JSON.parse(r.data))
    .filter(s => !s.deleted).map(s => ({id:s.id,name:s.name,active:s.active}));
  return json({ok:true,staff,tasks,checks,from,to},200,origin);
}
