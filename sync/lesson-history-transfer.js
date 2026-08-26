const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * 담당 수업의 과거 출결·5단계·내부 메모를 같은 taskId로 보존하면서 새 담당자에게 넘긴다.
 * data와 updated_at은 기록 원문/작성 시각이므로 유지하고, owner와 srv_at만 이전한다.
 */
export function lessonCheckOwnerTransferStatement(env, app, taskId, sourceStaffId, targetStaffId, serverNow) {
  const values = [taskId, sourceStaffId, targetStaffId].map(value => String(value || ''));
  if (app !== 'task' || values.some(value => !SAFE_ID.test(value)) || sourceStaffId === targetStaffId) {
    throw new Error('수업 기록 이전 대상을 확인해 주세요');
  }
  return env.DB.prepare(
    "UPDATE checks SET owner=?,srv_at=? WHERE app=? AND owner=? AND json_valid(data) " +
    "AND json_extract(data,'$.taskId')=?"
  ).bind(targetStaffId, Number(serverNow), app, sourceStaffId, taskId);
}
