'use strict';
/* 여러 주소가 같은 껍데기를 돌려주는 것을 잡아낸다.
 *
 * 2026-11-23 에 srccheck 가 찾아낸 거짓 통과다. easylaw.go.kr 의 출처 여덟 자리가
 * 서로 다른 주소인데 **본문 글자 수가 24,607자로 모두 똑같았다.** 그 지면은 본문을
 * 자바스크립트로 그리기 때문에, 받아 온 것은 글이 아니라 누리집 길잡이 껍데기였다.
 * 그런데 일곱은 「제목 낱말 2/5 본문 확인」으로 **정상으로 통과했다** — 제목의 낱말이
 * 그 거대한 메뉴 목록 안에 우연히 들어 있었기 때문이다.
 *
 * 통과한 쪽이 더 위험하다. 확인되지 않은 것을 확인되었다고 적고 있었다.
 *
 * 다른 글이 **글자 수까지 똑같을** 확률은 사실상 없다. 그래서 「같은 호스트에서 서로 다른
 * 주소가 같은 길이의 본문을 돌려준다」를 껍데기의 표지로 쓴다. 143개 출처에 걸어 보니
 * 하한을 400자로 낮춰도 이 한 묶음만 잡혔다 — 거짓 경보가 없다.
 */

/* rows: [{ id, url, verdict, note, bodyLen }] — srccheck 가 모은 줄 그대로.
   반환: [{ host, bodyLen, rows }] — 같은 껍데기로 보이는 묶음들.      */
export function shellGroups(rows, { minLen = 400, minCount = 2 } = {}) {
  const buckets = new Map();
  for (const r of rows || []) {
    if (!r || typeof r.bodyLen !== 'number' || r.bodyLen < minLen) continue;
    let host;
    try { host = new URL(r.url).hostname; } catch { continue; }
    /* 같은 주소가 두 번 실린 것은 껍데기의 증거가 아니다 — 주소별로 한 번만 센다 */
    const key = host + '|' + r.bodyLen;
    const seen = buckets.get(key) || { host, bodyLen: r.bodyLen, rows: [], urls: new Set() };
    if (seen.urls.has(r.url)) continue;
    seen.urls.add(r.url);
    seen.rows.push(r);
    buckets.set(key, seen);
  }
  return [...buckets.values()]
    .filter(g => g.rows.length >= minCount)
    .map(({ host, bodyLen, rows: rs }) => ({ host, bodyLen, rows: rs }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

/* 사람이 읽을 한 줄들 — srccheck 가 요약 아래에 그대로 찍는다 */
export function shellReport(groups) {
  const out = [];
  for (const g of groups) {
    const ok = g.rows.filter(r => r.verdict === 'ok').length;
    out.push(`${g.host} — 서로 다른 ${g.rows.length}개 주소가 모두 본문 ${g.bodyLen}자다. ` +
      `자바스크립트로 그리는 지면이라 받아 온 것이 글이 아닐 수 있다` +
      (ok ? ` (그 가운데 ${ok}개가 「본문 확인」으로 통과했다 — 사람이 열어 봐야 한다)` : ''));
    for (const r of g.rows) out.push(`     ${r.id} — ${r.url}`);
  }
  return out;
}
