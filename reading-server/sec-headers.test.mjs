#!/usr/bin/env node
/* 보안 헤더가 로컬 서버에서도 나가는지 — node reading-server/sec-headers.test.mjs
 *
 * 정본은 reading/_headers 하나다(절대 규칙 3). 운영은 Cloudflare 가 그 파일을 읽어 붙이고,
 * 이 서버는 sec-headers.mjs 가 같은 파일을 파싱해 붙인다. 두 경로가 같은 파일을 본다는 것을
 * 여기서 실제 HTTP 로 확인한다 — 값을 테스트에 베껴 적으면 세 곳이 갈라진다.
 *
 * 왜 필요한가: 이 서버가 localhost 전용이던 동안은 헤더가 없어도 티가 안 났다. 터널이나
 * 포트포워딩으로 외부에 열면 noindex·CSP·X-Frame-Options 가 전부 없는 공개 호스트가 되고,
 * 그 서버는 학생 앱 전부와 관리 웹을 서빙한다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeadersFrom, parseHeadersFile } from './sec-headers.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8700 + (process.pid % 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-sec-'));
const PIN = 'test-pin-not-a-real-secret';
const BASE = `http://127.0.0.1:${PORT}`;
const errors = [];
const ok = (cond, m) => { if (!cond) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS_TEXT = fs.readFileSync(path.join(DIR, '..', 'reading', '_headers'), 'utf8');
const WANT = securityHeadersFrom(HEADERS_TEXT);

/* 파서 — 값을 베끼지 않고 모양만 본다 */
ok(Object.keys(WANT).length >= 5, '전 경로 보안 헤더가 5개 미만이다 — _headers 의 /* 블록을 확인하세요');
ok(/noindex/.test(WANT['X-Robots-Tag'] || ''), 'X-Robots-Tag 에 noindex 가 없다');
ok(!('Cache-Control' in WANT), 'Cache-Control 을 보안 헤더로 가져오면 안 된다 — 경로별 규칙과 합쳐져 캐시가 무력화된다');
ok(parseHeadersFile(HEADERS_TEXT)['/*'], '_headers 에 /* 블록이 없다');

const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PIN: PIN },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + '/api/health'); break; } catch { await sleep(100); }
  }

  /* 네 갈래를 모두 본다 — 정적 루트·앱 디렉터리·API·404. 라우팅 분기마다 따로 쓰면
     한 갈래만 빠지는데, 빠진 쪽이 하필 관리 웹이면 그게 공개로 색인된다. */
  const paths = ['/', '/naesin/', '/vocab/', '/admin/', '/api/health', '/이런-경로-없다'];
  for (const p of paths) {
    const r = await fetch(BASE + p);
    for (const k of Object.keys(WANT)) {
      ok(r.headers.get(k) === WANT[k],
        `${p} 응답에 ${k} 가 정본과 다르다 — 받은 값: ${JSON.stringify(r.headers.get(k))}`);
    }
  }

  /* 경로별 Cache-Control 은 그대로 살아 있어야 한다 — 보안 헤더를 붙이면서 덮으면
     분할 지문이 매번 다시 받아지거나 반대로 옛 화면이 굳는다. */
  const shell = await fetch(BASE + '/naesin/');
  ok(shell.headers.get('cache-control') === 'no-store', '앱 셸이 no-store 가 아니다');
  const api = await fetch(BASE + '/api/health');
  ok(api.headers.get('cache-control') === 'no-store', 'API 응답이 no-store 가 아니다');
  const split = await fetch(BASE + '/articles-L2.json');
  ok(/max-age=604800/.test(split.headers.get('cache-control') || ''),
    '학년대별 지문의 장기 캐시 규칙이 사라졌다 — 앱을 켤 때마다 다시 받는다');
} catch (e) {
  errors.push('예외: ' + (e && e.message));
} finally {
  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — 보안 헤더 6종이 정적·앱·관리·API·404 전 갈래에서 정본과 일치, 경로별 캐시 규칙 보존');
