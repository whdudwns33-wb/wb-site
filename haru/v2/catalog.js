'use strict';
(function (root) {
  const states = ['공식 확인', '전년도 참고', '미공고', '확인 필요', '수집 실패'];
  const datePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/;
  function instant(value) {
    if (!datePattern.test(value)) throw new Error('날짜 형식 오류: ' + value);
    const time = Date.parse(value + (value.includes('T') ? ':00+09:00' : 'T00:00:00+09:00'));
    if (!Number.isFinite(time) || new Date(time + 9 * 3600000).toISOString().slice(0, value.length) !== value) throw new Error('유효하지 않은 날짜: ' + value);
    return time;
  }
  function phase(event, now = Date.now()) {
    const start = instant(event.start), end = instant(event.end);
    const past = event.kind && ['시험', '면접', '관찰평가', '설명회', '요강 공지 예정', '발표', '1단계 발표', '추첨', '예비소집', '학교 안내'].includes(event.kind) ? '지난 일정' : '마감';
    if (now < start) return '예정';
    if (event.kind === '수험표 출력 시작') return '출력 시작 이후 · 종료일 확인';
    // 날짜만 있는 마감은 임의의 마감 시각을 확정하지 않는다.
    if (!event.end.includes('T')) return now >= end + 86400000 ? past : '기간 내 · 시각 확인';
    return now > end ? past : '기간 내';
  }
  function matches(course, grade, field) {
    return (!grade || course.grades.includes(Number(grade))) && (!field || course.fields.includes(field));
  }
  function validate(data) {
    if (data.currentYear !== 2026 || data.educationYear !== 2027) throw new Error('현재 학년과 교육연도를 구분하세요');
    instant(data.referenceDate);
    const unique = rows => { const ids = rows.map(row => row.id); if (new Set(ids).size !== ids.length) throw new Error('중복 id'); return new Set(ids); };
    const sources = unique(data.sources), institutions = unique(data.institutions);
    unique(data.courses); unique(data.admissions); unique(data.directory);
    const official = new Set(['samyook.jge.ms.kr', 'gice.gen.go.kr', 'ai.jge.go.kr', 'gifted.gnue.ac.kr', 'csge.jnu.ac.kr', 'school.jbedu.kr', 'office.jbedu.kr', 'posef.or.kr', 'changpyeong.hs.jne.kr', 'www.jnei.go.kr', 'gifted.mokpo.ac.kr', 'www.scnu.ac.kr', 'select.gifted.ac.kr', 'ged.kedi.re.kr', 'kunsan.gidea.co.kr', 'kentech.ac.kr', 'kj-gart.jge.ms.kr', 'dream.mokpo.ac.kr', 'talented.kaist.ac.kr', 'mped.jge.go.kr', 'ysed.jge.go.kr', 'njed.jne.go.kr', 'jge.go.kr', 'www.jbe.go.kr', 'jhed.jge.go.kr', 'junior.kaist.ac.kr', 'dyed.jge.go.kr', 'gjed.jge.go.kr', 'gsed.jge.go.kr', 'gyed.jge.go.kr', 'hned.jge.go.kr', 'hped.jge.go.kr', 'hsed.jge.go.kr', 'jsed.jge.go.kr', 'kred.jge.go.kr', 'maed.jge.go.kr', 'njed.jge.go.kr', 'saed.jge.go.kr', 'wded.jge.go.kr', 'yaed.jge.go.kr', 'yged.jge.go.kr']);
    official.add('yongjeong.ms.jne.kr');
    official.add('jnucsge.gidea.co.kr');
    for (const source of data.sources) {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || !official.has(url.hostname) || url.username || url.password) throw new Error('공식 출처 주소 오류');
      if (!states.includes(source.status) || !['성공', '수집 실패'].includes(source.retrieval)) throw new Error('출처 상태 오류');
      if (instant(source.checkedAt) > instant(data.referenceDate)) throw new Error('확인일이 기준일 이후');
    }
    for (const institution of data.institutions) {
      if (!sources.has(institution.source) || (institution.notices || []).some(id => !sources.has(id))) throw new Error('출처 연결 오류');
    }
    for (const course of data.courses) {
      if (!institutions.has(course.institution) || !course.grades.length || !course.fields.length || course.grades.some(g => !Number.isInteger(g) || g < 1 || g > 6)) throw new Error('과정 조건 오류');
    }
    for (const admission of data.admissions) {
      if (!institutions.has(admission.institution) || admission.year !== data.educationYear) throw new Error('전형 학년도 오류');
      if (admission.tracks && (!Array.isArray(admission.tracks) || admission.tracks.some(t => !t.name || !t.target || !t.documents))) throw new Error('전형별 안내 오류');
      if (admission.tracks?.some(t => t.source && !sources.has(t.source))) throw new Error('전형별 출처 오류');
      if (admission.subjects && ['kor','math','eng','bible'].some(key => !admission.subjects[key])) throw new Error('교과 범위 오류');
    }
    for (const event of data.events) if (!institutions.has(event.institution) || instant(event.end) < instant(event.start)) throw new Error('일정 연결·순서 오류');
    for (const entry of data.directory) {
      if (!sources.has(entry.source) || entry.year !== data.educationYear || !['전남', '전북'].includes(entry.region) || !entry.name || !Array.isArray(entry.events)) throw new Error('보조 기관 안내 오류');
      for (const event of entry.events) if (instant(event.end) < instant(event.start)) throw new Error('보조 기관 일정 오류');
    }
    unique(data.schoolGuides);
    for (const school of data.schoolGuides) {
      if (!data.directory.some(d => d.id === school.id) || school.year !== data.educationYear || !sources.has(school.source) || school.notices.some(id => !sources.has(id))) throw new Error('학교별 안내 출처 오류');
      if (!school.tracks.length || school.tracks.some(t => !t.name || !t.target || !t.documents) || !school.preparation.length) throw new Error('학교별 준비 안내 오류');
      if (!Array.isArray(school.followup) || !school.followup.length || school.followup.some(s => !s.title || !s.text || !sources.has(s.source))) throw new Error('등록·예비소집 출처 오류');
      for (const e of school.events) if (instant(e.end) < instant(e.start)) throw new Error('학교별 일정 오류');
    }
    if (!/^0\d{1,2}-\d{3,4}-\d{4}$/.test(data.contact.phone)) throw new Error('상담 전화 오류');
    return data;
  }
  const api = { validate, phase, matches, instant };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HaruCatalog = api;
})(typeof window === 'object' ? window : globalThis);
