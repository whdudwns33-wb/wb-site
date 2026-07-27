// MVP API 서버 — Node 내장 http만 사용(무의존성, 즉시 실행 가능).
// 프로덕션은 Fastify + Postgres + 정식 인증으로 교체. 여기선 흐름·계약 검증이 목표.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { store } from './store.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROTO_HTML = join(__dir, '..', '..', 'apps', 'picture-test', 'index.html');
import { runPipeline, confirmSubmission } from './pipeline.mjs';
import { assertTransition } from './stateMachine.mjs';

const PORT = process.env.PORT || 8787;
const POLICY_VERSION = '2026-07-27';

// ── 라우팅 헬퍼 ──────────────────────────────────────────────
const routes = [];
const on = (method, pattern, handler) => routes.push({ method, pattern, handler });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });

// MVP 인증(자리표시): 실제로는 세션/JWT + RBAC. 데모는 헤더 role로 대체.
const requireRole = (req, role) => (req.headers['x-role'] || 'parent') === role || (req.headers['x-role'] === 'admin');

// ── 공개(학부모) ──────────────────────────────────────────────
on('POST', /^\/api\/submissions$/, async (req, res) => {
  const b = await readBody(req);
  if (!['HTP', 'KFD', 'DAP', 'FREE'].includes(b.test_type)) return json(res, 400, { error: '검사종류 오류' });
  const child = store.createChild({ alias: b.child?.alias || '○○', birth_year: b.child?.birth_year, sex: b.child?.sex, context_note: b.child?.context_note });
  const age = b.child?.birth_year ? new Date().getFullYear() - b.child.birth_year : b.child?.age;
  const sub = store.createSubmission({
    child_id: child.id, test_type: b.test_type, status: 'consent_pending',
    meta: { age, sex: b.child?.sex, context: b.child?.context_note }
  });
  store.audit({ action: 'submission.created', target_type: 'submission', target_id: sub.id });
  json(res, 201, { submission_id: sub.id, status: sub.status });
});

on('POST', /^\/api\/submissions\/([^/]+)\/consent$/, async (req, res, [id]) => {
  const b = await readBody(req);
  const sub = store.getSubmission(id); if (!sub) return json(res, 404, { error: '없음' });
  if (!b.analysis || !b.store) return json(res, 400, { error: '필수 동의 누락' });
  // 만 14세 미만은 보호자 인증 필수
  if ((sub.meta?.age ?? 99) < 14 && !b.guardian_verified) return json(res, 400, { error: '만14세 미만 보호자 인증 필요' });
  const consent = store.createConsent({ guardian_verified: !!b.guardian_verified, scope: { analysis: b.analysis, store: b.store, improve: !!b.improve }, policy_version: POLICY_VERSION, signed_at: new Date().toISOString() });
  assertTransition(sub.status, 'uploaded');
  store.updateSubmission(id, { consent_id: consent.id, status: 'uploaded' });
  store.audit({ action: 'consent.signed', target_type: 'submission', target_id: id });
  json(res, 200, { status: 'uploaded' });
});

on('POST', /^\/api\/submissions\/([^/]+)\/image$/, async (req, res, [id]) => {
  const b = await readBody(req);
  const sub = store.getSubmission(id); if (!sub) return json(res, 404, { error: '없음' });
  if (sub.status !== 'uploaded') return json(res, 409, { error: `상태 오류: ${sub.status}` });
  // 데모: 실제 이미지 대신 image_ref 키워드(sample-htp / sample-crisis) 허용
  store.updateSubmission(id, { image_key: b.image_ref || 'sample-htp', meta: { ...sub.meta, image_base64: b.image_base64 } });
  store.audit({ action: 'image.uploaded', target_type: 'submission', target_id: id });
  const result = await runPipeline(id);   // MVP: 동기 실행(프로덕션은 잡 큐)
  json(res, 200, result);
});

on('GET', /^\/api\/submissions\/([^/]+)\/preview$/, async (req, res, [id]) => {
  const sub = store.getSubmission(id); if (!sub) return json(res, 404, { error: '없음' });
  if (!['reviewing', 'confirmed', 'published'].includes(sub.status)) return json(res, 409, { error: `미리보기 불가: ${sub.status}` });
  const interp = store.interpBySubmission(id);
  json(res, 200, { status: sub.status, parent_preview: interp?.parent_preview, note: '전문가 확정 후 정식 리포트가 제공됩니다.' });
});

