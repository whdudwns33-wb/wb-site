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
    const changes = [d => d.educationYear = 2028, d => d.sources[0].url = 'javascript:alert(1)', d => d.sources[0].checkedAt = '2026-10-13', d => d.sources[0].checkedAt = '2026-02-30', d => d.institutions[0].source = '없는 출처', d => d.courses[0].grades = [7], d => d.courses.push(d.courses[0]), d => d.events[0].end = '2026-10-01', d => d.admissions[0].year = 2026];
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
    assert.equal(data.courses.filter(c => catalog.matches(c, '1', '인문')).length, 0);
    assert.equal(data.courses.filter(c => catalog.matches(c, '1', '체육')).length, 1);
    const elements = {};
    for (const id of ['grade','field','reset','result-count','empty']) elements[id] = { value:'', textContent:'', hidden:true, handlers:{}, addEventListener(type,fn) { this.handlers[type] = fn; } };
    const rows = data.courses.map(c => ({ dataset:{ grades:c.grades.join(','), fields:c.fields.join('|') }, hidden:false }));
    vm.runInNewContext(read('public.js'), { window:{ HaruCatalog:catalog }, document:{ getElementById:id => elements[id], querySelectorAll:selector => selector === '[data-course]' ? rows : [] } });
    elements.grade.value = '1'; elements.field.value = '인문'; elements.grade.handlers.change();
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
    assert.match(gifted, /확인 필요/);
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
  await test('보조 기관의 출처·학년도·지역·일정과 공개 안내를 함께 검증', () => {
    for (const mutate of [d => d.directory[0].source = '없는 출처', d => d.directory[0].year = 2026, d => d.directory[0].region = '광주', d => d.directory.push(d.directory[0]), d => d.directory.find(i => i.events.length).events[0].end = '2026-01-01', d => d.sources.at(-1).url = 'https://ged.kedi.re.kr.evil.example/']) {
      const copy = structuredClone(data); mutate(copy); assert.throws(() => catalog.validate(copy));
    }
    const home = read('index.html'), gifted = read('gwangju-gifted/index.html');
    for (const entry of data.directory) assert.ok(home.includes('id="directory-' + entry.id + '"'));
    assert.match(home, /전남·전북 전체 기관 명부는 미완료/);
    for (const id of ['art','kiwoom','kaist-gwangju','jnu']) assert.ok(gifted.includes('id="' + id + '"'));
    assert.equal(data.courses.filter(c => ['kiwoom','kaist-gwangju','jnu'].includes(c.institution)).length, 0);
    assert.equal(data.events.filter(e => ['kiwoom','kaist-gwangju'].includes(e.institution)).length, 0);
    assert.match(data.admissions.find(a => a.institution === 'kaist-gwangju').restrictions, /상충/);
    const jb = data.directory.find(i => i.id === 'jb-ai');
    assert.equal(jb.events.find(e => e.kind === '원서').start, '2026-11-10T09:00');
    assert.ok(jb.events.filter(e => ['시험','면접'].includes(e.kind)).every(e => !e.end.includes('T')));
    assert.match(home, /시각 상충/); assert.match(gifted, /실제 개설·배정이 미정/);
    assert.equal(catalog.phase({kind:'설명회',start:'2026-10-17T14:00',end:'2026-10-17T14:00'}, catalog.instant('2026-10-18')), '지난 일정');
  });
  await test('대학부설 첨부의 전형별 자격·자체 접수·마감 조건을 분리', () => {
    const entry = id => data.directory.find(e => e.id === id);
    const general = entry('mokpo'), special = entry('mokpo-special');
    assert.notEqual(general.source, special.source);
    assert.equal(general.events.find(e => e.kind === '원서').end, '2026-11-10T18:00');
    assert.equal(special.events.find(e => e.kind === '원서').end, '2026-10-19T18:00');
    assert.match(general.limits, /지역 표기/);
    assert.match(special.target, /이수 요건/);
    assert.ok(!special.events.some(e => e.kind === '교사추천' || e.kind === '시험'));
    assert.match(entry('scnu').target, /전남 소재 학교/);
    assert.match(entry('scnu').limits, /마감일 도착/);
    assert.equal(entry('scnu').events.filter(e => e.kind === '원서').length, 2);
    assert.match(entry('jbnu').process, /GED 접수 인정하지 않음/);
    assert.match(entry('jbnu').limits, /우편 소인/);
    const deadline = entry('jbnu').events.find(e => e.kind === '원서');
    assert.equal(catalog.phase(deadline, catalog.instant('2026-11-06T18:00')), '기간 내');
    assert.equal(catalog.phase(deadline, catalog.instant('2026-11-06T18:01')), '마감');
    const observation = entry('scnu').events.find(e => e.kind === '관찰평가');
    assert.equal(catalog.phase(observation, catalog.instant('2026-12-21')), '지난 일정');
    for (const id of ['mokpo-2027-1011','scnu-2027-1011','jbnu-2027-1011']) assert.ok(data.sources.some(s => s.id === id));
    assert.match(read('index.html'), /전남광주통합특별시/);
  });
  await test('광주 첨부 보완과 GED 지역 공고는 미확인 자격·일정을 추정하지 않음', () => {
    const admission = id => data.admissions.find(a => a.institution === id);
    const aiRegistration = data.events.find(e => e.institution === 'ai' && e.kind === '등록');
    assert.equal(aiRegistration.start, '2026-12-24');
    assert.equal(aiRegistration.end, '2026-12-31');
    assert.equal(data.events.filter(e => e.institution === 'gice' && e.kind === '등록').length, 0);
    assert.match(admission('gice').restrictions, /최신 첨부에서 미확인/);
    assert.match(admission('ai').target, /1년 이상 이수/);
    assert.match(admission('art').assessment, /심화는 별도 시험 없이/);
    assert.ok(data.courses.filter(c => ['art-advanced','art-writing-advanced'].includes(c.id)).every(c => c.name.includes('본원 기초 수료예정자')));
    const artDates = data.events.filter(e => e.institution === 'art' && e.kind === '시험');
    assert.deepEqual(artDates.map(e => e.start), ['2026-12-12T09:00','2026-12-19T09:00']);
    assert.match(admission('kaist-gwangju').restrictions, /2027년 3월 예정/);
    const ged = data.sources.filter(s => /^ged-(jn|jb)-\d+-1011$/.test(s.id));
    assert.equal(ged.filter(s => s.id.startsWith('ged-jn-')).length, 4);
    assert.equal(ged.filter(s => s.id.startsWith('ged-jb-')).length, 17);
    for (const s of ged) {
      const url = new URL(s.url);
      assert.equal(url.searchParams.get('stndYear'), '2027');
      assert.ok(data.directory.some(i => i.source === s.id));
      assert.equal(s.status, '확인 필요');
    }
    const schoolClass = data.directory.find(i => i.id === 'jb-25747');
    assert.match(schoolClass.target, /익산가온초 현재 초4~5 재학생만/);
    const hw = data.directory.find(i => i.id === 'jb-25746');
    assert.equal(hw.kind, '학교 영재학급');
    assert.equal(hw.events[0].end, '2026-11-17T15:00');
    const jeonju = data.directory.find(i => i.id === 'jb-25849');
    assert.equal(jeonju.events[0].end, '2026-11-17T17:00');
    assert.match(data.directory.find(i => i.id === 'jn-25908').limits, /예술의 인접지역/);
    assert.match(data.directory.find(i => i.id === 'jn-ged').limits, /모든 운영기관 명부는 아님/);
    assert.equal(data.courses.length, 21);
  });
  await test('GED 밖 공식 요강과 설립 공지는 접수·학년·확인 범위를 구분', () => {
    const ks = data.directory.find(i => i.id === 'ksnu');
    assert.match(ks.process, /GED 접수 불인정/);
    assert.match(ks.target, /현재 전북 소재 학교 초5/);
    assert.match(ks.limits, /10\/13 우체국 소인/);
    assert.equal(ks.events.find(e => e.kind === '원서').end, '2026-10-13');
    assert.equal(ks.events.find(e => e.kind === '시험').start, '2026-10-17T14:00');
    const planned = data.directory.find(i => i.id === 'kentech');
    assert.deepEqual(planned.events, []);
    assert.match(planned.target, /미확인/);
    const security = data.directory.find(i => i.id === 'mokpo-security');
    assert.deepEqual(security.events, []);
    assert.equal(data.sources.find(s => s.id === security.source).status, '전년도 참고');
    assert.match(security.target, /2027.*확인 필요/);
    for (const id of ['mokpo-office', 'yeosu-office', 'naju-office']) {
      const entry = data.directory.find(i => i.id === id);
      assert.deepEqual(entry.events, []);
      assert.match(entry.target, /2027.*미확인/);
      assert.equal(data.sources.find(s => s.id === entry.source).status, '전년도 참고');
    }
    const je = data.directory.find(i => i.id === 'jeongeup');
    assert.match(je.target, /본원 초6 수료예정/);
    assert.equal(je.events.find(e => e.kind === '면접').end, '2026-12-05T14:00');
    const gim = data.directory.find(i => i.id === 'gimje');
    assert.match(gim.limits, /자동진급 6명을 제외한 9명/);
    assert.equal(gim.events.find(e => e.kind === '면접').end, '2026-12-05T13:30');
    const art = data.admissions.find(a => a.institution === 'art');
    assert.match(art.target, /미디어아트 중1~3.*문예창작 중1~2/);
    assert.doesNotMatch(art.restrictions, /학년 표 상충/);
    assert.ok(data.sources.some(s => s.id === 'gw-art-hwp-1011'));
    const fake = structuredClone(data);
    fake.sources.find(s => s.id === 'ksnu-2027-1012').url = 'https://kunsan.gidea.co.kr.evil.example/';
    assert.throws(() => catalog.validate(fake));
  });
  console.log('새 공개 안내:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
