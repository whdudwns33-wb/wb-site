'use strict';
/* 관리 로그인 판정 — 워커(Cloudflare)와 로컬 서버가 같은 규칙을 쓴다.
   두 갈래: ① 아이디·비밀번호(ADMIN_ID·ADMIN_PASSWORD) ② PIN(ADMIN_PIN). 요청에 id 나 password 가 있으면 ①, 없으면 ②.
   둘 다 같은 관리 토큰을 받는다 — 어느 갈래로 들어왔든 관리 웹의 권한은 하나다.
   비교는 SHA-256 다이제스트를 고정 길이로 XOR 누적한다: 문자열 비교(===)는 처음 다른 글자에서 멈추므로
   걸린 시간을 재면 앞글자부터 맞춰 갈 수 있다. 다이제스트는 길이가 늘 같아 입력 길이도 새지 않는다. */

const enc = new TextEncoder();
async function digest(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

/* 둘 다 비어 있지 않은 문자열이어야 참 — 설정이 빠진 쪽(undefined)이 'undefined' 문자열과 맞아떨어지지 않게 */
export async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const LOGIN_ERRORS = {
  'no-account': '아이디 로그인이 아직 설정되지 않았어요 — ADMIN_ID·ADMIN_PASSWORD 시크릿을 등록하거나 PIN 으로 로그인하세요.',
  'bad-account': '아이디 또는 비밀번호가 올바르지 않습니다.',
  'bad-pin': 'PIN이 올바르지 않습니다.',
};

/* body: 요청 JSON. env: { ADMIN_PIN, ADMIN_ID, ADMIN_PASSWORD } (없는 값은 undefined 그대로) */
export async function checkAdminLogin(body, env) {
  const b = body && typeof body === 'object' ? body : {};
  const e = env || {};
  if (b.id != null || b.password != null) {
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!e.ADMIN_ID || !e.ADMIN_PASSWORD) return { ok: false, reason: 'no-account', error: LOGIN_ERRORS['no-account'] };
    /* 두 비교를 모두 끝낸 뒤 판정한다 — 아이디가 틀렸다고 먼저 돌아가면 아이디만 따로 맞춰 볼 수 있다 */
    const [okId, okPw] = await Promise.all([safeEqual(id, String(e.ADMIN_ID).trim()), safeEqual(password, String(e.ADMIN_PASSWORD))]);
    if (!okId || !okPw) return { ok: false, reason: 'bad-account', error: LOGIN_ERRORS['bad-account'] };
    return { ok: true, via: 'account' };
  }
  const pin = b.pin == null ? '' : String(b.pin);
  if (!e.ADMIN_PIN || !(await safeEqual(pin, String(e.ADMIN_PIN)))) return { ok: false, reason: 'bad-pin', error: LOGIN_ERRORS['bad-pin'] };
  return { ok: true, via: 'pin' };
}
