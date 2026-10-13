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
    const changes = [d => d.educationYear = 2028, d => d.sources[0].url = 'javascript:alert(1)', d => d.sources[0].checkedAt = '2026-10-14', d => d.sources[0].checkedAt = '2026-02-30', d => d.institutions[0].source = '없는 출처', d => d.courses[0].grades = [7], d => d.courses.push(d.courses[0]), d => d.events[0].end = '2026-10-01', d => d.admissions[0].year = 2026];
    for (const mutate of changes) { const copy = structuredClone(data); mutate(copy); assert.throws(() => catalog.validate(copy)); }
  });
  await test('한국시간 접수 시작·마감 경계와 미확정 마감 시각', () => {
    const event = data.events.find(e => e.institution === 'gnue' && e.kind === '원서');
    assert.equal(catalog.phase(event, Date.parse('2026-10-15T09:59:59+09:00')), '예정');
    assert.equal(catalog.phase(event, Date.parse('2026-10-15T10:00:00+09:00')), '기간 내');
    assert.equal(catalog.phase(event, Date.parse('2026-10-30T17:00:00+09:00')), '기간 내');
    assert.equal(catalog.phase(event, Date.parse('2026-10-30T17:00:01+09:00')), '마감');
    assert.equal(catalog.phase({kind:'수험표 출력 시작',start:'2026-10-21T12:00',end:'2026-10-21T12:00'}, catalog.instant('2026-10-25')), '출력 시작 이후 · 종료일 확인');
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
    assert.match(gifted, /2026-10-13/); assert.match(gifted, /<noscript>/);
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
    assert.match(home, /2026 운영·2027 모집의 전수 확인은 미완료/);
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
      assert.ok(data.directory.some(i => i.source === s.id || i.source === s.id + '-conditions'));
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
    for (const id of ['jn-cyber', 'jb-cyber']) {
      const entry = data.directory.find(e => e.id === id);
      assert.deepEqual(entry.events, []);
      assert.match(entry.target, /2027.*미확인/);
      assert.equal(data.sources.find(s => s.id === entry.source).status, '전년도 참고');
    }
    for (const name of ['완산서초', '화정초']) assert.match(data.directory.find(e => e.name.includes(name)).limits, /폐지·미운영으로 확정하지 않음/);
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
      assert.equal(data.sources.find(s => s.id === entry.source).status, '확인 필요');
      assert.equal(data.sources.find(s => s.id === id + '-2026-1012').status, '전년도 참고');
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
  await test('등록 명부와 현 모집 자격·추천·증빙의 확인 범위를 혼용하지 않음', () => {
    const registered = data.sources.filter(s => s.id.startsWith('roster-') && s.id.endsWith('-2025-1012'));
    assert.equal(registered.length, 24);
    assert.equal(registered.filter(s => s.id.startsWith('roster-jn-')).length, 16);
    for (const source of registered) {
      assert.equal(new URL(source.url).searchParams.get('stndYear'), '2025');
      assert.equal(source.status, '전년도 참고');
    }
    assert.equal(data.directory.length, 68);
    assert.equal(data.courses.length, 21);
    for (const id of ['jn-cyber', 'jb-cyber']) {
      const entry = data.directory.find(e => e.id === id);
      assert.deepEqual(entry.events, []);
      assert.match(entry.target, /2027.*미확인/);
      assert.equal(data.sources.find(s => s.id === entry.source).status, '전년도 참고');
    }
    for (const name of ['완산서초', '화정초']) assert.match(data.directory.find(e => e.name.includes(name)).limits, /폐지·미운영으로 확정하지 않음/);
    const buan = data.directory.find(e => e.source === 'buan-2027-1012');
    assert.match(buan.target, /1년 이상 수료/);
    assert.match(buan.limits, /자기소개서.*1개월 이내/);
    assert.equal(buan.events[0].end, '2026-11-17T17:00');
    assert.match(data.directory.find(e => e.id === 'jn-25908').limits, /7일 이내.*학교 밖.*1개월 이내/);
    assert.match(data.directory.find(e => e.id === 'jb-25934').limits, /학습계획서 필수.*포트폴리오 선택/);
    assert.match(data.directory.find(e => e.id === 'jb-25746').limits, /GED 첨부파일/);
    assert.match(data.directory.find(e => e.id === 'jb-25747').limits, /담임에게/);
    assert.match(data.directory.find(e => e.id === 'jb-25963').limits, /포트폴리오 20매 이내/);
    for (const entry of data.directory.filter(e => e.source.startsWith('roster-'))) {
      assert.deepEqual(entry.events, []);
      assert.match(entry.target, /2027.*미확인/);
    }
  });
  await test('새 요강과 기관별 추천·증빙은 학교 자격·제출 경로·미확인 시각을 구분', () => {
    const entry = id => data.directory.find(e => e.id === id);
    const arts = entry('roster-jb-11212013001');
    assert.equal(arts.source, 'arts-high-2027-1012');
    assert.equal(arts.kind, '학교부설');
    assert.match(arts.target, /2027 교육연도.*중1~3/);
    assert.match(arts.process, /학교추천위원회 11\/23 17시.*오전 10시/);
    assert.match(arts.limits, /추천 대체.*미확인|추천 대체.*추가 확인/);
    assert.equal(arts.events[0].end, '2026-11-17T17:00');
    const school = entry('roster-jb-11212142002');
    assert.equal(school.kind, '학교 영재학급');
    assert.match(school.target, /백산중학교 중1~2 재학생만/);
    assert.match(school.limits, /12\/5 검사 당일 직접 제출.*1개월/);
    assert.equal(school.events[0].end, '2026-11-17');
    assert.ok(!school.events.some(e => e.kind === '등록' || e.kind === '개강'));
    const jangsu = entry('roster-jb-11212103001');
    assert.match(jangsu.process, /기관 추천심사.*GED 일괄/);
    assert.match(jangsu.limits, /서류 목록.*여전히 미확인/);
    assert.equal(jangsu.events.find(e => e.kind === '면접').end, '2026-12-05T12:50');
    assert.match(entry('gunsan').process, /학교.*15시.*공문.*17시/);
    assert.match(entry('jb-25970').process, /등기우편 도착분/);
    assert.match(entry('jb-25952').process, /사전 메일.*면접/);
    assert.match(entry('jb-25849').limits, /선발 요약.*전체 요강/);
    assert.match(entry('jb-25831').limits, /GED 첨부파일.*좁히지 않음/);
    assert.match(entry('jb-25919').limits, /2026 보유기간.*2027 선발/);
    const jangheung = entry('roster-jn-11313123001');
    assert.equal(jangheung.kind, '교육지원청 계열');
    assert.equal(jangheung.source, 'jangheung-2027-1012');
    assert.equal(jangheung.events[0].end, '2026-11-16');
    assert.equal(jangheung.events[1].end, '2026-11-23');
    assert.match(jangheung.events[1].note, /소속기관 없는 학교 밖.*연장/);
    assert.match(jangheung.limits, /1개월.*7일/);
    const jindo = entry('roster-jn-11313213001');
    assert.equal(jindo.kind, '교육지원청 계열');
    assert.match(jindo.target, /도내 전 지역.*학교 밖은 진도 거주/);
    assert.match(jindo.limits, /기악.*차이는 기관 재확인/);
    assert.equal(jindo.events[0].end, '2026-11-19');
    assert.match(jindo.events.find(e => e.kind === '면접').note, /성적우수 특별전형/);
    const lists = data.sources.filter(s => s.id.endsWith('-official-list-1012'));
    assert.equal(lists.length, 17);
    for (const source of lists) {
      const institution = data.directory.find(e => e.source === source.id);
      assert.equal(source.status, '확인 필요');
      assert.deepEqual(institution.events, []);
      assert.match(institution.limits, /첫 페이지.*미확인.*단정하지 않음/);
    }
    for (const id of ['jn-cyber', 'jb-cyber']) {
      assert.match(entry(id).limits, /13건.*2026.*IP영재기업인/);
      assert.deepEqual(entry(id).events, []);
    }
    for (const host of ['jhed.jge.go.kr.evil.example', 'junior.kaist.ac.kr.evil.example']) {
      const fake = structuredClone(data);
      fake.sources.find(s => s.id === 'jangheung-2027-1012').url = 'https://' + host + '/';
      assert.throws(() => catalog.validate(fake));
    }
    for (const id of ['gunsan', 'jb-art', 'jn-25978', 'jb-25849', 'jb-25945', 'jb-25810', 'jb-25952', 'jb-25970', 'jb-25911', 'jb-25857', 'jb-25919', 'jb-25831', 'jb-25930']) {
      const source = data.sources.find(s => s.id === entry(id).source);
      assert.equal(source.checkedAt, '2026-10-11');
      assert.match(source.note, /10\/12.*재대조/);
    }
  });
  await test('삼육 최신 안내는 전형별 추가 서류·평가·공식 시각을 구분하고 학습 정본을 바꾸지 않음', () => {
    const a = data.admissions.find(a => a.institution === 'samyook');
    assert.equal(a.tracks.length, 6);
    assert.match(a.assessment, /일반·국제·사회통합.*330.*SDAⅠ·SDAⅡ·삼육리더.*430/);
    assert.match(a.documents, /최근 한 달.*별도 종이 제출 없음/);
    assert.match(a.subjects.math, /초6 1학기까지 전 과정.*고학년.*다수/);
    const html = read('samyook/index.html');
    assert.match(html, /2026-11-04T16:30/);
    assert.match(html, /10\/15 우체국 소인.*도착 기준 아님/);
    assert.match(html, /출력 시작 시각만 공고.*종료일.*추정/);
    assert.doesNotMatch(html, /수험표[\s\S]*2026-11-02T16:00/);
    assert.match(html, /SDAⅠ·SDAⅡ·삼육리더 제출서류/);
    assert.match(html, /2028학년도 이후 요강은 미공고/);
    const invalid = structuredClone(data); invalid.admissions[0].tracks[0].documents = '';
    assert.throws(() => catalog.validate(invalid));
  });
  await test('광주 명부·추가 공지는 해당 대상과 출처가 연결되고 모든 로컬 앵커가 존재', async () => {
    const html = read('gwangju-gifted/index.html');
    assert.match(html, /5기관.*94학급/);
    assert.match(html, /2027 운영 승인 학교/);
    assert.match(html, /중등 주중2.*중3사사.*대상만/);
    assert.match(html, /10\/16까지 등록예정자.*담임교사에게 서면 제출/);
    const ai = html.slice(html.indexOf('id="ai"'), html.indexOf('id="gnue"'));
    assert.ok(ai.indexOf('2026-12-21') < ai.indexOf('2026-12-24'), '발표를 등록보다 먼저 안내');
    assert.match(html, /SW·AI.*초2~5.*교육 초3~6/);
    assert.match(html, /실제 추천서·학생 산출물·증빙자료.*요구하지 않습니다/);
    assert.match(html, /시간·횟수·수강료·담당·개설일은 모두 미정/);
    const invalid = structuredClone(data); invalid.institutions[0].notices = ['잘못된 출처'];
    assert.throws(() => catalog.validate(invalid));
    const { outputs } = await import(pathToFileURL(path.join(__dirname, 'build.mjs')).href);
    for (const [file, body] of Object.entries(outputs)) {
      for (const m of body.matchAll(/href="([^"#]*#[^"]+)"/g)) {
        const link = m[1]; if (link.startsWith('https:')) continue;
        const [route, id] = link.split('#');
        const root = path.resolve(__dirname, '../..');
        let target = route ? path.join(root, route) : path.join(__dirname, file);
        if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
        assert.ok(fs.readFileSync(target, 'utf8').includes('id="' + id + '"'), file + ' 앵커 누락: ' + link);
      }
    }
  });
  console.log('새 공개 안내:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
