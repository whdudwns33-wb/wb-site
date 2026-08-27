const SAFE_OPERATION = /^[a-z0-9_-]{1,80}$/;

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * D1 batch 안에서 바로 앞 UPDATE가 정확히 한 행을 바꿨는지 SQL 레벨에서 확인한다.
 * batch 결과를 받은 뒤 0건을 알아차리는 것만으로는 이미 실행된 후속 문장을 되돌릴 수
 * 없으므로, guard INSERT의 trigger가 즉시 오류를 내 batch 전체를 롤백한다.
 */
export async function taskWriteCasGuardStatement(env, app, operation, source, createdAt = Date.now()) {
  const normalizedOperation = String(operation || '');
  if (app !== 'task' || !SAFE_OPERATION.test(normalizedOperation)) {
    const error = new Error('TASK_WRITE_CAS_GUARD_INVALID');
    error.code = 'TASK_WRITE_CAS_GUARD_INVALID';
    throw error;
  }
  const guardId = 'twcg_' + (await sha256Hex([
    app, normalizedOperation, String(source || '')
  ].join('\n'))).slice(0, 52);
  return env.DB.prepare(
    'INSERT INTO task_write_cas_guards(app,guard_id,operation,previous_changes,created_at) ' +
    'SELECT ?,?,?,changes(),?'
  ).bind(app, guardId, normalizedOperation, Number(createdAt));
}

export function isTaskWriteCasConflict(error) {
  return /TASK_WRITE_CAS_CONFLICT|task_write_cas_guards/.test(String(error && error.message || error || ''));
}
