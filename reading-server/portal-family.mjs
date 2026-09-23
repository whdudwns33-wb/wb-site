'use strict';
/* 부모 포털 가족은 학생 계정이 아니다. 레터·청크에서만 기존 가족 기록 어댑터로 읽는다. */
import { safeEqual } from './admin-auth.mjs';

export const PORTAL_LINK_BODY_LIMIT = 1024;
const TOKEN_RE = /^[a-f0-9]{32}$/;
export const portalFamilyToken = (code) => /^portal-([a-f0-9]{32})$/.exec(String(code || ''))?.[1] || '';
const reply = (status, body) => ({ status, body });

/* Content-Length 없는 요청도 같은 상한으로 읽는다(Worker Web Stream). */
export async function readPortalLinkBody(request) {
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PORTAL_LINK_BODY_LIMIT) {
      await reader.cancel();
      throw Object.assign(new Error('body limit'), { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function handlePortalFamilyLink({ method, authorization, secret, getBody, store }) {
  if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(secret))
    return reply(503, { error: 'portal_link_not_configured' });
  const provided = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (provided.length > 256 || !(await safeEqual(provided, secret)))
    return reply(401, { error: 'unauthorized' });
  let body;
  try { body = await getBody(); }
  catch (error) { return reply(error?.status === 413 ? 413 : 400, { error: 'invalid_body' }); }
  const token = body?.token;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!body || Array.isArray(body) || typeof token !== 'string' || !TOKEN_RE.test(token)
      || !name || [...name].length > 80 || /[\x00-\x1f\x7f]/.test(name))
    return reply(400, { error: 'invalid_family' });
  const code = 'portal-' + token;
  try {
    // 기존 학생의 토큰/기록을 포털 가족으로 가로채거나 덮어쓰지 않는다.
    if (await store.getParentCode(token) || await store.getStudent(code))
      return reply(409, { error: 'family_link_conflict' });
    const existing = await store.getFamily(token);
    if (existing && (existing.code !== code || existing.ptoken !== token))
      return reply(409, { error: 'family_link_conflict' });
    if (!existing) {
      // ponytail: KV 동시 최초 쓰기는 같은 키/권한으로 수렴한다. 강한 갱신 CAS가 필요하면 Durable Object로 이동.
      await store.putFamily(token, { code, name, ptoken: token, apps: ['letter', 'chunk'] });
    }
    return reply(200, { ok: true, token });
  } catch {
    // 저장소 예외에는 가족 키가 포함될 수 있어 원문을 응답·로그로 내보내지 않는다.
    return reply(503, { error: 'family_link_unavailable' });
  }
}

/* 이 어댑터는 레터·청크 두 앱만 사용한다. 학생 로그인·다른 앱은 원래 명부를 계속 쓴다. */
export function withPortalFamilies(store) {
  return {
    getParentCode: async (token) => await store.getParentCode(token)
      || (TOKEN_RE.test(token) && await store.getFamily(token) ? 'portal-' + token : null),
    putParent: store.putParent,
    getStudent: async (code) => {
      const token = portalFamilyToken(code);
      return await store.getStudent(code) || (token ? store.getFamily(token) : null);
    },
    putStudent: async (code, record) => {
      const token = portalFamilyToken(code);
      return token && !await store.getStudent(code) ? store.putFamily(token, record) : store.putStudent(code, record);
    },
    listStudentCodes: async () => [...await store.listStudentCodes(),
      ...(await store.listFamilyTokens()).map(token => 'portal-' + token)],
  };
}
