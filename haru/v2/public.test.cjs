'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const catalog = require('./catalog.js');
const data = require('./catalog.json');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
let count = 0;
async function test(name, fn) { await fn(); console.log('통과:', name); count++; }
(async () => {
  await test('입학연도·현재학년·출처 버전과 이전 확인 이력 보존', () => {
    catalog.validate(data);
    assert.equal(data.sources.find(s => s.id === 'gnue-2027-1007').checkedAt, '2026-10-07');
    const changes = [d => d.educationYear = 2028, d => d.sources[0].url = 'javascript:alert(1)', d => d.sources[0].checkedAt = '2026-10-12', d => d.sources[0].checkedAt = '2026-02-30', d => d.institutions[0].source = '없는 출처', d => d.courses[0].grades = [7], d => d.courses.push(d.courses[0]), d => d.events[0].end = '2026-10-01', d => d.admissions[0].year = 2026];
    for (const mutate of changes) { const copy = structuredClone(data); mutate(copy); assert.throws(() => catalog.validate(copy)); }
  });
  await test('한국시간 접수 시작·마감 경계와 미확정 마감 시각', () => {
    const event = data.events.find(e => e.institution === 'gnue' && e.kind === '원서');
    assert.equal(catalog.phase(event, Date.parse('2026-10-15T09:59:59+09:00')), '예정');
    assert.equal(catalog.phase(event, Date.parse('2026-10-15T10:00:00+09:00')), '기간 내');
    assert.equal(catalog.phase(event, Date.parse('2026-10-30T17:00:00+09:00')), '기간 내');
    assert.equal(catalog.phase(event, Date.parse('2026-10-30T17:00:01+09:00')), '마감');
    const day = data.events.find(e => e.institution === 'gice' && e.kind === '원서');
    assert.equal(catalog.phase(day, Date.parse('2026-10-26T20:00:00+09:00')), '기간 내 · 시각 확인');
    assert.equal(catalog.phase(day, Date.parse('2026-10-27T00:00:00+09:00')), '마감');
    assert.equal(catalog.phase({ start:'2026-10-25', end:'2026-10-25', kind:'시험' }, Date.parse('2026-10-25T12:00:00+09:00')), '기간 내 · 시각 확인');
    assert.equal(catalog.phase({ start:'2026-10-25', end:'2026-10-25', kind:'시험' }, Date.parse('2026-10-26T00:00:00+09:00')), '지난 일정');
  });
  await test('기관·분야별 필터는 지원 가능을 추정하지 않고 빈 결과를 복원', () => {
    assert.equal(data.courses.filter(c => catalog.matches(c, '6', '인문')).length, 0);
    assert.equal(data.courses.filter(c => catalog.matches(c, '1', '체육')).length, 1);
    const elements = {};
    for (const id of ['grade','field','reset','result-count','empty']) elements[id] = { value:'', textContent:'', hidden:true, handlers:{}, addEventListener(type,fn) { this.handlers[type] = fn; } };
    const rows = data.courses.map(c => ({ dataset:{ grades:c.grades.join(','), fields:c.fields.join('|') }, hidden:false }));
    vm.runInNewContext(read('public.js'), { window:{ HaruCatalog:catalog }, document:{ getElementById:id => elements[id], querySelectorAll:selector => selector === '[data-course]' ? rows : [] } });
    elements.grade.value = '6'; elements.field.value = '인문'; elements.grade.handlers.change();
    assert.ok(rows.every(row => row.hidden)); assert.equal(elements.empty.hidden, false);
    elements.reset.handlers.click(); assert.ok(rows.every(row => !row.hidden)); assert.equal(elements.empty.hidden, true);
  });
  await test('정적 본문·원문·독립 상담과 기존 학습실 경로가 JS 없이 존재', async () => {
    const { outputs } = await import(pathToFileURL(path.join(__dirname,'build.mjs')).href);
    for (const [file, expected] of Object.entries(outputs)) {
      const html = read(file); assert.equal(html, expected, '생성물을 다시 빌드하세요: ' + file);
      assert.match(html, /lang="ko"/); assert.match(html, /삼육중 및 영재원 대비/);
      for (const route of ['/haru/v2/samyook/', '/haru/v2/gwangju-gifted/', '/haru/', '/haru/v2/#other']) assert.ok(html.includes('href="' + route + '"'));
      assert.doesNotMatch(html, /<(?:form|iframe|object)\b|\bon\w+=|\/api\/|localStorage|sessionStorage|indexedDB|serviceWorker|fetch\s*\(/);
      for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const link = match[1].replace(/&amp;/g,'&');
        if (/^(https:|tel:|#)/.test(link)) continue;
        const root = path.resolve(__dirname,'../..');
        let target = link.startsWith('/') ? path.join(root,link.split(/[?#]/)[0]) : path.resolve(__dirname,path.dirname(file),link.split(/[?#]/)[0]);
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target,'index.html');
        assert.ok(fs.existsSync(target), file + ' 연결 누락: ' + link);
      }
      if (file !== 'index.html') {
        for (const id of ['grades','schedule','faq','consult']) assert.match(html,new RegExp('id="' + id + '"'));
        assert.match(html, /href="tel:062-672-7575"/); assert.match(html, /미공고/);
      }
    }
    const gifted = read('gwangju-gifted/index.html');
    assert.equal((gifted.match(/data-course=/g) || []).length, data.courses.length);
    assert.match(gifted, /교육청 계열/); assert.match(gifted, /대학부설/);
    assert.match(gifted, /최신 원문 수집 실패/); assert.match(gifted, /2026-10-06/);
    assert.match(gifted, /2026-10-11/); assert.match(gifted, /<noscript>/);
    assert.doesNotMatch(read('public.js'), /fetch\s*\(|localStorage|sessionStorage|serviceWorker|\/api\/|innerHTML/);
  });
  await test('기관마다 원서·추천·시험·등록이 연결되어 GED와 대학 자체 접수를 혼합하지 않음', () => {
    const gice = data.events.find(e => e.institution === 'gice' && e.kind === '원서');
    const gnue = data.events.find(e => e.institution === 'gnue' && e.kind === '원서');
    assert.equal(gice.start,'2026-10-19'); assert.equal(gnue.start,'2026-10-15T10:00');
    assert.ok(data.events.some(e => e.institution === 'gice' && e.kind === '학교추천'));
    assert.ok(data.events.some(e => e.institution === 'gnue' && e.kind === '교사추천 서류'));
    const admission = data.admissions.find(a => a.institution === 'gnue');
    assert.match(admission.restrictions,/자체 온라인/); assert.doesNotMatch(admission.documents,/GED/);
  });
  console.log('새 공개 안내:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
