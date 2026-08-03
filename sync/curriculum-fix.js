import searchWorker from './search-filter.js';
import { resolveAuth } from './worker-core.js';

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Cache-Control': 'no-store'
  }
});


function publicUrlOrNull(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch (error) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some(part => part > 255) || parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254)) return null;
  }
  if (host === '[::1]' || host.startsWith('[fc') || host.startsWith('[fd')) return null;
  return url.toString();
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchCoursePage(rawUrl) {
  const url = new URL(rawUrl);
  const response = await fetch(url.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer': url.origin + '/',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin'
    }
  });
  if (!response.ok) return { ok: false, status: response.status, html: '' };

  const buffer = await response.arrayBuffer();
  const decode = encoding => {
    try { return new TextDecoder(encoding).decode(buffer); } catch (error) { return null; }
  };
  const charset = (response.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i);
  if (charset) {
    const decoded = decode(charset[1]);
    if (decoded) return { ok: true, status: response.status, html: decoded };
  }
  const utf8 = decode('utf-8') || '';
  if ((utf8.match(/\uFFFD/g) || []).length > 5) {
    const eucKr = decode('euc-kr');
    if (eucKr) return { ok: true, status: response.status, html: eucKr };
  }
  return { ok: true, status: response.status, html: utf8 };
}

const TAG_RE = /<[^>]+>/g;
const LECTURE_ROW = /\d{1,2}:\d{2}|^\d{1,3}\s*강[\s.]/;

function unescapeHtml(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits) => String.fromCharCode(Number(digits)))
    .replace(/&amp;/g, '&');
}

function normalizedDurationLine(text) {
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
  if (!match) return text;
  let minutes;
  if (match[3] !== undefined) {
    minutes = Number(match[1]) * 60 + Number(match[2]) + (Number(match[3]) >= 30 ? 1 : 0);
  } else {
    minutes = Number(match[1]) + (Number(match[2]) >= 30 ? 1 : 0);
  }
  return text.slice(0, match.index).replace(/[\s\-–—·|,]+$/, '').trim() + ' ' + minutes + '분';
}

function numberedLectureLines(lines) {
  const output = [];
  for (let text of lines) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text || /^선배\s*추천\b/.test(text)) continue;
    text = normalizedDurationLine(text);
    if (!/^\d{1,3}\s*(?:강|회|차|교시|[.)\]:-])/.test(text)) {
      text = (output.length + 1) + '강 ' + text;
    }
    output.push(text);
  }
  return output;
}

function extractCurriculum(rawHtml) {
  let html = String(rawHtml || '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const candidates = [];
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    let text = cells.map(cell => cell.replace(TAG_RE, ' ')).join(' ');
    text = unescapeHtml(text.replace(/\s+/g, ' ')).trim();
    if (text && LECTURE_ROW.test(text)) candidates.push(text);
  }
  if (!candidates.length) {
    html.replace(TAG_RE, '\n').split('\n').forEach(line => {
      line = unescapeHtml(line.replace(/\s+/g, ' ')).trim();
      if (line.length > 6 && /\d{1,2}:\d{2}/.test(line)) candidates.push(line);
    });
  }
  return numberedLectureLines(candidates).join('\n');
}

function blockedHint(status) {
  if (status === 401 || status === 403 || status === 429) {
    return '강의 사이트가 자동 가져오기를 제한했습니다. 강좌 페이지의 강의목차를 복사해 ③ 커리큘럼 칸에 붙여넣어 주세요.';
  }
  return '강좌 페이지를 가져오지 못했습니다 (HTTP ' + status + '). 강의목차를 직접 붙여넣어 주세요.';
}

async function handleCurriculum(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  const url = publicUrlOrNull(body.url);
  if (!url) return json({ ok: false, error: '올바른 공개 강좌 주소를 넣어 주세요' }, 400, origin);

  const fetched = await fetchCoursePage(url);
  if (!fetched.ok) return json({ ok: true, text: '', hint: blockedHint(fetched.status) }, 200, origin);
  const text = extractCurriculum(fetched.html);
  return json({
    ok: true,
    text,
    hint: text ? '' : '이 페이지에서는 강의목차를 자동으로 찾지 못했습니다. 목차를 복사해 직접 붙여넣어 주세요.'
  }, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/curriculum' || request.method !== 'POST') {
      return searchWorker.fetch(request, env, ctx);
    }

    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOW_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
    const okOrigin = !origin || !allowed.length || allowed.includes(origin) ? (origin || '*') : null;
    if (okOrigin === null) return json({ ok: false, error: '허용되지 않은 출처' }, 403, '*');

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return json({ ok: false, error: '본문을 읽을 수 없습니다' }, 400, okOrigin);
    }

    const app = String(body.app || '');
    if (app !== 'task' && app !== 'consult') {
      return json({ ok: false, error: 'app은 task 또는 consult' }, 400, okOrigin);
    }

    try {
      return await handleCurriculum(env, app, body, okOrigin);
    } catch (error) {
      return json({ ok: false, error: String(error && error.message || error) }, 500, okOrigin);
    }
  }
};
