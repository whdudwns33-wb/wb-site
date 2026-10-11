import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from './catalog.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const data = catalog.validate(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')));
const facts = JSON.parse(fs.readFileSync(path.join(dir, '..', 'facts.json'), 'utf8'));
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const base = '/haru/v2/';
const navItems = [['samyook/', '호남삼육중 준비'], ['gwangju-gifted/', '광주 영재교육원 준비'], ['#other', '다른 학교·지역'], ['/haru/', '학습실 입장']];
const nav = current => navItems.map(([url,label]) => `<a href="${url.startsWith('/haru/') ? url : base + url}"${current === url ? ' aria-current="page"' : ''}>${label}</a>`).join('');
function page(title, current, body) {
  const assets = current ? '../' : './';
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — 삼육중 및 영재원 대비</title><meta name="description" content="광주 학부모를 위한 호남삼육중 준비와 광주 영재교육원 기관별 지원·준비 안내">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<link rel="icon" href="${assets}../icon.svg" type="image/svg+xml"><link rel="stylesheet" href="${assets}style.css">
<script defer src="${assets}catalog.js"></script><script defer src="${assets}public.js"></script></head>
<body><a class="skip" href="#main">본문으로 건너뛰기</a><header class="brand"><div class="brand-inner"><a class="brand-name" href="${base}">삼육중 및 영재원 대비</a><nav aria-label="주 메뉴">${nav(current)}</nav></div></header>
<main id="main">${body}</main><footer><p>WB 독해력학원의 사설 준비 안내입니다. 학교·영재교육기관과 제휴·후원 관계가 없습니다.</p><p>공식 정보와 WB 준비 제안을 구분합니다. 합격 가능성이나 영재 판정을 제공하지 않습니다. 지원·추천·등록은 가족과 학교가 공식 경로에서 확인합니다.</p><a href="/haru/guide.html">기존 전체 준비 안내</a> · <a href="/haru/parent.html?preview=1">보호자 화면 예시</a></footer></body></html>
`;
}
function source(id) {
  const s = data.sources.find(row => row.id === id);
  return `<p class="status">${esc(s.status)} · 마지막 원문 확인 ${s.checkedAt}${s.retrieval === '수집 실패' ? ' · 최신 원문 수집 실패' : ''}</p><p class="small">${esc(s.note)}</p><a href="${esc(s.url)}" rel="noreferrer">${esc(s.label)} 원문 확인</a>`;
}
function schedule(events) {
  if (!events.length) return '<p class="status">공개할 상세 일정은 확인 필요입니다. 다른 기관의 접수·검사일을 적용하지 말고 해당 원문을 확인하세요.</p>';
  const now = catalog.instant(data.referenceDate);
  return `<p class="small">한국시간 기준. JS를 사용할 수 없으면 ${data.referenceDate} 기준 상태를 표시합니다. 날짜만 있는 기한은 당일 마감 시각을 별도 확인하세요.</p><ol class="timeline">${events.map(e => `<li data-start="${e.start}" data-end="${e.end}" data-kind="${esc(e.kind)}"><div><strong>${esc(e.kind)}</strong><span class="phase">${catalog.phase(e, now)}</span></div><div><time datetime="${e.start}">${e.start.replace('T',' ')}</time>${e.start === e.end ? '' : ' ~ <time datetime="' + e.end + '">' + e.end.replace('T',' ') + '</time>'}<p class="small">${esc(e.note)}</p></div></li>`).join('')}</ol>`;
}
function consultation(tag) {
  return `<section id="consult"><h2>${tag} 상담</h2><p>현재 학년, 관심 과정, 학교 진도와 확보 가능한 시간을 먼저 알려 주세요. 실제 수업 개설·담당·배부 방식은 상담 후 별도 결정합니다.</p><a class="action" href="tel:${data.contact.phone}" data-interest="${tag}">WB 전화 상담 · ${data.contact.phone}</a><p class="small">기존 홈페이지의 공개 전화 채널입니다. 이 화면에서는 신청이나 학생 정보를 저장하지 않습니다. 전화에서 관심 분야를 말씀해 주세요.</p><div class="tags" aria-label="상담 관심 분야">${data.contact.tags.map(t => `<a href="tel:${data.contact.phone}" data-interest="${t}">${t} 문의</a>`).join('')}</div></section>`;
}
const faq = rows => `<section id="faq"><h2>자주 묻는 질문</h2>${rows.map(([q,a]) => `<details><summary>${q}</summary><div><p>${a}</p></div></details>`).join('')}</section>`;
const contents = items => `<nav class="contents" aria-label="이 페이지 목차">${items.map(([id,label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>`;
const intro = (title, lead) => `<h1>${title}</h1><p class="small">2026년 현재 학년 → 2027학년도 입학·교육</p><p class="lead">${lead}</p>`;
const directory = data.directory.map(i => `<details id="directory-${esc(i.id)}"><summary>${esc(i.name)} · ${esc(i.region)}</summary><div><p class="small">${esc(i.kind)} · ${i.year}학년도</p><dl><dt>대상·자격</dt><dd>${esc(i.target)}</dd><dt>절차·일정</dt><dd>${esc(i.process)}</dd><dt>제한·확인</dt><dd>${esc(i.limits)}</dd></dl>${source(i.source)}${i.events.length ? schedule(i.events) : ''}</div></details>`).join('');

const home = page('준비 안내', '', `<h1>아이의 목표에 맞게,<br>준비의 순서부터.</h1><p class="lead">광주 학부모를 위한 지원 정보와 준비 과정입니다. 학교 입학과 영재교육은 목적·자격·선발 방식이 달라 각각 안내합니다.</p>
<div class="paths"><section class="path"><h2>호남삼육중 준비</h2><p>현재 시험 마무리와 다음 학년도 준비. 교과 기초, 실전 연습, 지원 일정.</p><a class="action" href="${base}samyook/">삼육중 준비 보기</a></section><section class="path"><h2>광주 영재교육원 준비</h2><p>현재 학년과 관심 분야로 기관을 탐색하고, 기관별 추천·접수 절차를 확인합니다.</p><a class="action" href="${base}gwangju-gifted/">영재교육 준비 보기</a></section></div>
<aside class="note"><p><strong>이미 학습 중인가요?</strong> 기존 학생 코드와 강사 승인 방식으로 입장합니다. 두 목표를 준비해도 새 계정이나 중복 숙제를 만들지 않습니다.</p><a href="/haru/">학습실 입장</a> · <a href="/haru/?preview=1">저장하지 않는 학생 샘플 보기</a></aside>
<section id="other"><h2>다른 학교·지역</h2><p>학교와 기관을 펼쳐 공식 원문·확인 범위·다음 절차를 확인하세요. 전남·전북 전체 기관 명부는 미완료이며, 현재 안내하는 기관이 지역 전체를 뜻하지 않습니다.</p><p class="small">2026-10-11 GED의 2027학년도 전체 기관 유형 조회: 전남 등록 공고 4건·전북 17건. 연결된 기관별 첨부를 요약했으며 GED 밖 기관과 새 공고는 추가 확인이 필요합니다.</p><p class="small">대학·지원청 자체 공고도 함께 안내합니다. 자체 홈페이지에 공고가 있어도 접수는 GED를 쓰는 기관이 있습니다. 설립 공지·전년도 자료는 2027 모집 일정과 구분합니다.</p><p class="small">본문 확인과 첨부 요강 전문 검수는 구분합니다. 현재 초등 학년과 중학교·고등학교 입학 자격을 혼용하지 않습니다.</p>${directory}<a href="/haru/guide.html#gift">기존 광주·전남 안내와 확인 범위 보기</a></section>
<section><h2>원문과 준비 제안의 경계</h2><p>모집 일정·지원 자격은 기관의 공식 요강이 기준입니다. WB의 독서·탐구·교과 활동은 준비 제안이며 공식 필수 과제가 아닙니다. 미확인 정보로 지원 가능 여부를 확정하지 않습니다.</p><p class="small">자료 기준 ${data.referenceDate}. 마지막 원문 확인일은 각 기관에 별도로 표시합니다.</p></section>`);

const samyookEvents = [
  { kind:'원서', start:facts.schedule.apply[0], end:facts.schedule.apply[1], note:'온라인 접수. 마감 이후 신규 접수 가능 여부를 추정하지 않음' },
  { kind:'서류', start:facts.schedule.docs[0], end:facts.schedule.docs[1], note:'방문 마감 시각과 우편 소인 기준을 전형별로 구분하여 원문 확인' },
  { kind:'수험표', start:facts.schedule.ticket[0], end:facts.schedule.ticket[1], note:'출력 시작. 고사장·수험생 안내 확인' },
  { kind:'시험', start:facts.exam.date, end:facts.exam.date, note:'08:30까지 입실. 국어 09:00·수학 10:00·영어 11:00, 특별전형 추가 평가 별도 확인' },
  { kind:'발표', start:facts.schedule.announce[0], end:facts.schedule.announce[0], note:'학교 공식 발표 확인' },
  { kind:'등록', start:facts.schedule.enroll[0], end:facts.schedule.enroll[1], note:'합격자 대상. 정확한 등록 시각과 서류는 학교 공지 확인' }
];
const sAdmission = data.admissions.find(a => a.institution === 'samyook');
const samyook = page('호남삼육중 준비', 'samyook/', intro('호남삼육중 준비', '호남삼육중학교 입학을 위한 지원 정보와 학년별 준비 순서입니다. 현재 초6의 시험 마무리와 초3~5의 장기 준비를 나누어 봅니다.') + contents([['start','처음 준비하기'],['grades','학년별 준비'],['subjects','교과·실전'],['schedule','올해 일정'],['faq','질문'],['consult','상담']]) + `
<section id="start"><h2>처음 준비하기</h2><div class="columns"><div><h3>2027학년도 · 현재 초6</h3><p>자료 기준일에는 원서접수가 마감되었습니다. 접수한 가족은 서류 → 수험표 → 시험 순서로 확인하세요. 접수 누락을 학습실 이용으로 해결할 수는 없습니다.</p></div><div><h3>다음 모집 · 현재 초3~5</h3><p><strong>2028학년도 이후 요강은 미공고입니다.</strong> 올해 날짜를 다음 학년도 일정으로 옮기지 않습니다. 학교 진도와 현재 수준부터 확인해 준비 분량을 정합니다.</p></div></div><h3>공식 요구사항 · ${sAdmission.year}학년도</h3><dl><dt>지원 대상</dt><dd>${esc(sAdmission.target)}</dd><dt>평가</dt><dd>${esc(sAdmission.assessment)}</dd><dt>서류</dt><dd>${esc(sAdmission.documents)}</dd><dt>제한·확인</dt><dd>${esc(sAdmission.restrictions)}</dd></dl>${source('samyook-2027-v1.2')}</section>
<section id="grades"><h2>현재 학년별 준비</h2><p class="small">WB 준비 제안 · 공식 과제 아님</p>${[
['초3','짧은 글에서 근거 찾기, 배운 계산을 말로 설명하기, 쉬운 영어 문장 읽기. 학교 진도 안에서 시작합니다.'],
['초4','교과 기초와 생각 기록은 별도 선택안입니다. 기존 활동을 대체할 시간과 담당 교사를 정한 뒤 검토합니다. <a href="/haru/guide.html#course">초4 A/B 4주 수업안 보기</a> · 실제 개설·배정·시행은 미정입니다.'],
['초5','배운 개념의 빈 곳을 확인하고 글·풀이의 근거를 설명합니다. 시간 제한 연습을 조금씩 늘리되 새 단원 선행을 일괄 강제하지 않습니다.'],
['초6','접수·서류를 먼저 확인하고 틀린 이유를 짚습니다. 시험 시간과 답안지 연습, 수면·준비물 점검을 우선하며 분량을 무리하게 늘리지 않습니다.']
].map(([g,text]) => `<details><summary>${g} 준비 순서</summary><div><p>${text}</p></div></details>`).join('')}</section>
<section id="subjects"><h2>국어·수학·영어와 실전 연습</h2><p class="status">공식 범위의 마지막 확인값 · 최신 원문 재확인 필요</p><dl><dt>국어</dt><dd>${esc(facts.range.kor)}</dd><dt>수학</dt><dd>${esc(facts.range.math)}</dd><dt>영어</dt><dd>${esc(facts.range.eng)}</dd></dl><h3>WB 준비 제안</h3><p>국어는 지문의 근거, 수학은 식을 세운 이유, 영어는 문장의 뜻을 먼저 확인합니다. 이미 배운 내용의 재학습 뒤 시간 제한·답안지 옮겨 쓰기를 연습합니다.</p><p>기존 16칸 숙달 현황과 OMR은 삼육중 과정의 학습 도구입니다. 다른 학교·영재교육 전체의 공통 준비점수로 사용하지 않습니다.</p><a class="action" href="/haru/?preview=1">학습·답안지 샘플 검토</a></section>
<section id="schedule"><h2>올해 지원부터 등록까지</h2><p class="status">2027학년도 입학 · 일정은 2026년에 진행 · 마지막 공식 확인 2026-10-06, 최신 변경 확인 필요</p>${schedule(samyookEvents)}</section>` + faq([
['영재교육도 같은 시험을 준비하나요?','영재교육은 기관별 추천·분야별 평가가 다릅니다. <a href="' + base + 'gwangju-gifted/">광주 영재교육 안내</a>에서 별도로 확인하세요.'],
['앱에서 원서 접수나 서류 제출을 하나요?','접수·추천·등록은 공식 경로에서 가족과 학교가 진행합니다. 앱은 접수 완료를 판정하거나 대행하지 않습니다.'],
['웩슬러 검사가 필수인가요?','앱 준비 과정에 웩슬러 검사를 필수로 두지 않습니다. 공식 기관의 요구사항과 학원의 준비 제안을 구분하세요.']
]) + consultation('삼육중'));

const courseRows = data.courses.map(c => {
  const institution = data.institutions.find(i => i.id === c.institution);
  const s = data.sources.find(s => s.id === institution.source);
  return `<li data-course="${esc(c.id)}" data-grades="${c.grades.join(',')}" data-fields="${esc(c.fields.join('|'))}"><strong>${esc(c.name)}</strong><p>${esc(institution.name)} · ${institution.kind}</p><p>현재(2026) 초${c.grades.join('·')} → 교육(2027) ${c.nextGrades}</p><span class="status">${s.status} · 원문 확인 ${s.checkedAt}</span> · <a href="#${institution.id}">자격·서류·일정 확인</a></li>`;
}).join('');
const institutionSections = data.institutions.filter(i => i.id !== 'samyook').map(i => {
  const a = data.admissions.find(a => a.institution === i.id);
  return `<article class="institution" id="${i.id}"><h3>${esc(i.name)}</h3><p class="small">${esc(i.kind)} · ${a.year}학년도 · ${esc(a.name)}</p><dl><dt>학년·자격</dt><dd>${esc(a.target)}</dd><dt>지역 조건</dt><dd>${esc(i.region)}</dd><dt>선발 방식</dt><dd>${esc(a.assessment)}</dd><dt>제출서류</dt><dd>${esc(a.documents)}</dd><dt>제한·확인</dt><dd>${esc(a.restrictions)}</dd></dl>${source(i.source)}<h3>기관별 올해 일정</h3>${schedule(data.events.filter(e => e.institution === i.id))}</article>`;
}).join('');
const gifted = page('광주 영재교육원 준비', 'gwangju-gifted/', intro('광주 영재교육원 준비', '한 기관을 준비하는 안내가 아닙니다. 현재 학년과 관심 분야로 과정 후보를 찾고, 기관마다 다른 자격·추천·접수 방식을 확인하세요.') + contents([['find','기관·과정 찾기'],['grades','학년별 활동'],['schedule','자격·올해 일정'],['faq','질문'],['consult','상담']]) + `
<aside class="note"><p><strong>기관 소재지와 지원 자격은 다릅니다.</strong> 목록에 나타나도 지원이 가능하다는 뜻은 아닙니다. 지역·재학 조건과 해당 과정의 최신 요강을 확인하세요.</p><p>교육청 계열은 GED와 학교 추천을, 대학부설은 자체 접수와 별도 추천 서류를 확인합니다.</p></aside>
<section id="find"><h2>현재 학년에서 확인할 과정</h2><p>2026년 현재 초등 학년으로 탐색합니다. 광주 전체 기관의 전수 명부와 중학생 과정은 검토 중입니다.</p><div class="filters"><div><label for="grade">현재 초등 학년</label><select id="grade"><option value="">전체 학년</option>${[1,2,3,4,5,6].map(g => `<option value="${g}">초${g}</option>`).join('')}</select></div><div><label for="field">관심 분야</label><select id="field"><option value="">전체 분야</option>${[...new Set(data.courses.flatMap(c => c.fields))].map(f => `<option>${f}</option>`).join('')}</select></div><button id="reset" type="button">전체 다시 보기</button></div><p id="result-count" class="small" role="status" aria-live="polite">${data.courses.length}개 과정 후보 · 지원 가능 판정이 아닙니다</p><div id="empty" class="note" hidden>현재 검토한 목록에 일치하는 과정이 없습니다. 전체 다시 보기로 돌아가거나 기관 원문을 확인하세요. 지원할 곳이 없다는 판정은 아닙니다.</div><noscript><p>필터를 사용할 수 없어 전체 목록을 표시합니다. 현재 학년과 기관별 조건을 직접 대조하세요.</p></noscript><ul class="course-list">${courseRows}</ul><p class="small">키움영재학급·KAIST 광주사이버영재교육원·전남대학교는 아래 기관 안내에 있습니다. 2027 지원 학년이나 세부 자격이 미확인인 과정은 필터에 넣지 않았습니다. 누락을 기관 미운영으로 해석하지 마세요.</p><a href="/haru/guide.html#gift">기존 기관별 안내와 조사 범위</a></section>
<section id="grades"><h2>학년별 독서·탐구·생각 설명</h2><p class="small">WB 준비 제안 · 공식 필수 제출물 아님</p>${[
['초1~2','관찰한 것을 말과 그림으로 표현합니다. 좋아하는 책을 짧게 읽고 궁금한 점 하나를 나눕니다. 기관별 모집 학년은 별도로 확인합니다.'],
['초3~4','질문을 하나 정하고 관찰 방법을 생각합니다. 책의 근거를 찾아 설명하고, 처음 예상과 달랐던 점을 말합니다.'],
['초5~6','질문 → 방법 → 자료·관찰 → 어려움 → 수정 → 성찰 순서로 생각을 정리합니다. 독서는 선택 이유·읽은 범위·근거·질문과 대화를 연결합니다.']
].map(([g,text]) => `<details><summary>${g} 활동 제안</summary><div><p>${text}</p></div></details>`).join('')}<p class="small">교과·독서·탐구를 매일 하나씩 강제하지 않습니다. 권수나 정답률만으로 성취를 판정하지 않으며 기록을 자동 자기소개서로 바꾸지 않습니다. <a href="/haru/guide.html#course">초4 생각 기록 B 검토안</a>은 실제 개설·배정이 미정입니다.</p></section>
<section id="schedule"><h2>기관별 지원 자격과 올해 일정</h2><p>2027학년도 교육을 위한 2026년 가을 지원입니다. 기관별 원문·확인일과 제한을 함께 읽어 주세요.</p>${institutionSections}</section>` + faq([
['GED에 지원하면 교사 추천도 끝나나요?','지원 뒤 추천 교사에게 알리고 학교 안내에 따라 전달·추천 완료 여부를 확인해야 합니다. 대학부설의 교사 추천서 제출은 별도 절차입니다.'],
['두 기관의 일정이 같나요?','각 기관의 원서·추천·평가·등록을 별도로 확인합니다. GED 일정이나 검사일을 대학부설에 적용하지 않습니다.'],
['문제 풀이만 하면 준비가 되나요?','관찰·질문·근거 설명과 분야별 활동을 함께 검토합니다. 삼육중 교과 문제와 16칸을 영재교육 전체 준비로 복제하지 않습니다.'],
['2028학년도에도 같은 날짜인가요?','2028학년도 이후 요강은 미공고입니다. 올해 날짜나 지원 학년을 다음 모집에 그대로 적용하지 않습니다.'],
['영재교육 학습 기능과 수업이 이미 운영 중인가요?','이 화면은 지원 안내와 수업 검토 자료입니다. 영재교육 학습 MVP·담당·수업 운영값은 별도 결정이 필요하며 실제 운영을 뜻하지 않습니다.']
]) + consultation('광주 영재교육'));

export const outputs = { 'index.html':home, 'samyook/index.html':samyook, 'gwangju-gifted/index.html':gifted };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, html] of Object.entries(outputs)) {
    fs.mkdirSync(path.dirname(path.join(dir,file)), { recursive:true });
    fs.writeFileSync(path.join(dir,file),html);
  }
  console.log('공개 안내 3개 생성 · 학생 기록/API 변경 없음');
}
