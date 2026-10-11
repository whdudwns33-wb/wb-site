/* 보안 헤더 — 정본은 `reading/_headers` 하나다(CLAUDE.md 절대 규칙 3).
   운영(Cloudflare)은 그 파일을 읽어 전 경로에 붙이지만, Node 로컬 서버는 아무것도 붙이지 않았다.
   localhost 전용일 때는 티가 안 났다. 터널·포트포워딩으로 이 서버가 외부에 열리는 순간
   noindex 도 CSP 도 X-Frame-Options 도 없는 공개 호스트가 된다 — 학생 앱 전부를 서빙하는 서버다.

   값을 여기 베껴 적지 않고 `reading/_headers` 를 파싱한다. 베껴 적으면 한쪽만 고치는 사고가 난다
   (실제로 naesin/_headers 가 그렇게 갈라져서 지금은 안내 주석만 남아 있다).

   Cache-Control 은 가져오지 않는다 — `_headers` 의 /* 에는 일부러 없고(분할본 max-age 와 합쳐지면
   캐시가 통째로 무력화된다), 경로별 규칙은 serveFile·json 이 각자 정한다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADERS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reading', '_headers');

/* dist-cache.test.mjs 와 같은 문법으로 읽는다 — 들여쓴 줄이 바로 위 경로 블록의 헤더다. */
export function parseHeadersFile(text) {
  const rules = {};
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { cur = raw.trim(); rules[cur] = rules[cur] || {}; continue; }
    const m = raw.trim().match(/^([^:]+):\s*(.*)$/);
    if (m && cur) rules[cur][m[1].trim()] = m[2].trim();
  }
  return rules;
}

/* 전 경로(/*) 블록에서 Cache-Control 만 뺀 것. */
export function securityHeadersFrom(text) {
  const all = parseHeadersFile(text)['/*'] || {};
  const out = {};
  for (const k of Object.keys(all)) if (k.toLowerCase() !== 'cache-control') out[k] = all[k];
  return out;
}

/* 기동 때 한 번 읽는다. noindex 가 없으면 뜨지 않는다 — 보호 없이 뜨는 것보다 안전하다
   (관리 로그인에 기본값을 두지 않는 것과 같은 판단). */
function load() {
  let text;
  try {
    text = fs.readFileSync(HEADERS_FILE, 'utf8');
  } catch {
    throw new Error('보안 헤더 정본을 읽지 못했습니다: ' + HEADERS_FILE);
  }
  const h = securityHeadersFrom(text);
  if (!/noindex/.test(h['X-Robots-Tag'] || '')) {
    throw new Error(HEADERS_FILE + ' 의 /* 에 X-Robots-Tag: noindex 가 없습니다 — 보호 없이 뜨지 않습니다');
  }
  return h;
}

export const SECURITY_HEADERS = load();

/* 응답마다 한 번. writeHead 가 뒤에 와도 setHeader 값은 병합된다(실측 확인). */
export function applySecurityHeaders(res) {
  for (const k of Object.keys(SECURITY_HEADERS)) res.setHeader(k, SECURITY_HEADERS[k]);
}
