// 일정·출결과 독립된 내부 인계 메모. 학부모 발송 데이터에는 합치지 않는다.
export function cleanInstruction(value) {
  if (typeof value !== 'string' || value.length > 1500) {
    throw Object.assign(new Error('보강 수업 전달사항은 1,500자 이내로 입력해 주세요'), { status: 400 });
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

export function instructionAssignment(row) {
  let history;
  try { history = JSON.parse(row.history || '[]'); } catch { history = []; }
  let staff = '', revision = 0;
  for (const event of history) {
    if (!['create_manual', 'schedule', 'confirm', 'reschedule', 'reschedule_after_absence'].includes(event.action)) continue;
    if (event.staffId && event.staffId !== staff) { staff = event.staffId; revision = event.revision || 0; }
  }
  return String(row.confirmed_staff_id || '') + ':' + revision;
}

export function instructionView(row, note) {
  const assignment = instructionAssignment(row);
  return {
    text: note ? note.instruction_text : '', version: note ? Number(note.version) : 0,
    authorId: note ? note.author_id : '', updatedAt: note ? Number(note.updated_at) : 0,
    acknowledged: !!(note && Number(note.ack_version) === Number(note.version) &&
      note.ack_staff_id === row.confirmed_staff_id && note.ack_assignment === assignment),
    acknowledgedAt: note && note.ack_at || null, assignment
  };
}

export async function instructionRows(env, app, ids) {
  const result = new Map();
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const rows = await env.DB.prepare('SELECT case_id,version,instruction_text,author_id,updated_at,' +
      'ack_version,ack_staff_id,ack_assignment,ack_at FROM makeup_instructions WHERE app=? AND case_id IN (' +
      chunk.map(() => '?').join(',') + ')').bind(app, ...chunk).all();
    for (const row of rows.results || []) result.set(row.case_id, row);
  }
  return result;
}

export function instructionWrite(env, app, caseId, text, version, authorId, now) {
  const event = JSON.stringify({ text, version: version + 1, authorId, at: now });
  if (version === 0) return env.DB.prepare(
    'INSERT OR IGNORE INTO makeup_instructions(app,case_id,version,instruction_text,author_id,updated_at,history) ' +
    'VALUES(?,?,1,?,?,?,json_array(json(?)))'
  ).bind(app, caseId, text, authorId, now, event);
  return env.DB.prepare(
    'UPDATE makeup_instructions SET version=version+1,instruction_text=?,author_id=?,updated_at=?,' +
    "history=json_insert(history,'$[#]',json(?)),ack_version=0,ack_staff_id='',ack_assignment='',ack_at=NULL " +
    'WHERE app=? AND case_id=? AND version=?'
  ).bind(text, authorId, now, event, app, caseId, version);
}
