'use strict';
/* 출처 점검 도구가 주소 하나를 받아 오는 자리 — curl 먼저, 막히면 Node fetch.
 *
 * 왜 둘을 쓰나.
 *   이 세션의 바깥 HTTPS 는 에이전트 프록시를 지난다. 프록시가 터널을 중간에 닫으면
 *   (ws_closed_mid_exchange) curl 에는 「Recv failure: Connection reset by peer」로 닿고
 *   상태 코드는 000 이 된다. 그런데 Node 내장 fetch 는 HTTPS_PROXY 를 읽지 않아
 *   같은 주소를 그대로 받아 온다 — reading/extract-source.mjs 가 매주 그렇게 본문을 받는다.
 *
 *   2026-11-23(W48)에 .go.kr 여러 곳이 curl 000 · fetch 200 이었다. 그래서 linkcheck 의
 *   「확인 필요」가 20에서 84로 뛰었는데, 링크가 죽은 것이 아니라 **재는 길이 막힌 것**이었다.
 *   그 주에 같은 주소로 스캔 에이전트들은 본문을 멀쩡히 받아 오고 있었다.
 *
 * 그래서 curl 이 000 일 때만 fetch 로 한 번 더 묻는다.
 *   curl 이 404·403 처럼 실제 상태를 돌려주면 그 길은 막히지 않은 것이니 그대로 쓴다.
 *   둘 다 못 받으면 그때야 「응답 없음」이다 — 사람이 열어 볼 값어치가 있는 ⚠ 만 남는다.
 *
 * TLS 검증을 끄거나 HTTPS_PROXY 를 지우지 않는다. 프록시를 지나지 않는 길이 하나 더
 * 있을 뿐이고, 그 길은 이 저장소가 이미 쓰던 길이다.
 *
 * 글자 인코딩도 여기서 푼다. 연구기관 누리집 가운데 EUC-KR 로 보내는 곳이 있어
 * (2026-11-23: www.kribb.re.kr) UTF-8 로 읽으면 한글이 깨진다. 그러면 srccheck 의
 * 「제목 낱말 대조」가 멀쩡한 지면을 본문 미확인으로 떨어뜨린다 — 링크가 아니라
 * 읽는 방법이 틀린 것이다. 그래서 바이트로 받아 지면이 적어 둔 charset 으로 푼다.
 */
import { execFile } from 'node:child_process';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/* 지면이 적어 둔 charset 으로 바이트를 푼다. 못 알아보면 UTF-8 로 둔다. */
export function decode(buf) {
  if (typeof buf === 'string') return buf;
  const head = buf.slice(0, 4096).toString('latin1');
  const m = head.match(/charset\s*=\s*["']?\s*([\w-]+)/i);
  const name = (m ? m[1] : 'utf-8').toLowerCase();
  if (/^(utf-?8|us-ascii)$/.test(name)) return buf.toString('utf8');
  try { return new TextDecoder(name).decode(buf); } catch { return buf.toString('utf8'); }
}

/* curl 은 프록시를 지난다. body 가 false 면 본문을 버려 가볍게 묻는다. */
export function curlGet(url, secs, body) {
  const args = body
    ? ['-sSL', '-m', String(secs), '-A', UA, '-w', '\n@@@%{http_code}', url]
    : ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-L', '-m', String(secs), '-A', UA, url];
  return new Promise(resolve => {
    /* encoding:'buffer' 로 받아야 EUC-KR 지면을 되살릴 수 있다 — 문자열로 받으면
       이미 UTF-8 로 잘못 풀린 뒤라 되돌릴 수 없다. */
    execFile('curl', args, { timeout: (secs + 5) * 1000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        const raw = stdout || Buffer.alloc(0);
        if (!body) return resolve({ code: raw.toString('latin1').trim() || '000', html: '' });
        const s = decode(raw);
        const at = s.lastIndexOf('\n@@@');
        if (at < 0) return resolve({ code: '000', html: '' });
        resolve({ code: s.slice(at + 4).trim() || '000', html: s.slice(0, at) });
      });
  });
}

/* Node fetch 는 프록시를 지나지 않는다 — curl 이 000 일 때만 부른다. */
export async function fetchGet(url, secs, body) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' },
      signal: AbortSignal.timeout(secs * 1000)
    });
    /* r.text() 는 헤더의 charset 만 본다 — 한국 누리집은 meta 에만 적는 곳이 많다. */
    const html = body ? decode(Buffer.from(await r.arrayBuffer())) : '';
    return { code: String(r.status), html };
  } catch {
    return { code: '000', html: '' };
  }
}

/* curl 이 000 을 돌려줄 때만 다른 길로 물어볼 값어치가 있다.
   404·403 은 서버가 대답한 것이므로 길이 막힌 것이 아니다. */
export const blockedByProxy = (code) => String(code).trim() === '000';

/* 한 주소를 받아 온다. 반환: { code, html, via } — via 는 'curl' | 'fetch' | 'none'.
   transports 를 넘기면 망 없이 시험할 수 있다. */
export async function get(url, opts = {}) {
  const {
    secs = 25, body = false, tries = 2, gap = 2000,
    curl = curlGet, fetchImpl = fetchGet, sleep = (ms) => new Promise(z => setTimeout(z, ms)),
  } = opts;
  let last = { code: '000', html: '' };
  for (let i = 0; i < tries; i++) {
    last = await curl(url, secs, body);
    if (!blockedByProxy(last.code)) return { ...last, via: 'curl' };
    if (i < tries - 1) await sleep(gap * (i + 1));
  }
  const alt = await fetchImpl(url, secs, body);
  if (!blockedByProxy(alt.code)) return { ...alt, via: 'fetch' };
  return { code: '000', html: '', via: 'none' };
}
