'use strict';
/* 화면 문자열의 단일 원천 — 내부값 ↔ 학생/강사 문자열, 금지어.
   학생에게 보이는 말은 전부 과정형이어야 하고(설계안 v1 §3-1), 그 규칙을 코드 여기저기가 아니라 한 표에서 지킨다.
   P2 정적 검사가 이 파일의 findForbidden 으로 학생·부모 화면 전체를 훑는다. */
var WBHARU_S = (function () {
  var STATE = {
    hole:            { student: '다시 만날 칸',     coach: '구멍' },
    shaky:           { student: '굳히는 중',        coach: '흔들림' },
    unknown:         { student: '처음 보는 칸',     coach: '미확인' },
    fluent:          { student: '붙었어요',         coach: '유창' },
    'observed-only': { student: '종이에서 만난 칸', coach: '주변(관측만)' }
  };
  var SLOT = { hole: '다시 만날 칸', shaky: '굳히는 중', probe: '처음 보는 칸' };
  var RANK = { unknown: 0, hole: 1, shaky: 2, fluent: 3 };

  /* 학생 화면 금지어 — 결손·서열·결과 어휘. 부모 화면 금지어 — 압력·능력 귀인. 강사 보드는 내부값이 보이므로 없다. */
  var FORBIDDEN = {
    student: ['구멍', '오답', '틀렸', '점수', '합격', '불합격', '아쉽', '축하', '다음 목표', '다른 학교', '화산중',
              '등수', '순위', '백분위', '경쟁률', '확률', '흔들림 →', '강등', '실패'],
    parent:  ['아직', '밀렸', '남았', '틀렸습니다', '같이 풀어', '잘할 수 있어요', '등수', '순위', '확률', '구멍',
              '이해력', '집중력', '노력이 필요', '부족', '산만', '게을', '합격', '불합격', '경쟁률', '분발']
  };

  function stateLabel(state, aud) {
    var row = STATE[state]; if (!row) return '';
    return aud === 'coach' ? row.coach : row.student;
  }
  function slotLabel(kind) { return SLOT[kind] || ''; }

  /* "관측 n번 중 m번 맞았어요 · k번 더 만나면 붙어요" — 상태 이름이 아니라 관측으로 말한다.
     need 는 유창 판정에 필요한 실관측(mastery MIN_FLUENT_OBS = 8). */
  function progressLine(obs, ok, need) {
    var n = Math.round(obs || 0), m = Math.round(ok || 0), k = Math.max(0, Math.ceil((need || 8) - (obs || 0)));
    if (n === 0) return '오늘 처음 만나요';
    var tail = k > 0 ? k + '번 더 만나면 붙어요' : '섞어 내도 맞으면 붙어요';
    return '관측 ' + n + '번 중 ' + m + '번 맞았어요 · ' + tail;
  }

  /* 승격만 말한다. 강등(shaky → hole)은 학생 화면에 없다 — 12살이 매일 강등 통보를 받는 앱이 되면 안 된다. */
  function transitionLine(from, to, label) {
    if ((RANK[to] || 0) <= (RANK[from] || 0)) return null;
    if (to === 'fluent') return label + ' — 붙었어요';
    if (to === 'shaky') return label + ' — 굳히는 중이에요';
    return null;
  }

  function findForbidden(text, aud) {
    var list = FORBIDDEN[aud] || [];
    var t = String(text || '');
    return list.filter(function (w) { return t.indexOf(w) >= 0; });
  }

  /* 부모 coach 한 줄 — 능력 귀인 금지, 과정 서술만. 3주 연속 저실행이면 멈춘다(압력 루프 상한). */
  function coach(weekDone, lowWeeks, nextMockText) {
    if ((lowWeeks || 0) >= 3) return null;
    if (weekDone >= 4) return '이번 주 ' + weekDone + '일 앉았습니다.' + (nextMockText ? ' 다음 회차는 ' + nextMockText + '입니다.' : '');
    if (weekDone >= 1) return '이번 주 ' + weekDone + '일 앉았습니다. 저녁 시작 시각을 30분 당겨 보시겠어요?';
    return '이번 주는 앉은 날이 없습니다. 시작 시각을 함께 정해 보시겠어요?';
  }

  return { STATE: STATE, SLOT: SLOT, FORBIDDEN: FORBIDDEN, stateLabel: stateLabel, slotLabel: slotLabel,
           progressLine: progressLine, transitionLine: transitionLine, findForbidden: findForbidden, coach: coach };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_S;
