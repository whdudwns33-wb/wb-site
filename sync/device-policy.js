// 도입 시점에 유효했던 연결만 장기 유지한다. 이미 만료/해지된 키는 되살리지 않는다.
export function deviceCutoff(env, app, now = Date.now()) {
  const fixed = Number(env.TASK_DEVICE_PERSISTENT_AFTER);
  return app === 'task' && Number.isFinite(fixed) && fixed > 0
    ? fixed : now - 90 * 86400000;
}

export async function handlePersonalDevices(env, app, body, origin, auth, json, digest) {
  if (app !== 'task' || !auth || body.auth?.mode !== 'person' ||
      !auth.id || body.auth.id !== auth.id) {
    return json({ok:false,error:'본인 기기에서 로그인해 주세요'},403,origin);
  }
  const raw = String(body.auth.token || '');
  const currentHash = 'sha256:' + await digest(raw);
  const rows = await env.DB.prepare(
    'SELECT token,created_at FROM tokens WHERE app=? AND staff_id=? AND revoked=0 ' +
    'AND (created_at>=? OR substr(token,1,7)<>?) ORDER BY created_at'
  ).bind(app,auth.id,deviceCutoff(env,app),'sha256:').all();
  const devices = await Promise.all((rows.results || []).map(async r => ({
    id:await digest('device-list:' + r.token), connectedAt:r.created_at,
    current:r.token === currentHash || r.token === raw, stored:r.token
  })));
  if (body.action === 'revoke') {
    const selected = devices.find(d => d.id === body.deviceId);
    if (!selected || selected.current) return json({ok:false,error:'해제할 다른 기기를 다시 선택해 주세요'},409,origin);
    await env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=? AND token=? AND revoked=0')
      .bind(app,auth.id,selected.stored).run();
    return json({ok:true},200,origin);
  }
  if (body.action !== 'list') return json({ok:false,error:'지원하지 않는 요청'},400,origin);
  return json({ok:true,limit:3,devices:devices.map(({stored,...d}) => d)},200,origin);
}
