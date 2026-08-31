'use strict';
/* WB — 반 명단 붙여넣기 (server.mjs·worker.mjs 공용, 순수 함수)
   한 명씩 폼을 채우면 열 명 반 하나에 쉰 칸을 손으로 친다. 명단을 그대로 붙여넣게 한다.

   한 줄에 한 명: 이름 | 학년 | 반 | 코드
   학년·반·코드는 비워도 된다 — 화면에서 준 기본값이 채워지고, 코드는 새로 만들어 준다. */

const CODE_RE = /^[A-Za-z0-9-]{3,20}$/;
const strip = (s) => String(s == null ? '' : s).trim();

/* 코드 만들기 — 이미 있는 번호 다음부터. 붙여넣는 중에 생긴 것도 함께 피한다.
   접두사가 같은 것만 본다: wb-101 이 있으면 wb-102 부터. */
function nextCode(prefix, taken) {
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
  let max = 100;
  for (const c of taken) {
    const m = String(c).match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (taken.has(prefix + n)) n += 1;
  return prefix + n;
}

/* text  — 붙여넣은 명단
   opts  — { cls, grade, level, prefix, existing: [코드…] }
   반환  — { rows: [{ code, name, grade, cls, level, made }], errors: [문구…] }
           made=true 면 코드를 새로 만들어 준 줄이다. */
export function parseRoster(text, opts) {
  const o = opts || {};
  const prefix = strip(o.prefix) || 'wb-';
  const taken = new Set(o.existing || []);
  const rows = [], errors = [], seen = new Set();

  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = (i + 1) + '행';
    /* 칸 구분은 줄마다 하나만 고른다 — 막대나 탭이 있으면 그것이 구분이고 쉼표는 이름의 일부다.
       (단어 배정에서 「찢다 | 종이, 옷」의 뜻이 「종이」로 잘렸던 것과 같은 함정이다.) */
    const sep = /[|\t]/.test(line) ? /\s*[|\t]\s*/ : /\s*,\s*/;
    const c = line.split(sep).map(strip);
    const name = c[0];
    if (!name) return;
    if (name.length > 20) { errors.push(at + ': 이름이 너무 깁니다 — "' + name.slice(0, 16) + '…"'); return; }

    const code = c[3] || '';
    if (code && !CODE_RE.test(code)) {
      errors.push(at + ': 코드는 영문·숫자·붙임표 3~20자입니다 — "' + code.slice(0, 20) + '"');
      return;
    }
    /* 같은 코드가 두 줄에 있으면 뒤엣것이 앞엣것을 덮어써 한 명이 사라진다. 미리 막는다. */
    if (code && seen.has(code)) { errors.push(at + ': 코드 ' + code + ' 가 앞줄과 겹칩니다'); return; }

    const use = code || nextCode(prefix, taken);
    seen.add(use); taken.add(use);
    rows.push({
      code: use, name,
      grade: c[1] || strip(o.grade), cls: c[2] || strip(o.cls),
      level: strip(o.level), made: !code,
    });
  });

  /* 같은 이름이 둘이면 출석부에서 누가 누군지 못 가른다 — 막지는 않고 알려만 준다 */
  const byName = {};
  for (const r of rows) (byName[r.name] = byName[r.name] || []).push(r.code);
  for (const [n, cs] of Object.entries(byName)) {
    if (cs.length > 1) errors.push('알림: 이름이 같은 학생이 ' + cs.length + '명입니다 — ' + n + ' (' + cs.join(', ') + ')');
  }
  return { rows, errors };
}
