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
    const past = event.kind && ['시험', '면접', '설명회', '요강 공지 예정', '발표', '학교 안내'].includes(event.kind) ? '지난 일정' : '마감';
    if (now < start) return '예정';
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
    const official = new Set(['samyook.jge.ms.kr', 'gice.gen.go.kr', 'ai.jge.go.kr', 'gifted.gnue.ac.kr', 'csge.jnu.ac.kr', 'school.jbedu.kr', 'office.jbedu.kr', 'posef.or.kr', 'changpyeong.hs.jne.kr', 'www.jnei.go.kr', 'gifted.mokpo.ac.kr', 'www.scnu.ac.kr', 'select.gifted.ac.kr', 'ged.kedi.re.kr']);
    for (const source of data.sources) {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || !official.has(url.hostname) || url.username || url.password) throw new Error('공식 출처 주소 오류');
      if (!states.includes(source.status) || !['성공', '수집 실패'].includes(source.retrieval)) throw new Error('출처 상태 오류');
      if (instant(source.checkedAt) > instant(data.referenceDate)) throw new Error('확인일이 기준일 이후');
    }
    for (const institution of data.institutions) if (!sources.has(institution.source)) throw new Error('출처 연결 오류');
    for (const course of data.courses) {
      if (!institutions.has(course.institution) || !course.grades.length || !course.fields.length || course.grades.some(g => !Number.isInteger(g) || g < 1 || g > 6)) throw new Error('과정 조건 오류');
    }
    for (const admission of data.admissions) if (!institutions.has(admission.institution) || admission.year !== data.educationYear) throw new Error('전형 학년도 오류');
    for (const event of data.events) if (!institutions.has(event.institution) || instant(event.end) < instant(event.start)) throw new Error('일정 연결·순서 오류');
    for (const entry of data.directory) {
      if (!sources.has(entry.source) || entry.year !== data.educationYear || !['전남', '전북'].includes(entry.region) || !entry.name || !Array.isArray(entry.events)) throw new Error('보조 기관 안내 오류');
      for (const event of entry.events) if (instant(event.end) < instant(event.start)) throw new Error('보조 기관 일정 오류');
    }
    if (!/^0\d{1,2}-\d{3,4}-\d{4}$/.test(data.contact.phone)) throw new Error('상담 전화 오류');
    return data;
  }
  const api = { validate, phase, matches, instant };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HaruCatalog = api;
})(typeof window === 'object' ? window : globalThis);
