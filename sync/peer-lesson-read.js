import { lessonOccurrencesOnDate, validDate, clockMinute } from './student-next-schedule.js';
import { weekendAttendancePolicyOn } from './weekend-flex.js';

const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const group = env => String(env.TASK_PEER_LESSON_STAFF_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const visitClock = stamp => Number(stamp) > 0 ? new Date(Number(stamp) + 9*3600000).toISOString().slice(11,16) : '';
const minuteClock = n => String(Math.floor(n/60)).padStart(2,'0') + ':' + String(n%60).padStart(2,'0');
export function isPeerLessonReader(env, app, auth) {
  return app === 'task' && auth?.scope === 'own' && !!auth.id && group(env).includes(auth.id);
}

// 편집용 sync 상태와 분리한다. 학생 연락처·관리 업무·직원 인증 필드는 반환하지 않는다.
export function peerLessonEntries(tasks, checks, cases, visits, from, to) {
  const entries = [];
  for (let date = from; date <= to; date = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0,10)) {
    for (const t of tasks) {
      if (!t || t.deleted || !/^\[(수업|컨설팅)\]/.test(t.title || '')) continue;
      const visit = visits.find(v => v.lesson_task_id === t.id && v.student_id === t.studentId && v.visit_date === date && v.status !== 'cancelled');
      const policy = weekendAttendancePolicyOn(t, date);
      if (policy === 'invalid' || (policy === 'flexible' && !visit)) continue;
      const sourceDate = visit?.source_date || date;
      let slots = lessonOccurrencesOnDate(t, sourceDate, cases);
      if (policy === 'flexible' && visit) {
        const startTime = visitClock(visit.check_in_at), start = clockMinute(startTime);
        let end = clockMinute(visitClock(visit.check_out_at));
        const reference = (t.scheduleSlots || []).find(s => clockMinute(s.endTime) > clockMinute(s.startTime));
        if (start == null) continue;
        if (end == null || end <= start) end = Math.min(1439,start + (reference ? clockMinute(reference.endTime)-clockMinute(reference.startTime) : 50));
        slots = [{slotId:String(visit.visit_id),startTime,endTime:minuteClock(end)}];
      }
      // 실제 방문으로 다른 날에 이동한 정규 수업은 원래 날짜에 중복 표시하지 않는다.
      if (!visit && visits.some(v => v.lesson_task_id === t.id && v.source_date === date && v.visit_date !== date && v.status !== 'cancelled')) continue;
      const check = checks[t.id + '|' + date] || {};
      const memo = check.lessonMemo && typeof check.lessonMemo === 'object' ? check.lessonMemo : {};
      for (const slot of slots) {
        const startMinute = clockMinute(slot.startTime), endMinute = clockMinute(slot.endTime);
        if (startMinute == null || endMinute == null || endMinute <= startMinute) continue;
        entries.push({ key:t.id + '|' + date + '|' + slot.slotId, date, staffId:t.staffId,
          studentName:String(t.studentName || ''),
          slot:{startMinute,endMinute},
          task:{subject:String(t.subject || ''),lessonInstanceType:t.makeupCaseId ? 'makeup' : String(t.lessonInstanceType || ''),firstClassDate:String(t.firstClassDate || '')},
          progress:{att:String(check.att || ''), done:!!check.done,
            contentProgress:String(memo.contentProgress || (!check.lessonMemo ? check.note || '' : '')),
            homework:String(memo.homework || ''),otherNotes:String(memo.otherNotes || '')}
        });
      }
    }
  }
  return entries.sort((a,b) => a.date.localeCompare(b.date) || a.slot.startMinute-b.slot.startMinute || a.studentName.localeCompare(b.studentName,'ko'));
}

export async function handlePeerLessonRead(env, app, body, origin, auth, json) {
  if (!isPeerLessonReader(env,app,auth) || !['list','week'].includes(body.action)) return json({ok:false,error:'동료 수업 조회 권한이 없습니다'},403,origin);
  const rows = await env.DB.prepare('SELECT id,data FROM staff WHERE app=?').bind(app).all();
  const allowed = group(env);
  const staff = (rows.results || []).map(r => ({...parse(r.data),id:r.id})).filter(s => allowed.includes(s.id) && !s.deleted && s.active !== false);
  if (!staff.some(s => s.id === auth.id)) return json({ok:false,error:'활성 직원만 조회할 수 있습니다'},403,origin);
  const names = staff.map(s => ({id:s.id,name:String(s.name || '')}));
  if (body.action === 'list') return json({ok:true,staff:names},200,origin);
  const target = String(body.staffId || '');
  if (!staff.some(s => s.id === target)) return json({ok:false,error:'조회 대상 선생님을 확인해 주세요'},403,origin);
  const from = String(body.from || ''), to = String(body.to || '');
  if (!validDate(from) || !validDate(to) || to < from || Date.parse(to)-Date.parse(from) > 6*86400000) return json({ok:false,error:'한 주 범위로 조회해 주세요'},400,origin);
  const taskRows = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND owner=?').bind(app,target).all();
  const tasks = (taskRows.results || []).map(r => parse(r.data)).filter(t => t && t.staffId === target && !t.deleted);
  const ids = new Set(tasks.map(t => t.id));
  const checkRows = await env.DB.prepare('SELECT k,data FROM checks WHERE app=? AND owner=? AND substr(k,-10)>=? AND substr(k,-10)<=?').bind(app,target,from,to).all();
  const checks = Object.fromEntries((checkRows.results || []).filter(r => ids.has(r.k.split('|')[0])).map(r => [r.k,parse(r.data) || {}]));
  const caseRows = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND confirmed_staff_id=? AND substr(confirmed_start_at,1,10)>=? AND substr(confirmed_start_at,1,10)<=?').bind(app,target,from,to).all();
  const visitRows = await env.DB.prepare("SELECT * FROM weekend_actual_visits WHERE app=? AND staff_id=? AND status<>'cancelled' AND ((visit_date>=? AND visit_date<=?) OR (source_date>=? AND source_date<=?))").bind(app,target,from,to,from,to).all();
  return json({ok:true,staff:names,entries:peerLessonEntries(tasks,checks,caseRows.results || [],visitRows.results || [],from,to)},200,origin);
}
