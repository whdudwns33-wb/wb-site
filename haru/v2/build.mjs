import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from './catalog.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const data = catalog.validate(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')));
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const base = '/haru/v2/';
const navItems = [['samyook/', '호남삼육중 준비'], ['gwangju-gifted/', '광주 영재교육원 준비'], ['middle-schools/', '화산·영선·용정중 준비'], ['#other', '다른 학교·지역'], ['/haru/', '학습실 입장']];
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
  return `<section id="consult"><h2>${tag} 상담</h2><p>현재 학년, 관심 과정, 학교 진도와 확보 가능한 시간을 먼저 알려 주세요. WB 수업 시간·횟수·수강료·담당·개설일·배부 방식은 모두 미정입니다.</p><a class="action" href="tel:${data.contact.phone}" data-interest="${tag}">WB 전화 상담 · ${data.contact.phone}</a><p class="small">기존 홈페이지의 공개 전화 채널입니다. 이 화면에서는 신청이나 학생 정보를 저장하지 않습니다. 전화에서 관심 분야를 말씀해 주세요.</p><div class="tags" aria-label="상담 관심 분야">${data.contact.tags.map(t => `<a href="tel:${data.contact.phone}" data-interest="${t}">${t} 문의</a>`).join('')}</div></section>`;
}
const faq = rows => `<section id="faq"><h2>자주 묻는 질문</h2>${rows.map(([q,a]) => `<details><summary>${q}</summary><div><p>${a}</p></div></details>`).join('')}</section>`;
const contents = items => `<nav class="contents" aria-label="이 페이지 목차">${items.map(([id,label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>`;
const intro = (title, lead) => `<h1>${title}</h1><p class="small">2026년 현재 학년 → 2027학년도 입학·교육</p><p class="lead">${lead}</p>`;
const directory = data.directory.map(i => `<details id="directory-${esc(i.id)}"><summary>${esc(i.name)} · ${esc(i.region)}</summary><div><p class="small">${esc(i.kind)} · ${i.year}학년도</p><dl><dt>대상·자격</dt><dd>${esc(i.target)}</dd><dt>절차·일정</dt><dd>${esc(i.process)}</dd><dt>제한·확인</dt><dd>${esc(i.limits)}</dd></dl>${source(i.source)}${data.schoolGuides.some(s=>s.id===i.id) ? '<p><a href="/haru/v2/middle-schools/#'+esc(i.id)+'">학교별 준비 안내 보기</a></p>' : ''}${i.events.length ? schedule(i.events) : ''}</div></details>`).join('');

