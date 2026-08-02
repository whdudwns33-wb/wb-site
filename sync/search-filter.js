import baseWorker from './worker-core.js';

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Cache-Control': 'no-store'
  }
});

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function resolveAuth(env, app, auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.mode === 'admin') {
    const expected = app === 'task' ? env.TASK_ADMIN_SECRET : env.CONSULT_ADMIN_SECRET;
    return expected && safeEqual(auth.secret, expected) ? { scope: 'all' } : null;
  }
  if (auth.mode === 'person') {
    const id = String(auth.id || '');
    const token = String(auth.token || '');
    if (!id || !token) return null;
    const row = await env.DB.prepare(
      'SELECT staff_id FROM tokens WHERE app=? AND token=? AND revoked=0'
    ).bind(app, token).first();
    return row && row.staff_id === id ? { scope: 'own', id } : null;
  }
  return null;
}

const PLATFORM_RULES = {
  '엘리하이': {
    domain: 'mbest.co.kr',
    hostOk: host => host === 'junior.mbest.co.kr',
    course: [/\/lecture\/lecture_detail\/view_lecture\.asp/i, /\/lecture\/lecture\/view_lec_list\.asp/i],
    noise: [/\/examcenter\//i, /\/evt\//i, /category_list/i, /pub_event/i]
  },
  '엠베스트': {
    domain: 'mbest.co.kr',
    hostOk: host => host.endsWith('mbest.co.kr') && host !== 'junior.mbest.co.kr',
    course: [/\/lecture\/lecture_detail\/view_lecture\.asp/i, /\/lecture\/lecture\/view_lec_list\.asp/i],
    noise: [/pub_event/i, /teacherroom/i, /coursemap/i, /lecture14_list/i, /lecture_view_all/i, /hip_study/i, /n_jonghap/i]
  },
  '메가스터디': {
    domain: 'megastudy.net',
    hostOk: host => host.endsWith('megastudy.net'),
    course: [/\/teacher_v2\/chr\/lecture_detailview\.asp/i],
    noise: [/chrreview/i, /clean_after/i, /\/qna\//i, /t_promotion/i, /\/curriculum\//i, /teacher_main/i]
  },
  '이투스': {
    domain: 'etoos.com',
    hostOk: host => host.endsWith('etoos.com'),
    course: [/lecture[^/?]*(?:detail|view)/i, /(?:lecture_id|lec_id)=/i],
    noise: [/pop_evaluate/i, /evaluate/i, /review/i, /\/event\//i, /\/book\//i, /textbook/i]
  },
  '대성마이맥': {
    domain: 'mimacstudy.com',
    hostOk: host => host.endsWith('mimacstudy.com'),
    course: [/\/tcher\/lctr\/lctrdetail\.ds/i, /\/mobile\/tcher\/lctrhomemain\.ds/i],
    noise: [/getlctrreviewlist/i, /review/i, /notice/i, /eachtchermain/i, /\/ex\//i]
  },
  '기타': {
    domain: '',
    hostOk: () => true,
    course: [],
    noise: []
  }
};

const GLOBAL_COURSE_URL = /lecture_detailview|view_lecture|view_lec_list|lctrdetail|lctrhomemain|lecture[^/?]*(?:detail|view)|(?:chr_cd|gid|lecture_id|lec_id|pid)=/i;
const GLOBAL_NOISE_URL = /chrreview|clean_after|review|evaluate|\/qna\/|notice|event|promotion|t_promotion|\/book\/|textbook|teacher_main|curriculum|category_list|coursemap|examcenter/i;
const TITLE_NOISE = /후기|수강평|리뷰|교재|문제집|이벤트|프로모션|질문|Q&A|공지사항|입시설명회/i;
const TAG_RE = /<[^>]+>/g;

function unescapeHtml(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits) => String.fromCharCode(Number(digits)))
    .replace(/&amp;/g, '&');
}

function cleanText(value) {
  return unescapeHtml(String(value || '').replace(TAG_RE, '')).replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[Ⅰⅰ]/g, '1').replace(/[Ⅱⅱ]/g, '2').replace(/[Ⅲⅲ]/g, '3')
    .replace(/[Ⅳⅳ]/g, '4').replace(/[Ⅴⅴ]/g, '5')
    .replace(/[^0-9a-z가-힣]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(query) {
  const stop = new Set(['강좌', '강의', '인강', '과정', '수업']);
  return [...new Set(normalizeText(query).split(' ').filter(token => token.length >= 2 && !stop.has(token)))];
}

function tokenCoverage(title, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return 0;
  const normalizedTitle = normalizeText(title).replace(/\s+/g, '');
  const hits = tokens.filter(token => normalizedTitle.includes(token.replace(/\s+/g, ''))).length;
  return hits / tokens.length;
}

function candidateKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = new Map([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value.toLowerCase()]));
    for (const key of ['chr_cd', 'gid', 'lecture_id', 'lec_id', 'pid']) {
      if (params.get(key)) return url.hostname.toLowerCase() + ':' + key + ':' + params.get(key);
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|source$|partnerad$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().toLowerCase();
  } catch (error) {
    return String(rawUrl || '').toLowerCase();
  }
}

function scoreCandidate(item, query, platform, index) {
  const link = String(item.link || '');
  if (!/^https?:\/\//i.test(link)) return null;

  let parsed;
  try { parsed = new URL(link); } catch (error) { return null; }
  const host = parsed.hostname.toLowerCase();
  const rule = PLATFORM_RULES[platform] || PLATFORM_RULES['기타'];
  if (rule.domain && !host.endsWith(rule.domain)) return null;
  if (!rule.hostOk(host)) return null;

  const title = cleanText(item.title);
  const desc = cleanText(item.description).slice(0, 180);
  const urlText = parsed.pathname + parsed.search;
  if (GLOBAL_NOISE_URL.test(urlText) || rule.noise.some(pattern => pattern.test(urlText)) || TITLE_NOISE.test(title)) {
    return null;
  }

  const platformCourse = rule.course.some(pattern => pattern.test(urlText));
  const genericCourse = GLOBAL_COURSE_URL.test(urlText);
  const coverage = tokenCoverage(title, query);
  let score = platformCourse ? 140 : genericCourse ? 80 : 0;
  score += Math.round(coverage * 70);
  if (/강좌정보|강좌|수강|강의/i.test(title + ' ' + desc)) score += 12;
  if (normalizeText(title).includes(normalizeText(query).replace(/\s+/g, ''))) score += 25;

  const minimum = platform === '기타' ? 95 : 110;
  if (score < minimum || (!platformCourse && !genericCourse)) return null;
  return { title, url: link, desc: desc.slice(0, 120), score, coverage, index };
}

function selectCourseItems(rawItems, query, platform) {
  const unique = new Map();
  (rawItems || []).forEach((item, index) => {
    const candidate = scoreCandidate(item, query, platform, index);
    if (!candidate) return;
    const key = candidateKey(candidate.url);
    const previous = unique.get(key);
    if (!previous || candidate.score > previous.score) unique.set(key, candidate);
  });
  return [...unique.values()]
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.index - b.index)
    .slice(0, 5)
    .map(({ title, url, desc }) => ({ title, url, desc }));
}

async function handleApiHubSearch(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  if (!env.NAVER_ID || !env.NAVER_SECRET) {
    return json({ ok: false, error: '네이버 검색 키가 설정되지 않았습니다' }, 400, origin);
  }

  const q = String(body.q || '').trim();
  if (!q) return json({ ok: false, error: '검색어를 입력해 주세요' }, 400, origin);
  const platform = PLATFORM_RULES[body.platform] ? String(body.platform) : '기타';
  const query = (platform !== '기타' ? platform + ' ' : '') + q + ' 강좌';

  const response = await fetch(
    'https://naverapihub.apigw.ntruss.com/search/v1/webkr?display=50&query=' + encodeURIComponent(query),
    { headers: {
      'X-NCP-APIGW-API-KEY-ID': env.NAVER_ID,
      'X-NCP-APIGW-API-KEY': env.NAVER_SECRET
    } }
  );
  if (!response.ok) {
    return json({ ok: false, error: '네이버 검색 실패 (HTTP ' + response.status + ')' }, 502, origin);
  }

  const data = await response.json();
  return json({ ok: true, items: selectCourseItems(data.items, q, platform) }, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/search' || request.method !== 'POST') {
      return baseWorker.fetch(request, env, ctx);
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
      return await handleApiHubSearch(env, app, body, okOrigin);
    } catch (error) {
      return json({ ok: false, error: String(error && error.message || error) }, 500, okOrigin);
    }
  }
};
