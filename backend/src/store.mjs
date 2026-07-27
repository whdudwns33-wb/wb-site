// 개발용 인메모리 저장소 — db/schema.sql 구조를 미러링.
// 프로덕션에서는 PostgreSQL 리포지토리로 교체(같은 메서드 시그니처 유지).

import { randomUUID } from 'node:crypto';

const db = {
  child: new Map(), consent: new Map(), submission: new Map(),
  observation: new Map(), hypothesis: new Map(), interpretation: new Map(),
  parent_report: new Map(), crisis_event: new Map(), audit_log: []
};

const put = (t, row) => { const id = row.id || randomUUID(); db[t].set(id, { id, ...row }); return db[t].get(id); };
const get = (t, id) => db[t].get(id);
const all = (t) => [...db[t].values()];

export const store = {
  createChild:      (c) => put('child', c),
  getChild:         (id) => get('child', id),
  createConsent:    (c) => put('consent', c),
  createSubmission: (s) => put('submission', { status: 'created', meta: {}, ...s }),
  getSubmission:    (id) => get('submission', id),
  updateSubmission: (id, patch) => { const s = get('submission', id); Object.assign(s, patch); return s; },
  listSubmissions:  (statuses) => all('submission').filter((s) => !statuses || statuses.includes(s.status)),

  addObservation:   (o) => put('observation', o),
  obsBySubmission:  (sid) => all('observation').filter((o) => o.submission_id === sid),

  addHypothesis:    (h) => put('hypothesis', { status: 'ai_suggested', needs_expert_check: true, ...h }),
  getHypothesis:    (id) => get('hypothesis', id),
  hypBySubmission:  (sid) => all('hypothesis').filter((h) => h.submission_id === sid),
  updateHypothesis: (id, patch) => { const h = get('hypothesis', id); Object.assign(h, patch); return h; },

  saveInterpretation: (i) => put('interpretation', i),
  interpBySubmission: (sid) => all('interpretation').find((i) => i.submission_id === sid),

  createReport:     (r) => put('parent_report', r),
  reportByToken:    (tok) => all('parent_report').find((r) => r.share_token === tok),

  createCrisis:     (c) => put('crisis_event', c),

  audit:            (e) => { db.audit_log.push({ id: db.audit_log.length + 1, created_at: new Date().toISOString(), ...e }); },
  auditLog:         () => db.audit_log,

  _reset:           () => { for (const k of Object.keys(db)) { if (Array.isArray(db[k])) db[k] = []; else db[k].clear(); } }
};