const home = page('준비 안내', '', `<h1>아이의 목표에 맞게,<br>준비의 순서부터.</h1><p class="lead">광주 학부모를 위한 지원 정보와 준비 과정입니다. 학교 입학과 영재교육은 목적·자격·선발 방식이 달라 각각 안내합니다.</p>
<div class="paths"><section class="path"><h2>호남삼육중 준비</h2><p>올해 전형 확인과 다음 학년도 준비. 교과 기초, 실전 연습, 지원 일정.</p><a class="action" href="${base}samyook/">삼육중 준비 보기</a></section><section class="path"><h2>광주 영재교육원 준비</h2><p>현재 학년과 관심 분야로 기관을 탐색하고, 기관별 추천·접수 절차를 확인합니다.</p><a class="action" href="${base}gwangju-gifted/">영재교육 준비 보기</a></section></div>
<section class="path"><h2>화산·영선·용정중 준비</h2><p>추첨·면접·서류·체력평가의 차이와 학교별 자격·서류·일정을 확인하세요.</p><a class="action" href="${base}middle-schools/">세 학교 준비 비교</a></section>
<aside class="note"><p><strong>이미 학습 중인가요?</strong> 기존 학생 코드와 강사 승인 방식으로 입장합니다. 두 목표를 준비해도 새 계정이나 중복 숙제를 만들지 않습니다.</p><a href="/haru/">학습실 입장</a> · <a href="/haru/?preview=1">저장하지 않는 학생 샘플 보기</a></aside>
<section id="other"><h2>다른 학교·지역</h2><p>학교와 기관을 펼쳐 공식 원문·확인 범위·다음 절차를 확인하세요. 2026 운영·2027 모집의 전수 확인은 미완료이며, 현재 안내하는 항목이 지역 전체의 모집기관을 뜻하지 않습니다.</p><p class="small">2026-10-12 GED의 2027학년도 전체 기관 유형 재조회: 전남 등록 공고 5건·전북 18건. 자체 공고와 연결 첨부도 함께 안내합니다. 미확인 기관의 요강·추천·증빙 전수 검수는 계속 진행 중입니다.</p><p class="small">대학·지원청 자체 공고도 함께 안내합니다. 자체 홈페이지에 공고가 있어도 접수는 GED를 쓰는 기관이 있습니다. 설립 공지·전년도 자료는 2027 모집 일정과 구분합니다.</p><p class="small">2025 GED 기관알리미 등록 명부 전남 26개·전북 30개를 전 페이지 대조해 누락 안내 24개를 보완했습니다. 등록정보가 현재 모집을 보장하지는 않습니다.</p><p class="small">2026 교육청 계획의 전남 24원·전북 27기관 표도 대조해 사이버영재교육원 2곳을 추가했습니다. 교육청 계획 표의 범위이며 대학부설 등 지역 전체 운영기관을 뜻하지 않습니다. 전년도 대상 학년을 2027 지원 학년으로 적용하지 않습니다.</p><p class="small">본문 확인과 첨부 요강 전문 검수는 구분합니다. 현재 초등 학년과 중학교·고등학교 입학 자격을 혼용하지 않습니다.</p>${directory}<a href="/haru/guide.html#gift">기존 광주·전남 안내와 확인 범위 보기</a></section>
<section><h2>원문과 준비 제안의 경계</h2><p>모집 일정·지원 자격은 기관의 공식 요강이 기준입니다. WB의 독서·탐구·교과 활동은 준비 제안이며 공식 필수 과제가 아닙니다. 미확인 정보로 지원 가능 여부를 확정하지 않습니다.</p><p class="small">자료 기준 ${data.referenceDate}. 세 중학교 안내는 10/27 보완했으며 다른 기관까지 재검수했다는 뜻은 아닙니다. 마지막 원문 확인일은 각 기관에 별도로 표시합니다.</p></section>`);

