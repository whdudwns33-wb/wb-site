'use strict';
/* 자체 창작 예시만 기존 화면에 공급한다. 운영 인증·기록과 섞이지 않도록 세션은 메모리에만 둔다. */
var WBHARU_PREVIEW = (function () {
  var DAY = 86400000;
  var NOTICE = '본 앱은 WB 독해력학원이 제작한 사설 학습 도구이며, 호남삼육중학교와 어떠한 제휴·후원 관계도 없습니다. 전형 관련 공식 정보는 학교 홈페이지(samyook.jge.ms.kr)와 모집요강에서 확인하십시오. 2027학년도 모집요강(2026-04-24 공고) 기준 · 학교 사정에 따라 변경될 수 있음.';
  // 코어 목록의 이름만 재사용한다. 문항은 아래의 검토용 자체 창작 자료뿐이다.
  var ATOMS = [
    ['k-word-build', '단일어/합성어/파생어를 가르고 파생어 뜻을 부품으로 조립한다', 'kor', '중1 단어의 형성(합성어·파생어)'],
    ['k-poly', '동음이의어·다의어를 구별하고 문맥으로 뜻을 좁힌다', 'kor', '중1 어휘의 의미 관계·문맥 의미'],
    ['k-fig-id', '표현법을 식별한다 — 직유·은유·의인·대구·반복·설의·역설', 'kor', '중1 비유·상징·운율'],
    ['k-imagery', '시어의 함축적 의미를 문맥과 정서로 좁혀 고른다', 'kor', '중1 시의 화자와 정서'],
    ['k-dev-pattern', '글의 전개 방식에 이름을 붙인다 — 정의·예시·비교·대조·분류·인과·과정', 'kor', '중1 설명 방법(정의·예시·비교·대조·분류·인과)'],
    ['k-trap', '함정 선택지를 감별한다 — 부분참·단정어(모두·항상·반드시)·무관 진술', 'kor', '중등 국어 선택지 판별'],
    ['m-frac-div', '(분수)÷(자연수)·(자연수)÷(자연수)를 분수로 계산하고 단위량 문장제를 푼다', 'math', '중1 유리수의 나눗셈'],
    ['m-ratio-base', '비로 나타내고 기준량과 비교하는 양을 가른다 · 비율을 분수·소수·백분율로 표현한다', 'math', '중1 정비례·비례식'],
    ['m-pct-inverse', '비교하는 양과 비율로 기준량을 역산하고 연속 백분율(할인 후 할인)을 푼다', 'math', '중1 일차방정식의 활용(비율)'],
    ['m-unit-vol', '부피·넓이 단위를 환산한다 (1 m³ = 1,000,000 cm³)', 'math', '중1 입체도형 부피의 단위'],
    ['m-dec-remainder', '몫과 나머지를 구하고 나머지의 소수점 위치를 맞춘다', 'math', '중1 유리수 나눗셈·근삿값'],
    ['m-avg-inverse', '평균을 구하고 합계·빠진 값·평균 변화를 역산한다', 'math', '중1 통계 — 평균'],
    ['e-vocab-300', '핵심 300어를 양방향으로 인출한다 (뜻·철자·빈칸·정의) — 초등 권장 800어의 축', 'eng', '중1 필수 어휘 1,300'],
    ['e-3sg-past', 'be동사·일반동사 현재형을 주어에 맞추고(3인칭 단수 -s) 과거형을 만든다(규칙·불규칙 60)', 'eng', '중1 동사의 시제'],
    ['e-form-26', '밑줄 친 곳의 어법 오류를 찾는다 — 수 일치·시제·품사 자리·비교급·대명사 격', 'eng', '중1 어법(밑줄 오류 찾기)'],
    ['e-read-skip', '모르는 단어를 건너뛰고 문맥으로 뜻을 잡거나 몰라도 답을 낸다', 'eng', '중1 독해 문맥 추론']
  ].map(function (a) { return { id: a[0], label: a[1], subject: a[2], carryTo: a[3], teach: 'app' }; });
  var WATER = '수돗물은 강에서 곧바로 집으로 오지 않는다. 먼저 취수장이 강물을 끌어올린다. 그다음 정수장이 흙과 찌꺼기를 가라앉히고, 모래층으로 거른 뒤, 아주 적은 양의 소독약을 섞는다. 이렇게 깨끗해진 물은 언덕 위 배수지에 모였다가, 밤낮으로 관을 따라 각 집으로 내려간다. 배수지를 언덕 위에 두는 까닭은 따로 힘을 쓰지 않아도 물이 아래로 흐르기 때문이다. 그래서 정전이 되어도 한동안은 수도꼭지에서 물이 나온다.';
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function date(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }
  function item(atomId, no, question, choices, answer, explanation, setId) {
    return { no: no, atomId: atomId, form: 'mcq4', setId: setId || null, instructionKo: question,
      choices: choices.map(function (text, i) { return { key: String(i + 1), text: text }; }),
      answerKey: String(answer), explanationKo: explanation };
  }
  function pack(subject, atomId, rows, passages) {
    return { packId: 'haru-preview-' + subject, origin: 'own', source: 'WB 자체 창작 — 화면 검토용 예시', subject: subject,
      passages: passages || [], items: rows.map(function (q, i) { return item(atomId, i + 1, q[0], q[1], q[2], q[3], q[4]); }) };
  }
  // 수돗물 지문과 첫 문항은 저장소 pack-sample.json의 자체 창작 예시를 그대로 쓴다.
  var PACKS = [
    pack('kor', 'k-dev-pattern', [
      ['이 글의 전개 방식으로 가장 알맞은 것은?', ['두 대상의 차이를 견주어 설명한다', '일이 일어나는 순서대로 설명한다', '여러 종류로 나누어 설명한다', '원인과 결과를 밝혀 설명한다'], 2, '취수장 → 정수장 → 배수지 → 집의 차례로 물이 지나는 과정을 설명한다.', 'water'],
      ['물이 집에 도착하기 전 지나는 순서로 알맞은 것은?', ['배수지 → 정수장 → 취수장', '정수장 → 취수장 → 배수지', '취수장 → 정수장 → 배수지', '취수장 → 배수지 → 정수장'], 3, '먼저 강물을 끌어올리고, 정수장에서 깨끗하게 만든 뒤 배수지에 모은다.', 'water'],
      ['글의 순서를 나타내는 말끼리 묶인 것은?', ['먼저 · 그다음', '그러나 · 반면', '예를 들면 · 이를테면', '같지만 · 다르다'], 1, '먼저와 그다음은 일이 일어나는 차례를 알려 준다.', 'water'],
      ['이 글의 내용을 순서도로 나타낼 때 마지막에 놓을 것은?', ['강물을 끌어올린다', '집으로 내려간다', '모래층으로 거른다', '배수지에 모인다'], 2, '취수장과 정수장, 배수지를 지난 물은 마지막에 관을 따라 집으로 내려간다.', 'water']
    ], [{ id: 'water', titleKo: '물이 도시를 지나는 길', textKo: WATER }]),
    pack('math', 'm-frac-div', [
      ['물 3/4 L를 컵 3개에 똑같이 나누면 한 컵에 몇 L인가?', ['1/4 L', '9/4 L', '1/12 L', '3/4 L'], 1, '3/4 ÷ 3 = 3/12 = 1/4 L이다.'],
      ['리본 4/5 m를 2명에게 똑같이 나누면 한 사람은 몇 m를 받는가?', ['4/10 m', '8/5 m', '4/7 m', '2/10 m'], 1, '4/5 ÷ 2 = 4/10 m이다. 약분하면 2/5 m이다.'],
      ['주스 5/6 L를 컵 5개에 똑같이 나누면 한 컵에 몇 L인가?', ['5/30 L', '5/11 L', '25/6 L', '1/30 L'], 1, '5/6 ÷ 5 = 5/30 = 1/6 L이다.'],
      ['천 2/3 m를 4조각으로 똑같이 자르면 한 조각은 몇 m인가?', ['8/3 m', '2/7 m', '1/6 m', '1/12 m'], 3, '2/3 ÷ 4 = 2/12 = 1/6 m이다.']
    ]),
    pack('eng', 'e-vocab-300', [
      ['apple의 뜻으로 알맞은 것은?', ['연필', '사과', '의자', '창문'], 2, 'apple은 사과를 뜻한다.'],
      ['book의 뜻으로 알맞은 것은?', ['물', '모자', '책', '나무'], 3, 'book은 책을 뜻한다.'],
      ['water의 뜻으로 알맞은 것은?', ['물', '길', '문', '새'], 1, 'water는 물을 뜻한다.'],
      ['‘학교’에 해당하는 영어 낱말은?', ['river', 'garden', 'table', 'school'], 4, 'school은 학교를 뜻한다.']
    ])
  ];
  function create() {
    var now = Date.now(), today = date(now), at = new Date(now).toISOString();
    var state = { v: 2, days: {}, atoms: {}, seenPeri: {}, wrong: [], passages: [], words: {}, envelopeDone: {}, summary: {}, mocks: [], paper: [] };
    [1, 2].forEach(function (ago) { state.days[date(now - ago * DAY)] = { sat: true, min: 15, blocks: 1, items: 9 }; });
    [['k-dev-pattern', 1, 5, 4, 0], ['m-frac-div', 4, 3, 6, 4], ['e-vocab-300', 13, 1, 16, 16]].forEach(function (a) {
      state.atoms[a[0]] = { a: a[1], b: a[2], obs: a[3], ok: a[4], seen: {}, lastAt: now, medMs: 15000, ctx: ['mixed'],
        step: 0, due: now, streak: 0, wrong: 0, lapses: 0, relearnCount: 0, lastCriterionDate: null, lastCriterionAt: null,
        stage: 1, cue: 0, needsRecheck: false, reached: false, overconfident: 0 };
    });
    state.mocks.push({ at: new Date(now - 2 * DAY).toISOString(), completed: true, blank: 2 });
    var plan = { examDate: '2026-10-25', locked: false, retro: true, notice: NOTICE, dday: 19,
      phase: { phase: 'p4', dailyMin: 15, extendMax: 1, extendBlockMin: 15 },
      days: [{ d: today, kind: 'mock', app: true, keyId: 'haru-preview-sheet', subjects: ['kor'] }] };
    var td = { minEstimate: 15, slots: PACKS.map(function (p, i) {
      var atom = ATOMS.filter(function (a) { return a.id === p.items[0].atomId; })[0];
      return { atomId: atom.id, atomLabel: atom.label, kind: ['hole', 'shaky', 'probe'][i], label: ['다시 만날 칸', '굳히는 중', '처음 보는 칸'][i],
        why: '검토용 예시 문항으로 화면을 둘러봐요.', source: 'pack', packId: p.packId, mode: 'mixed', n: 3 };
    }) };
    function find(q, b) {
      var id = q.get('id') || b.packId, p = PACKS.filter(function (p) { return p.packId === id; })[0];
      if (!p) throw new Error('검토용 예시 팩이 없어요.');
      if (!b.no && !q.has('no')) return p;
      var it = p.items.filter(function (it) { return it.no === Number(b.no || q.get('no')); })[0];
      if (!it) throw new Error('검토용 예시 문항이 없어요.');
      return it;
    }
    function api(path, opt) {
      try {
        opt = opt || {};
        var bits = String(path).split('?'), route = bits[0], q = new URLSearchParams(bits[1] || ''), method = (opt.method || 'GET').toUpperCase();
        var b = opt.body ? JSON.parse(opt.body) : {};
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('올바른 예시 요청이 필요해요.');
        var out;
        if (route === '/plan' && method === 'GET') out = { plan: plan, updatedAt: at };
        else if (route === '/atoms' && method === 'GET') out = { atoms: ATOMS, core: ATOMS.map(function (a) { return a.id; }), updatedAt: at };
        else if (route === '/state' && method === 'GET') out = { state: state, updatedAt: at };
        else if (route === '/state' && method === 'PUT' && b.state && typeof b.state === 'object' && !Array.isArray(b.state)) { state = clone(b.state); out = { ok: true, updatedAt: at }; }
        else if (route === '/today' && method === 'GET') out = { today: td, dday: 19, updatedAt: at };
        else if (route === '/pack' && method === 'GET') {
          var clean = clone(find(q, b));
          clean.items.forEach(function (it) { delete it.answerKey; delete it.explanationKo; });
          out = { pack: clean, updatedAt: at };
        } else if (route === '/answer' && method === 'POST') {
          var it = find(q, b), picked = String(b.picked), ok = picked === it.answerKey;
          if (picked !== 'skip' && !it.choices.some(function (c) { return c.key === picked; })) throw new Error('예시 선택지를 골라 주세요.');
          out = { result: { ok: ok, answerKey: it.answerKey, explanationKo: it.explanationKo, cause: ok ? null : 'gap', item: { atomId: it.atomId, form: it.form, choices: it.choices }, cueNext: ok ? 0 : 1 } };
        } else if (route === '/probe' && method === 'POST') { find(q, b); out = { cause: 'gap', updatedAt: at }; }
        else if (route === '/cue' && method === 'GET') { find(q, { packId: q.get('packId'), no: q.get('no') }); out = { cue: { text: '문제의 조건을 한 번 더 읽어 봐요.' } }; }
        else if (route === '/retro' && method === 'GET') out = { retro: { sat: Object.keys(state.days || {}).filter(function (d) { return state.days[d].sat; }).length, totalDays: 82,
          carry: ['중1 필수 어휘 1,300'], numbersOpen: false, examDate: plan.examDate }, updatedAt: at };
        else if (route === '/sheet' && method === 'GET' && q.get('keyId') === 'haru-preview-sheet') out = { sheet: { keyId: 'haru-preview-sheet', label: '검토용 답안지', subject: 'kor', n: 5, timeLimitSec: 2400, origin: 'own', frozen: false, sets: null } };
        else if (route === '/attempt' && method === 'POST' && b.kind === 'single' && Array.isArray(b.periods) && b.periods.length === 1) out = { accepted: true, at: at };
        else throw new Error('이 기능은 예시 화면에서 제공하지 않아요.');
        return Promise.resolve(clone(out));
      } catch (e) { return Promise.reject(e); }
    }
    function parent() {
      return clone({ name: '검토용', today: { done: true, min: 15 }, week: { done: 3 }, lastMock: { completed: true, blank: 2 },
        dist: null, coach: '이번 주 3일 앉았습니다.', bedTarget: '23:45',
        milestones: [{ d: '2026-10-25', at: '08:30', text: '고사장 입실 마감' }, { d: '2026-11-02', at: null, text: '입학 등록 — 11/4 종료' }], notice: NOTICE });
    }
    return { api: api, parent: parent };
  }
  return { create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_PREVIEW;
