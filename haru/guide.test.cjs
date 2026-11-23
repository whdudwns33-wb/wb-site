'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const guide = read('guide.html'), student = read('index.html'), parent = read('parent.html');
const build = read('../reading-server/build-dist.mjs');
const workers = ['sw.js', '../reading/sw.js'];
const facts = require('./facts.json');
let count = 0;
async function t(name, fn) { await fn(); count++; console.log('통과:', name); }

function serviceWorker(file = 'sw.js', offline = false) {
  const handlers = {}, calls = { fetch: [], match: [], put: [] };
  const context = vm.createContext({ URL, location: { origin: 'https://example.test' },
    // reading/sw.js 는 자기 경로로 ROOT 를 잡는다 — location 이 없으면 평가 자체가 안 된다.
    self: { location: { href: 'https://example.test/sw.js' },
      addEventListener: (name, fn) => { handlers[name] = fn; } },
    fetch: async request => {
      calls.fetch.push(request.url);
      if (offline) throw new Error('오프라인');
      return { from: 'network', clone: () => ({ from: 'network' }) };
    },
    caches: {
      open: async () => ({ put: (key, response) => { calls.put.push([key, response.from]); } }),
      match: async key => { calls.match.push(key); return { from: 'cache' }; },
    },
  });
  vm.runInContext(read(file), context);
  const request = (route, options = {}) => {
    let response;
    handlers.fetch({ request: { url: new URL(route, 'https://example.test').href, method: 'GET', mode: 'navigate', ...options },
      respondWith: promise => { response = promise; } });
    return response;
  };
  return { request, calls, context };
}