const samyookEvents = [
  { kind:'원서', start:'2026-10-06T09:00', end:'2026-10-09T17:00', note:'학교 홈페이지 배너를 통한 인터넷 원서접수·전형료 결제. 마감 후 접수 가능을 추정하지 않음' },
  { kind:'서류', start:'2026-10-13T09:00', end:'2026-10-15T17:00', note:'학교 1층 입학서류접수처 방문 또는 등기우편. 우편은 10/15 우체국 소인까지 유효(도착 기준 아님)' },
  { kind:'수험표 출력 시작', start:'2026-10-21T12:00', end:'2026-10-21T12:00', note:'출력 시작 시각만 공고. 종료일은 명시되지 않아 추정하지 않음. 본인 출력·지참 필수' },
  { kind:'시험', start:'2026-10-25T08:30', end:'2026-10-25T12:20', note:'08:30까지 입실. 국어 09:00~09:40, 수학 10:00~10:40, 영어 11:00~11:40. SDAⅠ·SDAⅡ·삼육리더만 성경 12:00~12:20, 일반·국제·사회통합은 3교시 후 귀가' },
  { kind:'발표', start:'2026-10-30T16:00', end:'2026-10-30T16:00', note:'학교 홈페이지 개별 확인. 발표 시작 시각이며 조회 종료일 미공고' },
  { kind:'등록', start:'2026-11-02T09:00', end:'2026-11-04T16:30', note:'합격자 대상 학교 행정실, 각 날짜 접수시간 09:00~16:30. 입학금 추후 공지' }
];
const sAdmission = data.admissions.find(a => a.institution === 'samyook');
const sInstitution = data.institutions.find(i => i.id === 'samyook');
const notices = i => (i.notices || []).map(id => `<details><summary>${esc(data.sources.find(s => s.id === id).label)}</summary><div>${source(id)}</div></details>`).join('');
const samyook = page('호남삼육중 준비', 'samyook/', intro('호남삼육중 준비', '호남삼육중학교 입학을 위한 지원 정보와 학년별 준비 순서입니다. 현재 초6의 시험 마무리와 초3~5의 장기 준비를 나누어 봅니다.') + contents([['start','처음 준비하기'],['grades','학년별 준비'],['subjects','교과·실전'],['schedule','올해 일정'],['faq','질문'],['consult','상담']]) + `
<section id="start"><h2>처음 준비하기</h2><div class="columns"><div><h3>2027학년도 · 현재 초6</h3><p>자료 기준일에는 원서접수가 마감되었습니다. 접수한 가족은 서류 → 수험표 → 시험 순서로 확인하세요. 접수 누락을 학습실 이용으로 해결할 수는 없습니다.</p></div><div><h3>다음 모집 · 현재 초3~5</h3><p><strong>2028학년도 이후 요강은 미공고입니다.</strong> 올해 날짜를 다음 학년도 일정으로 옮기지 않습니다. 학교 진도와 현재 수준부터 확인해 준비 분량을 정합니다. 올해 요강은 2028 SDAⅠ 연속 6년 출석 등 향후 조건을 예고하지만, 다음 정식 요강·모집일정은 별도로 확인해야 합니다.</p></div></div><h3>공식 요구사항 · ${sAdmission.year}학년도</h3><dl><dt>지원 대상</dt><dd>${esc(sAdmission.target)}</dd><dt>평가</dt><dd>${esc(sAdmission.assessment)}</dd><dt>서류</dt><dd>${esc(sAdmission.documents)}</dd><dt>제한·확인</dt><dd>${esc(sAdmission.restrictions)}</dd></dl>${sAdmission.tracks.map(t => `<details><summary>${esc(t.name)}</summary><div><dl><dt>지원 자격</dt><dd>${esc(t.target)}</dd><dt>추가 서류</dt><dd>${esc(t.documents)}</dd></dl></div></details>`).join('')}${source(sInstitution.source)}${notices(sInstitution)}</section>
<section id="grades"><h2>현재 학년별 준비</h2><p class="small">WB 준비 제안 · 공식 과제 아님</p>${[
['초3','짧은 글에서 근거 찾기, 배운 계산을 말로 설명하기, 쉬운 영어 문장 읽기. 학교 진도 안에서 시작합니다.'],
['초4','교과 기초와 생각 기록은 별도 선택안입니다. 기존 활동을 대체할 시간과 담당 교사를 정한 뒤 검토합니다. <a href="/haru/guide.html#course">초4 A/B 4주 수업안 보기</a> · 실제 개설·배정·시행은 미정입니다.'],
['초5','배운 개념의 빈 곳을 확인하고 글·풀이의 근거를 설명합니다. 시간 제한 연습을 조금씩 늘리되 새 단원 선행을 일괄 강제하지 않습니다.'],
['초6','접수·서류를 먼저 확인하고 틀린 이유를 짚습니다. 시험 시간과 답안지 연습, 수면·준비물 점검을 우선하며 분량을 무리하게 늘리지 않습니다.']
].map(([g,text]) => `<details><summary>${g} 준비 순서</summary><div><p>${text}</p></div></details>`).join('')}</section>
<section id="subjects"><h2>국어·수학·영어와 실전 연습</h2><p class="status">2027학년도 공식 범위 · 2026-10-13 원문 검수</p><dl><dt>국어</dt><dd>${esc(sAdmission.subjects.kor)}</dd><dt>수학</dt><dd>${esc(sAdmission.subjects.math)}</dd><dt>영어</dt><dd>${esc(sAdmission.subjects.eng)}</dd><dt>성경</dt><dd>${esc(sAdmission.subjects.bible)}</dd></dl>${source(sInstitution.source)}<h3>WB 준비 제안</h3><p>국어는 지문의 근거, 수학은 식을 세운 이유, 영어는 문장의 뜻을 먼저 확인합니다. 이미 배운 내용의 재학습 뒤 시간 제한·답안지 옮겨 쓰기를 연습합니다.</p><p>기존 16칸 숙달 현황과 OMR은 삼육중 과정의 학습 도구입니다. 다른 학교·영재교육 전체의 공통 준비점수로 사용하지 않습니다.</p><a class="action" href="/haru/?preview=1">학습·답안지 샘플 검토</a></section>
<section id="schedule"><h2>올해 지원부터 등록까지</h2><p class="status">2027학년도 입학 · 일정은 2026년에 진행 · 공식 확인 2026-10-13 · 미공고 시각·종료일 추정 없음</p>${schedule(samyookEvents)}${source(sInstitution.source)}</section>` + faq([
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
  return `<article class="institution" id="${i.id}"><h3>${esc(i.name)}</h3><p class="small">${esc(i.kind)} · ${a.year}학년도 · ${esc(a.name)}</p><dl><dt>학년·자격</dt><dd>${esc(a.target)}</dd><dt>지역 조건</dt><dd>${esc(i.region)}</dd><dt>선발 방식</dt><dd>${esc(a.assessment)}</dd><dt>제출서류</dt><dd>${esc(a.documents)}</dd><dt>제한·확인</dt><dd>${esc(a.restrictions)}</dd></dl>${source(i.source)}${notices(i)}<h3>기관별 올해 일정</h3>${schedule(data.events.filter(e => e.institution === i.id).sort((a,b) => catalog.instant(a.start) - catalog.instant(b.start)))}</article>`;
}).join('');
const gifted = page('광주 영재교육원 준비', 'gwangju-gifted/', intro('광주 영재교육원 준비', '한 기관을 준비하는 안내가 아닙니다. 현재 학년과 관심 분야로 과정 후보를 찾고, 기관마다 다른 자격·추천·접수 방식을 확인하세요.') + contents([['find','기관·과정 찾기'],['grades','학년별 활동'],['roster','명부·미확인'],['schedule','자격·올해 일정'],['faq','질문'],['consult','상담']]) + `
<aside class="note"><p><strong>기관 소재지와 지원 자격은 다릅니다.</strong> 목록에 나타나도 지원이 가능하다는 뜻은 아닙니다. 지역·재학 조건과 해당 과정의 최신 요강을 확인하세요.</p><p>교육청 계열은 GED와 학교 추천을, 대학부설은 자체 접수와 별도 추천 서류를 확인합니다.</p></aside>
<section id="find"><h2>현재 학년에서 확인할 과정</h2><p>2026년 현재 초등 학년으로 탐색합니다. 아래 명부에서 공식 대조 범위와 초등 필터에 표시되지 않는 과정을 함께 확인하세요.</p><div class="filters"><div><label for="grade">현재 초등 학년</label><select id="grade"><option value="">전체 학년</option>${[1,2,3,4,5,6].map(g => `<option value="${g}">초${g}</option>`).join('')}</select></div><div><label for="field">관심 분야</label><select id="field"><option value="">전체 분야</option>${[...new Set(data.courses.flatMap(c => c.fields))].map(f => `<option>${f}</option>`).join('')}</select></div><button id="reset" type="button">전체 다시 보기</button></div><p id="result-count" class="small" role="status" aria-live="polite">${data.courses.length}개 과정 후보 · 지원 가능 판정이 아닙니다</p><div id="empty" class="note" hidden>현재 검토한 목록에 일치하는 과정이 없습니다. 전체 다시 보기로 돌아가거나 기관 원문을 확인하세요. 지원할 곳이 없다는 판정은 아닙니다.</div><noscript><p>필터를 사용할 수 없어 전체 목록을 표시합니다. 현재 학년과 기관별 조건을 직접 대조하세요.</p></noscript><ul class="course-list">${courseRows}</ul><p class="small">키움영재학급·KAIST 광주사이버영재교육원·전남대학교는 아래 기관 안내에 있습니다. 2027 지원 학년이나 세부 자격이 미확인인 과정은 필터에 넣지 않았습니다. 누락을 기관 미운영으로 해석하지 마세요.</p><a href="/haru/guide.html#gift">기존 기관별 안내와 조사 범위</a></section>
<section id="roster"><h2>공식 명부 대조와 미확인 과정</h2><p>2027 교육청 공통 첨부의 5기관(94학급)은 아래 기관 상세에 모두 연결했습니다. 학급 수와 필터의 과정 후보 수는 다릅니다. 전남대는 대학부설로 별도 확인했고, 키움은 단위학교별 명부를 아직 확인하지 못했습니다.</p><ul>${data.institutions.filter(i => i.id !== 'samyook').map(i => `<li><a href="#${i.id}">${esc(i.name)}</a> · ${esc(i.kind)}</li>`).join('')}</ul>${source('gw-common-1013')}<details><summary>초등 필터 밖 과정과 확인이 남은 항목</summary><div><ul><li>창의융합: 중등 수학·과학·융합·발명, 중3 수학·과학 사사·진급 특별전형은 기관 상세와 해당 요강에서 확인합니다. 초등 필터는 현재 초6의 중1 후보만 표시합니다. 거점별 학교 배정과 중등 특별 자격의 개별 적용은 기관 확인이 필요합니다.</li><li>AI정보: 중등 AI·피지컬 AI·앱개발과 중등 AI사사. 사사 이수 조건·면접을 초등 과정에 적용하지 않습니다.</li><li>예술: 중등 문예창작·미디어아트 기초/심화. 심화는 본원 기초 수료예정 조건이며 중등 과정 전수는 초등 필터에 넣지 않았습니다. 등록 세부는 추후 안내입니다.</li><li>광주교대: 20학급의 수학·과학·로봇·SW·AI·인문·미술·체조를 분야/지원 학년별 후보로 묶었습니다. 로봇·SW·AI 단계는 기관이 평가 후 정합니다. 지역 제한, 과정별 시험시간·준비물 및 소개 ZIP 전문은 미확인입니다.</li><li>전남대: 2027 세부 과정·지원 학년·지역·추천·증빙·평가·접수·등록은 10/15 공지 예정 요강을 확인해야 합니다. 현재 2026 메뉴로 대신하지 않습니다.</li><li>키움: 2027 승인 운영학교·분야·학년·학교별 절차 명부 미확인. 학교에 운영 공지를 확인하며 미운영으로 단정하지 않습니다.</li><li>KAIST 광주사이버: 2027 확정 요강·지원 학년·추천·접수 미확인. 교육청 HTML 2026/3과 KAIST 첨부 2027/3 예정이 상충하며 IP영재기업인 모집은 다른 전형입니다.</li></ul><p>교육청 공고에 포함되지 않은 기관·학교 영재학급의 2027 전수 명부는 미완료입니다. 명부 누락을 미운영이나 지원 불가로 해석하지 마세요.</p></div></details><p class="small">안내는 필요한 서류·전달 경로만 설명합니다. 실제 추천서·학생 산출물·증빙자료를 앱이나 WB에 제출하도록 요구하지 않습니다. WB 수업 시간·횟수·수강료·담당·개설일은 모두 미정입니다.</p></section>
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

const schoolArticles = data.schoolGuides.map(s => `<article class="institution" id="${s.id}"><h2>${esc(s.name)}</h2><p class="small">${esc(s.region)} · ${s.year}학년도 · 공식 원문 확인 2026-10-27</p><p class="lead">${esc(s.summary)}</p><aside class="note"><p>${esc(s.current)}</p></aside>
<h3>공식 지원 요건</h3><dl><dt>지원 자격</dt><dd>${esc(s.target)}</dd><dt>모집 인원</dt><dd>${esc(s.quota)}</dd><dt>선발·평가</dt><dd>${esc(s.assessment)}</dd><dt>교과 범위</dt><dd>${esc(s.curriculum)}</dd><dt>접수 방법</dt><dd>${esc(s.application)}</dd><dt>공통 서류</dt><dd>${esc(s.documents)}</dd><dt>주의사항</dt><dd>${esc(s.restrictions)}</dd></dl>
<h3>전형별 자격·추천·증빙</h3>${s.tracks.map(t=>`<details><summary>${esc(t.name)}</summary><div><p>${esc(t.target)}</p><p>${esc(t.documents)}</p></div></details>`).join('')}
<h3>공식 일정 · 2027학년도</h3>${schedule(s.events)}${source(s.source)}
<details><summary>정정·추가 안내와 확인 범위</summary><div>${s.notices.map(source).join('')}</div></details>
<h3>등록·예비소집과 추가 확인</h3>${s.followup.map(step=>`<section><h4>${esc(step.title)}</h4><p>${esc(step.text)}</p>${source(step.source)}</section>`).join('')}
<h3>WB 준비 제안 · 공식 필수 과제 아님</h3><ul>${s.preparation.map(p=>`<li>${esc(p)}</li>`).join('')}</ul><h3>추가로 확인할 것</h3><p class="status">${esc(s.unknown)}</p>
<a href="#consult">${esc(s.name)} 준비 상담 방법</a></article>`).join('');
const middleSchools = page('화산·영선·용정중 준비','middle-schools/',intro('화산·영선·용정중 준비','학교마다 지원 자격·선발 방식·서류가 다릅니다. 2027학년도 공식 요강과 추가 공지를 대조하고, 다음 학년도 준비 활동을 구분합니다.')+contents([['hs','화산중'],['ys','영선중'],['yj','용정중'],['grades','학년별 준비'],['schedule','올해·다음 모집'],['faq','질문'],['consult','상담']])+`
<aside class="note"><p><strong>지금 원서를 새로 접수하는 화면이 아닙니다.</strong> 세 학교 모두 올해 정규 접수가 끝났습니다. 발표·등록·후보 충원은 기존 지원자의 절차입니다.</p><p>다음 학년도 자격·날짜는 올해 값으로 채우지 않습니다. 서류 제출과 개인 결과 확인은 가족이 학교 공식 경로에서 진행합니다.</p></aside>
<section id="schedule"><h2>올해 모집과 다음 학년도 준비</h2><p>2027학년도 입학 전형은 2026년에 진행됩니다. 아래 요강상 일정과 원문을 함께 보세요. 2028학년도 요강·일정은 이번 공식 확인 범위에서 미확인입니다. 미공고 날짜를 올해 일정으로 추정하지 않습니다.</p><p>화산·영선은 전북 내 학교장전형 이중지원 금지와 예외를, 용정은 전남 내 중복지원 제한을 각각 확인합니다. 세 학교에 모두 지원할 수 있다고 일괄 판정하지 않습니다.</p></section>
${schoolArticles}
<section id="grades"><h2>학년별 WB 준비 제안</h2><p>아래는 학교의 공식 지원 요건이나 제출 과제가 아닙니다. 해당 학년의 평소 배움과 실제 경험을 바탕으로 준비합니다.</p><dl><dt>현재 초1~4</dt><dd>글을 읽고 근거를 들어 말하기, 맡은 일 끝내기, 친구의 다른 생각 듣기를 익힙니다. 입학용 자기소개서를 미리 대신 쓰거나 경력을 만들지 않습니다.</dd><dt>현재 초5</dt><dd>학교별 교육·기숙사 생활을 가족과 탐색하고 스스로 공부한 과정과 공동체 경험을 돌아봅니다. 다음 모집 요강이 나오면 자격부터 다시 확인합니다.</dd><dt>현재 초6·해당 지원자</dt><dd>올해 지원 여부에 맞춰 공식 발표·등록·후보 안내를 확인합니다. 이미 지난 접수일에 서류를 새로 내도록 안내하지 않습니다.</dd></dl><p>학생부 발급 방식과 자기소개서 부수는 학교마다 다릅니다. 학생의 글을 교사·부모·AI가 대신 작성하지 않습니다. 이 화면은 추천서·건강진단서·가족 증빙 실물을 수집하지 않습니다.</p></section>`+faq([
['세 학교가 같은 국어·수학 시험을 보나요?','아닙니다. 화산은 일반 추첨 뒤 면접, 영선은 면접, 용정은 서류 뒤 면접·체력평가입니다. 교과 범위는 각 요강에서 확인한 내용만 표시합니다.'],
['올해 접수가 끝났는데 지금 등록할 수 있나요?','학교의 합격·추가합격 통보를 받은 해당자만 공식 안내에 따라 진행합니다. 이 앱에서는 접수·합격 확인·등록·납부를 처리하지 않습니다.'],
['다음 학년도 날짜와 WB 수업은 정해졌나요?','다음 모집 공고는 이번 확인 범위에서 미확인이며 미공고 일정을 추정하지 않습니다. WB 수업 시간·횟수·수강료·담당자·개설일은 모두 미정입니다.']
])+consultation('화산·영선·용정중'));
export const outputs = { 'index.html':home, 'samyook/index.html':samyook, 'gwangju-gifted/index.html':gifted, 'middle-schools/index.html':middleSchools };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, html] of Object.entries(outputs)) {
    fs.mkdirSync(path.dirname(path.join(dir,file)), { recursive:true });
    fs.writeFileSync(path.join(dir,file),html);
  }
  console.log('공개 안내 '+Object.keys(outputs).length+'개 생성 · 학생 기록/API 변경 없음');
}