on('GET', /^\/api\/reports\/([^/]+)$/, async (req, res, [token], url) => {
  const report = store.reportByToken(token); if (!report) return json(res, 404, { error: '없음' });
  const sub = store.getSubmission(report.submission_id);
  // 확정 게이트: published만 반환
  if (sub.status !== 'published') return json(res, 403, { error: '아직 전문가 확정 전' });
  if (report.expires_at && new Date(report.expires_at) < new Date()) return json(res, 410, { error: '링크 만료' });
  // 2차 확인: 아동 생년(birth_year) 일치
  const child = store.getChild(sub.child_id);
  const by = url.searchParams.get('birth_year');
  if (child?.birth_year && String(child.birth_year) !== String(by)) {
    return json(res, 403, { error: '생년 확인 실패' });
  }
  const interp = store.interpBySubmission(report.submission_id);
  report.viewed_at = new Date().toISOString();
  store.audit({ action: 'report.viewed', target_type: 'submission', target_id: report.submission_id });
  json(res, 200, { report: interp?.summary_parent });
});

// ── 전문가 콘솔 ──────────────────────────────────────────────
on('GET', /^\/api\/console\/queue$/, async (req, res) => {
  if (!requireRole(req, 'expert')) return json(res, 403, { error: '권한 없음' });
  const q = store.listSubmissions(['reviewing', 'escalated']).map((s) => ({ id: s.id, test_type: s.test_type, status: s.status }));
  json(res, 200, { queue: q });
});

on('GET', /^\/api\/console\/submissions\/([^/]+)$/, async (req, res, [id]) => {
  if (!requireRole(req, 'expert')) return json(res, 403, { error: '권한 없음' });
  const sub = store.getSubmission(id); if (!sub) return json(res, 404, { error: '없음' });
  json(res, 200, {
    id: sub.id, test_type: sub.test_type, status: sub.status, meta: sub.meta,
    image_url: `signed://mock/${sub.image_key}`,   // 실제: 단기 서명 URL
    observations: store.obsBySubmission(id),
    hypotheses: store.hypBySubmission(id),
    expert_draft: store.interpBySubmission(id)?.summary_expert
  });
});

on('PATCH', /^\/api\/console\/hypotheses\/([^/]+)$/, async (req, res, [hid]) => {
  if (!requireRole(req, 'expert')) return json(res, 403, { error: '권한 없음' });
  const b = await readBody(req);
  const map = { accept: 'accepted', edit: 'edited', reject: 'rejected' };
  if (!map[b.action]) return json(res, 400, { error: 'action 오류' });
  const h = store.getHypothesis(hid); if (!h) return json(res, 404, { error: '없음' });
  store.updateHypothesis(hid, { status: map[b.action], edited_text: b.edited_text ?? h.edited_text, expert_note: b.note ?? h.expert_note });
  store.audit({ action: 'hypothesis.' + b.action, target_type: 'hypothesis', target_id: hid });
  json(res, 200, { ok: true, status: map[b.action] });
});

on('POST', /^\/api\/console\/submissions\/([^/]+)\/confirm$/, async (req, res, [id]) => {
  if (!requireRole(req, 'expert')) return json(res, 403, { error: '권한 없음' });
  try {
    const result = await confirmSubmission(id, req.headers['x-user-id'] || 'expert-demo');
    json(res, 200, result);
  } catch (e) { json(res, 400, { error: e.message }); }
});

on('POST', /^\/api\/console\/submissions\/([^/]+)\/escalate$/, async (req, res, [id]) => {
  if (!requireRole(req, 'expert')) return json(res, 403, { error: '권한 없음' });
  const b = await readBody(req);
  store.createCrisis({ submission_id: id, level: b.level || 'watch', flags: b.flags || [], action_taken: b.action, handled_by: req.headers['x-user-id'] });
  store.audit({ action: 'crisis.handled', target_type: 'submission', target_id: id });
  json(res, 200, { ok: true });
});

// ── 관리자 ───────────────────────────────────────────────────
on('GET', /^\/api\/admin\/audit$/, async (req, res) => {
  if (!requireRole(req, 'admin')) return json(res, 403, { error: '권한 없음' });
  json(res, 200, { audit: store.auditLog() });
});

on('GET', /^\/api\/health$/, async (req, res) => json(res, 200, { ok: true }));

// ── 디스패처 ─────────────────────────────────────────────────
export const server = createServer(async (req, res) => {
  try {
    // 개발용 CORS (프로덕션은 허용 출처를 좁힐 것)
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,x-role,x-user-id');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 정적: 프로토타입을 같은 출처에서 서빙(CORS 없이 API 호출 가능)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(PROTO_HTML, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (m) return await r.handler(req, res, m.slice(1), url);
    }
    json(res, 404, { error: 'route 없음' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`그림검사 백엔드 MVP · http://localhost:${PORT} (mock AI: ${!process.env.ANTHROPIC_API_KEY})`));
}