(async () => {
  await t('준비 안내는 스크립트·폼·학생 API·저장소 없이 읽는 한국어 문서', () => {
    assert.match(guide, /<html\b[^>]*lang="ko"/);
    assert.match(guide, /name="referrer" content="no-referrer"/);
    assert.match(guide, /name="robots" content="noindex, nofollow"/);
    assert.doesNotMatch(guide, /<(?:script|form|iframe|object)\b|\bon\w+\s*=/i);
    assert.doesNotMatch(guide, /\/api\/|localStorage|sessionStorage|indexedDB|serviceWorker|fetch\s*\(/);
  });
  await t('코드 입력 전·샘플·보호자에서 토큰 없는 동일 안내 링크를 제공', () => {
    const link = student.slice(student.indexOf('function showLink('), student.indexOf('function showPending('));
    assert.ok(link.indexOf('href="./guide.html"') >= 0);
    assert.ok(link.indexOf('href="./guide.html"') < link.indexOf('<form'));
    const preview = student.slice(student.indexOf('<aside class="preview"'), student.indexOf('<main'));
    assert.match(preview, /href="\.\/guide\.html"/);
    assert.match(parent.slice(0, parent.indexOf('<main')), /href="\.\/guide\.html"/);
    assert.doesNotMatch(student + parent, /href="\.\/guide\.html\?/);
    const home = student.slice(student.indexOf('function showHome('), student.indexOf('function startRunner('));
    assert.doesNotMatch(home, /guide\.html/);
  });
  await t('배포 복사·참조 검사에 포함하고 오프라인 셸에는 넣지 않음', () => {
    assert.match(build, /const HARU_FILES = \[[^\]]*'guide\.html'/);
    assert.match(build, /'haru\/guide\.html'/);
    for (const file of workers) {
      const { context } = serviceWorker(file);
      // VERSION 은 build-dist.mjs 가 내용 해시로 스탬프한다 — 값을 통째로 적어 두면 배포마다 깨진다.
      // 어느 앱의 워커를 평가했는지만 접두사로 확인한다.
      const prefix = file === 'sw.js' ? 'wbh-shell-' : 'wbr-shell-';
      assert.ok(String(vm.runInContext('VERSION', context)).startsWith(prefix), file + ' 를 평가하지 못했다');
      // 캐시 목록의 이름이 앱마다 다르다(haru: SHELL · reading: KEEP). 있는 쪽을 집어 guide 가 없음을 본다.
      const shell = vm.runInContext('typeof SHELL !== "undefined" ? SHELL : KEEP', context);
      assert.equal(shell.some(name => String(name).includes('guide')), false, file + ' 오프라인 셸에 guide 가 들어갔다');
    }
  });
  await t('2027학년도 주요 일정은 facts.json 정본과 같음', () => {
    const dates = [...guide.matchAll(/<time\b[^>]*datetime="([^"]+)"/g)].map(match => match[1]);
    for (const expected of [...facts.schedule.apply, ...facts.schedule.docs, facts.exam.date,
      facts.schedule.announce[0], ...facts.schedule.enroll]) {
      assert.ok(dates.some(actual => actual.startsWith(expected)), '정본 일정 누락: ' + expected);
    }
  });
  await t('초4 과정은 목차·상단·학년 안내에서 연결되고 두 선택안의 4주·시간·대안을 유지', () => {
    const course = guide.match(/<section\b[^>]*id="course"[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.ok(course, '초4 과정 본문 누락');
    const contents = guide.slice(guide.indexOf('<aside'), guide.indexOf('</aside>'));
    const intro = guide.slice(guide.indexOf('<main'), guide.indexOf('<section'));
    const grade4 = guide.match(/<details\b[^>]*id="grade4"[^>]*>[\s\S]*?<\/details>/)?.[0];
    for (const entry of [contents, intro, grade4]) assert.match(entry || '', /href="#course"/);
    for (const route of ['a', 'b']) {
      assert.match(course, new RegExp('href="#course-' + route + '"'));
      assert.match(course, new RegExp('<h3\\b[^>]*id="course-' + route + '"'));
    }
    const weeks = [...course.matchAll(/<details\b[^>]*id="course-([ab])([1-4])"[^>]*>[\s\S]*?<\/details>/g)];
    assert.equal((course.match(/<details\b/g) || []).length, 8);
    assert.deepEqual(weeks.map(match => match[1] + match[2]).sort(), ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4']);
    for (const [html, , week] of weeks) {
      assert.match(html, new RegExp('<summary>\\s*<h4>' + week + '주'));
      for (const label of ['목표', '교사가 볼 것', '다음 지원']) assert.ok(html.includes(label), label + ' 누락');
    }
    const text = course.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    for (const contract of [/두 경로는 별도 선택안/, /주 최대 50분/, /주 최대 40분/,
      /기존 평일 10분 학습을 대체/, /추가 숙제가 아닙니다/, /평일 카드·종이 회차를 추가하지 않는/,
      /자료는 교사가/, /보호자가 새 문제·해설을 만들지/, /피곤하면 5분 이하/,
      /빠진 활동은 몰아서 하지/, /배우지 않았다면 배운 자연수·실물·표현으로 바꾸고 둘 다 하지/,
      /실제 개설·배정·시행 시점은 미확정/, /앱의 영재원 학습 기능 제공을 뜻하지/]) assert.match(text, contract);
    assert.doesNotMatch(course, /<(?:input|textarea|select|button)\b/i);
  });
  await t('안내 주소·확장자·후행 슬래시·쿼리에서 SW 캐시와 홈 폴백을 모두 우회', () => {
    for (const file of workers) {
      const { request, calls } = serviceWorker(file, true);
      for (const route of ['/haru/guide', '/haru/guide/', '/haru/guide.html', '/haru/guide.html/',
        '/haru/guide?from=preview', '/haru/guide.html?from=parent#gift', '/haru/v2', '/haru/v2/',
        '/haru/v2/samyook/', '/haru/v2/gwangju-gifted/?from=home', '/haru/v2/style.css', '/haru/v2/public.js', '/haru/v2/catalog.json']) {
        for (const mode of ['navigate', 'cors']) assert.equal(request(route, { mode }), undefined, file + ': ' + route);
      }
      assert.deepEqual(calls, { fetch: [], match: [], put: [] });
    }
  });
  await t('하루브레인 워커: 탐색은 망으로, 끊기면 캐시한 셸로 답한다', async () => {
    const file = 'sw.js', home = '/haru/';
    const online = serviceWorker(file);
    for (const route of [home, '/haru/parent.html', '/haru/guidebook', '/haru/guide.js', '/haru/guide/extra', '/haru/guide.html/extra']) {
      assert.equal((await online.request(route)).from, 'network');
    }
    assert.equal(online.calls.fetch.length, 6);
    assert.deepEqual(online.calls.put, Array.from({ length: 6 }, () => ['./index.html', 'network']));
    const offline = serviceWorker(file, true);
    assert.equal((await offline.request(home)).from, 'cache');
    assert.deepEqual(offline.calls.match, ['./index.html']);
    for (const [route, options] of [['/api/haru/today', {}],
      [home, { method: 'POST' }], ['https://school.test/haru/', {}]]) {
      assert.equal(online.request(route, options), undefined);
    }
    assert.equal(online.request('/haru/atoms.json'), undefined);
    assert.equal(online.calls.fetch.length, 6);
  });
  /* 진로독서 워커의 계약은 2026-11-21 설치 앱 전환으로 달라졌다 — 탐색 응답을 캐시에
     넣지 않고, 자기 뿌리의 지정된 화면만 가로채 망이 끊기면 오프라인 화면으로 답한다.
     하루브레인과 한 틀에 묶어 두면 형제 앱이 바뀔 때마다 이 파일이 깨지므로 따로 적는다.
     여기서 지키려는 것은 하나다 — guide 와 API·POST·외부 주소는 워커가 건드리지 않는다. */
  await t('진로독서 워커: 자기 뿌리의 화면만 가로채고 guide·API·외부 주소는 지나보낸다', async () => {
    const file = '../reading/sw.js';
    const online = serviceWorker(file);
    assert.equal((await online.request('/')).from, 'network');
    for (const route of ['/haru/parent.html', '/haru/guidebook', '/haru/guide.js', '/haru/guide/extra', '/haru/guide.html/extra']) {
      assert.equal(online.request(route), undefined, file + ': ' + route);
    }
    assert.equal(online.calls.fetch.length, 1);
    assert.deepEqual(online.calls.put, []);
    const offline = serviceWorker(file, true);
    assert.equal((await offline.request('/')).from, 'cache');
    assert.deepEqual(offline.calls.match, ['/offline/']);
    for (const [route, options] of [['/api/haru/today', {}],
      ['/', { method: 'POST' }], ['https://school.test/haru/', {}]]) {
      assert.equal(online.request(route, options), undefined);
    }
    assert.equal(online.calls.fetch.length, 1);
  });
  console.log('준비 안내 회귀:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
