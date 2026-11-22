// 실제 비밀번호는 stdin으로 받고, 발급한 read 키는 stdout 한 줄로만 전달한다.
import { apiKey } from './mcp-keys.mjs';

const [op, account, nameOrId, days, ...extra] = process.argv.slice(2);
const adding = op === 'add-key';
if ((!adding && op !== 'revoke-key') || account !== 'admin' || !nameOrId || extra.length ||
    (days !== undefined && (!adding || !/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 365))) {
  console.error('사용: mcp-key-cli.mjs add-key admin 연결이름 [일수] | revoke-key admin 키ID');
  process.exit(1);
}

async function post(base, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(new URL(path, base), {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  return { ok: response.ok, body: await response.json() };
}

async function run() {
  const base = new URL(process.env.WB_CRM_URL || 'http://127.0.0.1:8892');
  if (base.origin !== 'https://wb-crm.whdudwns33.workers.dev' &&
      (base.protocol !== 'http:' || base.hostname !== '127.0.0.1')) throw new Error('origin');
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('base_url');
  if (process.stdin.isTTY) {
    console.error('원장 비밀번호는 보호된 파일 또는 파이프로 stdin에 전달해 주세요.');
    return 1;
  }
  let password = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    password += chunk;
    if (password.length > 74) throw new Error('password_length');
  }
  password = password.replace(/\r?\n$/, '');
  const login = await post(base, '/api/login', { password });
  if (!login.ok || login.body.role !== 'admin' || typeof login.body.token !== 'string') {
    console.error('원장 인증 실패');
    return 1;
  }
  const token = login.body.token;
  let result;
  try {
    const body = adding ? { op, name: nameOrId, days: days === undefined ? 90 : Number(days) } : { op, id: nameOrId };
    result = await post(base, '/api/mcp-keys', body, token);
  } finally {
    const logout = await post(base, '/api/logout', {}, token).catch(() => null);
    if (!logout?.ok) console.error('임시 원장 세션 종료를 확인하지 못했습니다.');
  }
  if (!result.ok) {
    if (result.body.code === 'PASSWORD_CHANGE_REQUIRED') console.error('원장 비밀번호 변경 뒤 발급할 수 있습니다.');
    else if (result.body.code === 'KEY_LIMIT') console.error('유효한 키는 20개까지입니다.');
    else console.error('키 명령 실패');
    return 1;
  }
  if (adding) {
    if (!result.body.key?.startsWith('sls_') || !apiKey('Bearer ' + result.body.key)) throw new Error('response');
    process.stdout.write(result.body.key + '\n');
    console.error('읽기 키 발급 완료 · ID ' + result.body.id);
  } else {
    console.error('읽기 키 폐기 완료');
  }
  return 0;
}

try {
  process.exitCode = await run();
} catch {
  console.error('키 명령을 처리하지 못했습니다.');
  process.exitCode = 1;
}
