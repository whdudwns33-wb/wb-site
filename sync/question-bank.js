// 계정 원문은 public 저장소나 일반 동기화 데이터가 아닌 Worker secret에만 둔다.
export function questionBankResult(env, body, auth) {
  if (!auth || !['all', 'own'].includes(auth.scope)) return { status: 401, data: { ok: false, error: '로그인이 필요합니다' } };
  if (body.app !== 'task' || !['list', 'reveal'].includes(body.action)) return { status: 400, data: { ok: false, error: '요청을 확인해 주세요' } };
  let items;
  try {
    items = JSON.parse(env.QUESTION_BANK_ACCOUNTS || '');
    if (!Array.isArray(items) || items.some(item => !item || !/^[a-z0-9_-]+$/.test(item.key) ||
        typeof item.name !== 'string' || typeof item.account !== 'string' || typeof item.password !== 'string')) throw new Error();
  } catch {
    return { status: 503, data: { ok: false, error: '문제은행 계정 설정을 확인해 주세요' } };
  }
  if (body.action === 'list') return { status: 200, data: { ok: true,
    items: items.map(({ key, name, account, agency }) => ({ key, name, account, agency: agency || '' })) } };
  const item = items.find(item => item.key === body.key);
  return item ? { status: 200, data: { ok: true, password: item.password } }
    : { status: 404, data: { ok: false, error: '해당 계정을 찾을 수 없습니다' } };
}
