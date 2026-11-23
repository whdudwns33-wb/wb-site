import { digest, hashPassword } from './task-director.js';

export const CHECKER_ID = 'wbcheck';
const HOME = '/task/checker';
const ME = HOME + '/me', TODAY = HOME + '/today';
const LOGIN = HOME + '/login', LOGOUT = HOME + '/logout';
const COOKIE = '__Host-wb_task_checker';
const MAX_AGE = 30 * 60;
const PASSWORD = /^[A-Za-z0-9_-]{43,100}$/;
const VERIFIER = /^([a-f0-9]{32}):([a-f0-9]{64})$/;
const user = { loginId: CHECKER_ID, role: 'checker', mustChange: false };

export async function checkerVerifier(password) {
  if (typeof password !== 'string' || !PASSWORD.test(password)) {
    throw new Error('점검 암호는 표준 입력으로 받는 43~100자 base64url 값이어야 합니다.');
  }
  const salt = crypto.randomUUID().replaceAll('-', '');
  return salt + ':' + await hashPassword(password, salt);
}

function respond(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });
}

function setCookie(token, seconds) {
  return { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}` };
}

async function login(request, env, verifier, now) {
  const body = await request.json().catch(() => null);
  const password = body?.password;
  if (!verifier || body?.username !== CHECKER_ID || typeof password !== 'string' || !PASSWORD.test(password)) {
    return respond({ error: 'bad_login' }, 401);
  }
  const [, salt, expected] = verifier;
  const candidate = await hashPassword(password, salt);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  if (difference !== 0) return respond({ error: 'bad_login' }, 401);

  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const tokenHash = await digest(expected + ':' + token);
  await env.DB.prepare('DELETE FROM task_checker_sessions WHERE expires_at<=?').bind(now).run();
  await env.DB.prepare('INSERT INTO task_checker_sessions(token_hash,expires_at) VALUES(?,?)')
    .bind(tokenHash, now + MAX_AGE * 1000).run();
  return respond({ user }, 200, setCookie(token, MAX_AGE));
}

// 점검 세션은 기기 토큰·직원 프로필·출퇴근 테이블에 연결되지 않는다.
export async function handleTaskChecker(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const cookie = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)__Host-wb_task_checker=([a-f0-9]{64})(?:;|$)/);
  const dedicated = path === HOME || path.startsWith(HOME + '/');
  if (!cookie && !dedicated) return null;
  const verifier = VERIFIER.exec(env.WB_TASK_CHECKER_VERIFIER || '');
  const now = Date.now();
  const tokenHash = cookie && verifier && await digest(verifier[2] + ':' + cookie[1]);
  const session = tokenHash && await env.DB.prepare('SELECT 1 FROM task_checker_sessions WHERE token_hash=? AND expires_at>?')
    .bind(tokenHash, now).first();

  const origin = request.headers.get('Origin');
  if (url.search || request.headers.has('Authorization') || (origin && origin !== url.origin) ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return session || dedicated ? respond({ error: 'checker_read_only' }, 403) : null;
  }
  if (method === 'POST' && path === LOGIN) return login(request, env, verifier, now);
  if (method === 'GET' && path === HOME) return checkerPage(!!session);
  if (session) {
    if (method === 'GET' && path === ME) return respond({ user });
    if (method === 'GET' && path === TODAY) {
      const date = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
      return respond({ date, items: [{ id: 'synth-checker', title: 'synth-점검 업무', status: '요청' }] });
    }
    if (method === 'POST' && path === LOGOUT) {
      await env.DB.prepare('DELETE FROM task_checker_sessions WHERE token_hash=?').bind(tokenHash).run();
      return respond({ ok: true }, 200, setCookie('', 0));
    }
    return respond({ error: 'checker_read_only' }, 403);
  }
  return dedicated ? respond({ error: 'checker_login_required' }, 401) : null;
}

function checkerPage(authenticated) {
  return new Response(`<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>업무지시서 · 점검</title>
<style>
  body { margin: 0 auto; max-width: 42rem; padding: 1.5rem; font: 1rem/1.5 system-ui, sans-serif; color: #18251f; background: #f3f7f4; }
  form, article { display: grid; gap: .75rem; padding: 1rem; background: white; border: 1px solid #baccc1; border-radius: .5rem; }
  label { display: grid; gap: .25rem; }
  input, button { min-height: 44px; padding: 0 .75rem; font: inherit; }
</style>
<main>
  ${authenticated ? `<h1 id="checker-screen">오늘</h1><p>점검 전용 · 읽기 전용</p>
  <article id="sample" role="status">불러오는 중</article>
  <p><button id="logout" type="button">로그아웃</button></p>` :
    '<h1>업무지시서 점검 로그인</h1><form id="login"><label>아이디<input name="username" autocomplete="username" required></label><label>암호<input name="password" type="password" autocomplete="current-password" required></label><button>로그인</button></form>'}
  <p id="error" role="alert"></p>
</main>
<script>
  const error = document.querySelector('#error');
  async function request(path, options) {
    const response = await fetch(path, options);
    if (!response.ok) throw new Error();
    return response.json();
  }
  const form = document.querySelector('#login');
  if (form) form.onsubmit = async event => {
    event.preventDefault();
    try {
      const body = JSON.stringify(Object.fromEntries(new FormData(form)));
      await request('${LOGIN}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      location.reload();
    } catch { error.textContent = '점검 계정으로 로그인하지 못했습니다.'; }
  };
  const sample = document.querySelector('#sample');
  if (sample) {
    request('${TODAY}').then(data => { sample.textContent = data.items[0].title; })
      .catch(() => { sample.textContent = '점검 자료를 불러오지 못했습니다.'; });
    document.querySelector('#logout').onclick = async () => {
      try { await request('${LOGOUT}', { method: 'POST' }); location.reload(); }
      catch { error.textContent = '로그아웃을 완료하지 못했습니다.'; }
    };
  }
</script>
</html>`, {headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Robots-Tag': 'noindex, nofollow'
  }});
}
