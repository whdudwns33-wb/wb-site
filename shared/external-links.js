/* WB 공용 외부 서비스 공식 링크 — consult·task·런북 팩이 같은 상수를 읽는다.
 *
 * 왜 한 곳에 모으나: consult/index.html과 task/index.html이 각자 메타수학·클래스카드·스터디포스
 * 주소를 들고 있어 외부 화면이 바뀌면 두 곳을 고쳐야 했다. 런북 팩(task/runbook-pack.json)은
 * URL 대신 여기 '키'만 적어, 팩(공개 저장소)에 주소가 흩어지지 않게 한다.
 *
 * 원칙(이원화 문서·CLAUDE.md 3): 승인된 공식 HTTPS 주소만 새 창(target=_blank rel=noopener
 * noreferrer)으로 연다. iframe·프록시·스크래핑·자동 로그인 없음. 아이디·비밀번호는 어디에도 없다.
 *
 *   WBExternalLinks.linkFor('studyforce_admin')  → { key, label, url, program }
 *   WBExternalLinks.isApprovedLink(url)          → https + 허용 호스트일 때만 true
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBExternalLinks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 정본 출처:
   *  - consult/index.html LEADERS_EYE_URL·METAMATH_CENTER_URL·METAMATH_STUDENT_URL·
   *    CLASSCARD_ANDROID_APP_URL·CLASSCARD_IOS_APP_URL·STUDYFORCE_URL·NELT_EXAM_URL
   *  - task/index.html 학생 포털 미리보기의 클래스카드 로그인 상수
   *  - 이그잼포유·족보닷컴·넬트는 2026-09-09 공식 사이트를 확인해 적었다(www 없는 exam4you.com이 정본,
   *    zocbo.com이 족보닷컴, nelt.co.kr이 NELT 접수·결과 사이트). 넬트 학생 응시 페이지는 consult 상수 그대로.
   * 키 이름은 구현 계약 §2에 고정되어 있다(팩·서버·UI가 같은 문자열을 쓴다). */
  const LINKS = Object.freeze({
    studyforce_admin: Object.freeze({
      label: '스터디포스 관리자', program: 'studyforce',
      url: 'https://hol.sfcenter.co.kr/'
    }),
    classcard_teacher: Object.freeze({
      label: '클래스카드 교사', program: 'classcard',
      url: 'https://www.classcard.net/Login'
    }),
    classcard_app_android: Object.freeze({
      label: '클래스카드 앱 (Android)', program: 'classcard',
      url: 'https://play.google.com/store/apps/details?id=classcard.net'
    }),
    classcard_app_ios: Object.freeze({
      label: '클래스카드 앱 (iOS)', program: 'classcard',
      url: 'https://apps.apple.com/kr/app/id1176435331'
    }),
    metamath_center: Object.freeze({
      label: '메타수학 교실홈', program: 'metamath',
      url: 'https://www.mmatht.co.kr/Pages/home2/login.cshtml?kind=center'
    }),
    metamath_student: Object.freeze({
      label: '메타수학 학생홈', program: 'metamath',
      url: 'https://new.mmath.co.kr/Pages/Student/Login/login.cshtml?f_next='
    }),
    nelt_org: Object.freeze({
      /* NELT 공식 사이트 — 테스트 접수·결과 조회(기관 로그인). 학원이 응시를 잡는 자리. */
      label: '넬트 접수·결과', program: 'nelt',
      url: 'https://www.nelt.co.kr/'
    }),
    nelt_student: Object.freeze({
      /* 학생 응시 페이지(NE Tutor) — consult/index.html NELT_EXAM_URL과 같은 주소. */
      label: '넬트 학생 응시', program: 'nelt',
      url: 'https://www.netutor.co.kr/st/'
    }),
    leaders_eye: Object.freeze({
      label: '리더스아이', program: 'leaders_eye',
      url: 'https://www.eyestudent.com/login'
    }),
    exam4you: Object.freeze({
      /* 공식 홈(www는 여기로 302). 구매·다운로드는 직원 계정으로 외부 사이트에서 한다. */
      label: '이그잼포유', program: 'exam4you',
      url: 'https://exam4you.com/'
    }),
    jokbo: Object.freeze({
      /* 족보닷컴 공식 홈(교육지대). 구매 단위·형식은 A.12-11에서 확정. */
      label: '족보닷컴', program: 'jokbo',
      url: 'https://www.zocbo.com/'
    })
  });

  const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;

  function str(v) { return v == null ? '' : String(v).trim(); }

  function keys() { return Object.keys(LINKS); }

  /** 키 → { key, label, url, program }. 모르는 키는 null — 호출부가 링크 버튼을 아예 그리지 않게. */
  function linkFor(key) {
    const k = str(key);
    if (!KEY_RE.test(k) || !Object.prototype.hasOwnProperty.call(LINKS, k)) return null;
    const row = LINKS[k];
    return { key: k, label: row.label, url: row.url, program: row.program };
  }

  function programOf(key) {
    const row = linkFor(key);
    return row ? row.program : '';
  }

  /** 링크 표에 등장하는 호스트 전부(정렬·중복 제거). isApprovedLink의 허용 목록이다. */
  function hosts() {
    const out = new Set();
    keys().forEach(k => {
      const host = hostOf(LINKS[k].url);
      if (host) out.add(host);
    });
    return Array.from(out).sort();
  }

  function parseUrl(value) {
    const s = str(value);
    if (!s || s.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
    if (typeof URL !== 'function') return null;
    try { return new URL(s); } catch (e) { return null; }
  }

  function hostOf(value) {
    const u = parseUrl(value);
    return u ? u.hostname.toLowerCase() : '';
  }

  /** https이고 허용 호스트이며 자격증명(user:pass@)이 박히지 않은 주소만 승인한다.
   *  요청함의 resultUrl·팩의 링크 키가 모두 이 검사를 지난다 — 임의 사이트로 직원을 보내지 않기 위해서다. */
  function isApprovedLink(value) {
    const u = parseUrl(value);
    if (!u) return false;
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return hosts().includes(u.hostname.toLowerCase());
  }

  /** consult/index.html의 classcardAppUrl과 같은 판정. 데스크톱은 '' — 교사 화면 링크를 쓰라는 뜻. */
  function classcardAppUrl(userAgent, maxTouchPoints) {
    const ua = String(userAgent || '');
    if (/Android/i.test(ua)) return LINKS.classcard_app_android.url;
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && Number(maxTouchPoints) > 1)) {
      return LINKS.classcard_app_ios.url;
    }
    return '';
  }

  return {
    LINKS: LINKS,
    keys: keys,
    linkFor: linkFor,
    programOf: programOf,
    hosts: hosts,
    isApprovedLink: isApprovedLink,
    classcardAppUrl: classcardAppUrl
  };
});
