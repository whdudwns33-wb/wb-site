function transferError(message) {
  const error = new Error(message || '수업 담당자 변경 중 회차권이 먼저 변경되었습니다');
  error.code = 'SESSION_PACK_TRANSFER_CONFLICT';
  error.status = 409;
  return error;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function assignmentKey(task) {
  return String(task.lessonAssignmentKey || task.lessonDedupeKey || task.id);
}

async function taskHash(task, owner) {
  return await sha256(['lesson-task', task.id, owner, task.studentId, assignmentKey(task)].join('\n'));
}

export function isSessionPackTransferConflict(error) {
  return !!error && (error.code === 'SESSION_PACK_TRANSFER_CONFLICT' ||
    /SESSION_PACK_TRANSFER_(?:TASK|PACK|IDENTITY)_CONFLICT/.test(String(error.message || error)));
}

/**
 * 수업 task 담당자 CAS 바로 뒤에 붙일 회차권 이전 문장을 만든다.
 *
 * 활성 회차권이 있으면 pack_id와 usage 원장은 그대로 두고 담당자·배정키·task hash만
 * 새 task 정체성으로 바꾼다. 마지막 guard INSERT는 직전 UPDATE의 changes()와 현재
 * task/pack 정체성을 검사하고 민감정보 없는 감사행으로 남으므로, task 또는 pack CAS가
 * 0건이면 D1 batch 전체가 실패한다.
 * 활성 회차권이 없을 때도 guard가 task CAS와 "여전히 없음"을 함께 확인한다.
 */
export async function lessonSessionPackTransferStatements(env, app, options) {
  const before = options && options.beforeTask;
  const after = options && options.afterTask;
  const oldOwner = String(options && options.oldOwner || '');
  const newOwner = String(options && options.newOwner || '');
  const taskUpdatedAt = Number(options && options.taskUpdatedAt);
  const updatedBy = String(options && options.updatedBy || '');
  if (!before || !after || String(before.id || '') !== String(after.id || '') ||
      String(before.studentId || '') !== String(after.studentId || '') || oldOwner === newOwner ||
      String(before.staffId || '') !== oldOwner || String(after.staffId || '') !== newOwner ||
      !Number.isFinite(taskUpdatedAt) || taskUpdatedAt <= 0 || !updatedBy) {
    throw transferError('수업 담당자 변경의 task 정체성을 확인해 주세요');
  }

  const pack = await env.DB.prepare(
    "SELECT * FROM session_packs WHERE app=? AND lesson_task_id=? AND status='active' LIMIT 1"
  ).bind(app, String(before.id)).first();
  const nextAssignmentKey = assignmentKey(after);
  const nextTaskHash = await taskHash(after, newOwner);
  const guardId = 'sptg_' + (await sha256([
    app, before.id, oldOwner, newOwner, taskUpdatedAt, nextAssignmentKey, nextTaskHash
  ].join('\n'))).slice(0, 48);
  const now = Math.max(Date.now(), taskUpdatedAt);

  if (!pack) {
    return {
      packId: null,
      statements: [env.DB.prepare(
        'INSERT INTO session_pack_transfer_guards(' +
        'app,transfer_id,lesson_task_id,pack_id,expected_owner,expected_assignment_key,' +
        'expected_task_identity_hash,expected_revision,expected_task_updated_at,previous_changes,created_at) ' +
        'SELECT ?,?,?,?,?,?,?,?,?,changes(),?'
      ).bind(app, guardId, String(before.id), null, newOwner, nextAssignmentKey,
        nextTaskHash, null, taskUpdatedAt, now)]
    };
  }

  const expectedOldAssignmentKey = assignmentKey(before);
  const expectedOldTaskHash = await taskHash(before, oldOwner);
  if (String(pack.student_id || '') !== String(before.studentId) ||
      String(pack.task_owner || '') !== oldOwner ||
      String(pack.lesson_assignment_key || '') !== expectedOldAssignmentKey ||
      String(pack.task_identity_hash || '') !== expectedOldTaskHash ||
      !Number.isInteger(Number(pack.revision)) || Number(pack.revision) < 1) {
    throw transferError('활성 회차권과 변경 전 수업 정체성이 일치하지 않습니다');
  }

  const nextRevision = Number(pack.revision) + 1;
  const packUpdatedAt = Math.max(taskUpdatedAt, Number(pack.updated_at || 0) + 1);
  const packId = String(pack.pack_id);
  return {
    packId,
    statements: [
      env.DB.prepare(
        'UPDATE session_packs SET task_owner=?,lesson_assignment_key=?,task_identity_hash=?,' +
        'revision=revision+1,updated_at=?,updated_by=? WHERE app=? AND pack_id=? AND lesson_task_id=? ' +
        "AND student_id=? AND status='active' AND task_owner=? AND lesson_assignment_key=? " +
        'AND task_identity_hash=? AND revision=?'
      ).bind(newOwner, nextAssignmentKey, nextTaskHash, packUpdatedAt, updatedBy,
        app, packId, String(before.id), String(before.studentId), oldOwner,
        expectedOldAssignmentKey, expectedOldTaskHash, Number(pack.revision)),
      env.DB.prepare(
        'INSERT INTO session_pack_transfer_guards(' +
        'app,transfer_id,lesson_task_id,pack_id,expected_owner,expected_assignment_key,' +
        'expected_task_identity_hash,expected_revision,expected_task_updated_at,previous_changes,created_at) ' +
        'SELECT ?,?,?,?,?,?,?,?,?,changes(),?'
      ).bind(app, guardId, String(before.id), packId, newOwner, nextAssignmentKey,
        nextTaskHash, nextRevision, taskUpdatedAt, now)
    ]
  };
}
