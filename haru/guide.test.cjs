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
    self: { addEventListener: (name, fn) => { handlers[name] = fn; } },
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
      assert.equal(vm.runInContext('VERSION', context), file === 'sw.js' ? 'wbh-shell-dev' : 'wbr-shell-v6');
      assert.equal(vm.runInContext('SHELL.some(file => file.includes("guide"))', context), false);
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
        '/haru/guide?from=preview', '/haru/guide.html?from=parent#gift']) {
        for (const mode of ['navigate', 'cors']) assert.equal(request(route, { mode }), undefined, file + ': ' + route);
      }
      assert.deepEqual(calls, { fetch: [], match: [], put: [] });
    }
  });
  await t('비슷한 다른 경로·학생 홈의 네트워크와 오프라인 처리 계약은 유지', async () => {
    for (const file of workers) {
      const home = file === 'sw.js' ? '/haru/' : '/';
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
      if (file === 'sw.js') assert.equal(online.request('/haru/atoms.json'), undefined);
      assert.equal(online.calls.fetch.length, 6);
    }
  });
  console.log('준비 안내 회귀:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
