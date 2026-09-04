#!/usr/bin/env node
/* WB 국어브레인 — 단원 폴더 하나 → 팩 초안 (추출 파이프라인 3단계, 한 줄짜리 입구)
 *
 *   node naesin-ko/extract/build-pack.mjs "~/WB 학습자료/naesin-ko/2026-2/2022-cheonjae-nomisuk-m2-2-U1"
 *
 * 폴더 규칙은 docs/자료-폴더-표준.md, 절차·검수 항목은 naesin-ko/extract/README.md 가 정본이다.
 *
 * 하는 일:
 *   ① 폴더 이름을 팩 id 로 검증 (서버가 받는 형식이어야 한다)
 *   ② PDF 마다 **내용으로** 시리즈를 판별 — 파일명은 안 본다(드라이브에서 한글이 깨진다)
 *   ③ 맞는 추출기로 돌린다
 *   ④ 여러 자료의 머리말 메타를 교차 보강한다 (학기는 서술형 공략에만, 작가는 문제집에만 있다)
 *   ⑤ 작품 단위로 병합한다 — 조각(patch)에 **팩 전역 유일 id 를 붙이는 것이 여기 책임이다**
 *   ⑥ pack/ 과 review/ 를 나눠 쓴다. 검수 부속물은 팩에 절대 안 들어간다
 *
 * 안 하는 일: 검수. 나오는 것은 초안이고, 사람이 보고 고친 뒤 관리 웹에 올린다(기획서 §7[3]).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as U from './spans-util.mjs';
import { buildIhae } from './build-ihae.mjs';
import { buildYoyak } from './build-yoyak.mjs';
import { buildDanwon } from './build-danwon.mjs';
import { buildSeosul } from './build-seosul.mjs';

const PACK_ID_RE = /^[A-Za-z0-9-]{3,60}$/;   // 서버(naesin-ko-api.mjs)와 같은 규칙
const HERE = path.dirname(new URL(import.meta.url).pathname);

/* ── 1단계: PDF → spans ──
   이미 뽑아 둔 .json 이 있으면 그것을 쓴다(재실행이 빠르고, python 없이도 돈다). */
function spansOf(file, cacheDir) {
  if (/\.json$/i.test(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const cache = path.join(cacheDir, path.basename(file).replace(/\.pdf$/i, '') + '.spans.json');
  if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs > fs.statSync(file).mtimeMs) {
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  const out = execFileSync('python3', [path.join(HERE, 'pdf-spans.py'), file],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cache, out);
  return JSON.parse(out);
}

/* ── _meta.txt — 자료에 인쇄되지 않은 것만 사람이 적는다 (실측으로 개정 연도 하나뿐) ── */
function readMetaTxt(dir) {
  const f = path.join(dir, '_meta.txt');
  if (!fs.existsSync(f)) return {};
  const out = {};
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

/* 여러 자료의 머리말 메타를 합친다 — 먼저 채워진 값이 이긴다(빈 칸만 메운다) */
function mergeMeta(metas) {
  const out = {};
  metas.forEach((m) => {
    Object.keys(m || {}).forEach((k) => { if (!out[k] && m[k]) out[k] = m[k]; });
  });
  return out;
}

/* 작품 id — 한글은 팩 id 문자셋에 못 들어간다. 머리말 좌표에서 기계적으로 만든다.
   '1-1.(2)비린내라뇨!' → 'w-1-1-2'. 좌표가 없으면 순번으로 떨어진다. */
export function workIdFor(workKey, index) {
  const m = String(workKey || '').match(/^(\d+)-(\d+)\.\((\d+)\)/);
  if (m) return 'w-' + m[1] + '-' + m[2] + '-' + m[3];
  return 'w-' + String(index + 1).padStart(2, '0');
}
/* 앵커 문자열을 정본 본문의 표기로 맞춘다. 공백만 어긋난 경우를 되살리고,
   본문에 아예 없으면 null 을 준다(사람이 본다). */
function workLines(w) {
  const t = w.text || {};
  return [].concat(
    (t.stanzas || []).flatMap((s) => s.lines || []),
    t.paragraphs || [],
  );
}
export function reanchor(w, anchorText) {
  const a = String(anchorText || '');
  if (!a) return null;
  const lines = workLines(w);
  for (const line of lines) if (line.includes(a)) return a;      // 그대로 있으면 손대지 않는다
  const squash = (x) => x.replace(/\s+/g, '');
  const target = squash(a);
  for (const line of lines) {
    const flat = squash(line);
    const at = flat.indexOf(target);
    if (at < 0) continue;
    /* 공백을 지운 자리로 원문의 구간을 되짚어 **정본 표기 그대로** 돌려준다 */
    let seen = 0, start = -1, end = -1;
    for (let i = 0; i < line.length; i++) {
      if (/\s/.test(line[i])) continue;
      if (seen === at) start = i;
      seen += 1;
      if (seen === at + target.length) { end = i + 1; break; }
    }
    if (start >= 0 && end > start) return line.slice(start, end);
  }
  return null;
}

/* 조각을 붙일 작품을 찾는다. 좌표 키가 있으면 그것으로, 없으면 작품명으로 잇는다 —
   문제집 계열은 좌표 대신 제목·작가만 인쇄돼 있다. */
function findWork(works, patch) {
  if (patch.workKey) {
    const byKey = works.filter((w) => w._workKey === patch.workKey)[0];
    if (byKey) return byKey;
  }
  const title = (patch.title || '').trim();
  if (!title) return null;
  return works.filter((w) => (w.title || '').trim() === title)[0] || null;
}

/* ── 같은 개념을 가리키는 빈칸 병합 (§2.2-2) ──
   자료는 같은 핵심어를 여러 자리에서 뚫는다. 이해완성과 요약노트가 같은 표의 같은 칸을
   각각 뚫고, 이해 전략 절이 본문의 같은 개념을 또 뚫는다. 그대로 두면 학습량이 개념 수가
   아니라 **지면 수**에 비례한다 — 실측 1단원에서 빈칸 328개, 안정화까지 하루 66개였다.

   두 갈래로 합친다:
     ① 같은 path + 같은 정답 → 두 자료가 같은 자리를 뚫은 것. 의심의 여지가 없다.
     ② 같은 정답 (path 는 달라도) → 같은 개념을 다른 문장에서 뚫은 것.
        **한 글자 정답은 여기서 뺀다** — '원'·'배'·'집' 같은 것은 같은 글자라고 같은 개념이 아니다.

   합치면서 문맥을 버리지 않는다. 나머지 문맥은 alts 로 남겨 회전마다 다른 문장으로 묻는다 —
   같은 문장을 네 번 채우면 문장을 외우고, 다른 문장에서 꺼내야 개념을 외운다(인출 변이).
   대표 문맥은 정본에 가까운 것부터 고른다(개관·본문 > 구성·날개풀이 > 전략·출제 Point). */
const PATH_RANK = (p) => {
  const x = String(p || '');
  if (x.startsWith('overview')) return 0;
  if (x.startsWith('text')) return 1;
  if (x.startsWith('composition')) return 2;
  if (x.startsWith('lineNotes')) return 3;
  return 4;
};
const ALT_MAX = 3;          // 대표 1 + 변이 3 = 회전 4번이면 한 바퀴 돈다

export function mergeBlanks(work, opts) {
  opts = opts || {};
  const minLen = opts.minLen == null ? 2 : opts.minLen;
  const groups = new Map();
  (work.blanks || []).forEach((b, i) => {
    const ans = (b.answers || []).map((x) => String(x).trim()).join('/');
    /* 짧은 정답은 정답만으로 묶지 않는다 — 자리가 같을 때만 같은 것으로 본다 */
    const key = ans.length >= minLen ? 'a|' + ans : 'p|' + b.path + '|' + ans;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ b, i });
  });

  const out = [];
  let merged = 0;
  const log = [];
  groups.forEach((g) => {
    if (g.length === 1) { out.push(g[0].b); return; }
    /* 이해완성 것을 먼저 세운다 — 정본 문맥이 대표가 되게 */
    g.sort((x, y) => {
      const r = PATH_RANK(x.b.path) - PATH_RANK(y.b.path);
      if (r) return r;
      const s = (x.b.id.includes(':bl-') ? 0 : 1) - (y.b.id.includes(':bl-') ? 0 : 1);
      return s || (x.i - y.i);
    });
    const head = { ...g[0].b };
    const rest = g.slice(1);
    /* 변이는 **서로 다른 문장**이어야 뜻이 있다. 자료에는 같은 줄이 잘려 두 번 들어오는
       경우가 있어(연 요지가 다음 줄로 이어지면서 각각 빈칸이 된다) 글자 비교만으로는 못 거른다.
       한쪽이 다른 쪽에 통째로 들어 있으면 같은 문장으로 보고 **긴 쪽만** 남긴다. */
    const key = (t) => String(t || '').replace(/[□\s]/g, '');
    let pool = rest.map((x) => ({ text: x.b.text, slot: x.b.slot || 0, path: x.b.path, label: x.b.label }));
    pool = pool.filter((c) => {
      const k = key(c.text), h = key(head.text);
      return k && !(h.includes(k) || k.includes(h) && k.length <= h.length);
    });
    pool.sort((a, b2) => key(b2.text).length - key(a.text).length);   // 긴 문맥부터
    const alts = [];
    pool.forEach((c) => {
      if (alts.length >= ALT_MAX) return;
      const k = key(c.text);
      if (alts.some((a) => key(a.text).includes(k) || k.includes(key(a.text)))) return;
      alts.push(c);
    });
    if (alts.length) head.alts = alts;
    head.mergedCount = g.length;
    out.push(head);
    merged += g.length - 1;
    log.push({ answers: head.answers, kept: head.id, paths: g.map((x) => x.b.path), n: g.length });
  });

  /* 원래 순서를 지킨다 — 검수자가 지면 순서로 훑는다 */
  const pos = new Map();
  (work.blanks || []).forEach((b, i) => pos.set(b.id, i));
  out.sort((a, b) => pos.get(a.id) - pos.get(b.id));
  work.blanks = out;
  return { merged, log };
}

export function buildPack(dir, opts) {
  opts = opts || {};
  const packId = opts.packId || path.basename(dir.replace(/\/+$/, ''));
  const errors = [], warns = [], report = [], todo = [];
  if (!PACK_ID_RE.test(packId)) {
    errors.push(`폴더 이름이 팩 id 형식이 아니에요: '${packId}' — 영문 소문자·숫자·하이픈 3~60자.` +
      ' docs/자료-폴더-표준.md §2 를 보세요.');
    return { packId, errors, warns, report, todo, pack: null, review: null };
  }

  const files = fs.readdirSync(dir)
    .filter((f) => /\.(pdf|json)$/i.test(f) && !/^_/.test(f) && !/\.spans\.json$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  if (!files.length) errors.push('PDF가 없어요. 단원 폴더에 자료를 넣어 주세요.');

  const cacheDir = path.join(dir, '_spans');
  const found = [];
  files.forEach((file) => {
    let doc;
    try { doc = spansOf(file, cacheDir); }
    catch (e) { errors.push(`${path.basename(file)} 을 읽지 못했어요: ${String(e.message).slice(0, 120)}`); return; }
    const det = U.detectSeries(doc);
    if (!det.series) {
      /* 판별 실패는 추측하지 않고 사람에게 넘긴다 — 엉뚱한 추출기에 넣으면 조용히 망가진다 */
      errors.push(`${path.basename(file)} 의 시리즈를 판별하지 못했어요` +
        (det.candidates && det.candidates.length ? ` (후보: ${det.candidates.join(', ')})` : '') +
        '. 표지 쪽이 빠졌거나 새 상품군일 수 있어요 — README §1 을 보세요.');
      return;
    }
    if (!det.confident) warns.push(`${path.basename(file)}: 머리말 태그가 없어 색·마커로 판별했어요(${U.SERIES_LABEL[det.series]}). 결과를 한 번 더 보세요.`);
    found.push({ file, doc, series: det.series });
  });

  /* ── 시리즈별 추출 ──
     **2패스다.** 문제집 계열은 지문 세트를 만들 때 '이 제목이 어느 workId 인가'를 알아야 하는데,
     그 id 는 이해완성이 만든다. 순서를 안 지키면 세트가 통째로 안 나오고 문항이 지문 없이 나간다. */
  const metaTxt = readMetaTxt(dir);
  const scope = (metaTxt.scope || '').trim() || null;
  const results = [];
  const runIhae = (f) => {
    try { results.push({ ...f, out: buildIhae(f.doc, { workId: 'TBD' }) }); }
    catch (e) { errors.push(`${path.basename(f.file)}(이해완성) 추출 중 오류: ${String(e.message).slice(0, 200)}`); }
  };
  found.filter((f) => f.series === 'ihae').forEach(runIhae);

  /* 1패스 결과로 작품 정본을 세우고 id를 정한다 */
  const works = [];
  results.filter((r) => r.series === 'ihae').forEach((r, i) => {
    /* 이해완성 머리말 '1-1.(1)저녁 항구' 의 좌표 문자열이 시리즈끼리의 조인 키다 */
    const raw = U.plainText(r.doc).match(/(\d+-\d+\.\(\d+\)[^\s]{0,30})/);
    const workKey = raw ? raw[1] : r.out.work.title;
    const workId = workIdFor(workKey, i);
    const w = r.out.work;
    w.workId = workId;
    w._workKey = workKey;
    w.blanks.forEach((b, n) => { b.id = U.blankId(workId, 'ihae', n + 1); });
    works.push(w);
  });
  const workIds = {};
  works.forEach((w) => { if (w.title) workIds[w.title] = w.workId; });

  /* 2패스 — 이제 제목→workId 를 넘길 수 있다 */
  found.filter((f) => f.series !== 'ihae').forEach((f) => {
    const base = path.basename(f.file);
    const o = { workIds };
    if (scope) o.scope = scope;
    try {
      if (f.series === 'yoyak') results.push({ ...f, out: buildYoyak(f.doc, o) });
      else if (f.series === 'danwon') results.push({ ...f, out: buildDanwon(f.doc, o) });
      else if (f.series === 'seosul') results.push({ ...f, out: buildSeosul(f.doc, o) });
    } catch (e) {
      errors.push(`${base}(${U.SERIES_LABEL[f.series]}) 추출 중 오류: ${String(e.message).slice(0, 200)}`);
    }
  });

  const meta = mergeMeta(results.map((r) => r.out.meta).concat([metaTxt]));
  if (!metaTxt.revision) {
    todo.push('개정 연도(revision)가 자료 어디에도 인쇄돼 있지 않아요 — _meta.txt 에 `revision: 2022` 처럼 적어 주세요.');
  }

  /* ── 조각 병합 — 팩 전역 유일 id 를 붙이는 것이 여기 책임이다 ── */
  const orphans = [], unanchored = [], reanchored = [];
  results.forEach((r) => {
    (r.out.patches || []).forEach((p) => {
      const w = findWork(works, p);
      if (!w) { orphans.push({ series: r.series, workKey: p.workKey || p.title }); return; }
      if (!w.author && p.author) w.author = p.author;
      (p.blanks || []).forEach((b, n) => {
        w.blanks.push({ ...b, id: U.blankId(w.workId, r.series, n + 1) });
      });
      (p.vocab || []).forEach((v, n) => {
        /* 검증기는 작품 내 유일만 보지만 engine 의 상태 키가 평면이라 실제로는 전역 유일이어야 한다 */
        w.vocab.push({ ...v, id: 'v-' + w.workId + '-' + String(n + 1).padStart(3, '0') });
      });
      ['checklist', 'examPoints', 'keywords', 'rhetoric', 'appreciationPoints'].forEach((k) => {
        if (Array.isArray(p[k]) && p[k].length) w[k] = (w[k] || []).concat(p[k]);
      });
      /* ㉠ 기호는 문제집 지면에서 오고 본문은 이해완성에서 온다. 두 지면의 띄어쓰기가
         어긋나면(밑줄이 span 을 가르면서 공백이 먹힌다 — 실측 '있다우리 집 현관에서')
         검증기가 '앵커가 본문에 없다'로 배포를 막는다. 양쪽을 다 가진 건 병합기뿐이라
         여기서 맞춘다: 공백을 무시하고 찾아 **정본 쪽 표기로 고쳐 넣는다.**
         그래도 못 찾으면 버리지 않고 검수로 넘긴다 — 조용히 지우면 기호가 사라진 걸 아무도 모른다. */
      (p.marks || []).forEach((mk) => {
        const fixed = reanchor(w, mk.anchorText);
        if (fixed) {
          /* 고쳐서 붙였다면 두 지면의 표기가 다르다는 뜻이다. 정본은 그대로 두되(원문 보존,
             pack-schema 원칙 3) **말은 한다** — 같은 시가 자료마다 다르게 조판돼 있다는 사실은
             검수자가 알아야 하고, 조용히 맞춰 버리면 아무도 모른다. */
          if (fixed !== mk.anchorText) {
            reanchored.push({ workId: w.workId, title: w.title, series: r.series,
              symbol: mk.symbol || '', from: mk.anchorText, to: fixed });
          }
          w.marks.push({ ...mk, anchorText: fixed });
        } else {
          unanchored.push({ workId: w.workId, title: w.title, series: r.series, mark: mk });
        }
      });
      /* check 는 대조용이지 값이 아니다 — 어긋나면 경고만 내고 정본을 덮어쓰지 않는다 */
      const chk = p.check && p.check.overview;
      if (chk && w.overview) {
        ['material', 'theme'].forEach((k) => {
          if (chk[k] && w.overview[k] && chk[k] !== w.overview[k]) {
            warns.push(`${w.title}: ${U.SERIES_LABEL[r.series]}의 ${k} 가 이해완성과 달라요 — 검수에서 어느 쪽을 쓸지 정하세요.`);
          }
        });
      }
    });
  });
  if (reanchored.length) {
    warns.push(`기호 앵커 ${reanchored.length}곳의 띄어쓰기가 자료마다 달라 정본 표기로 맞췄어요 —` +
      ' 원문은 고치지 않았습니다. 어느 쪽이 맞는지는 검수(review.reanchored)에서 보세요.');
  }
  unanchored.forEach((u) => {
    warns.push(`${u.title}: ${U.SERIES_LABEL[u.series]}의 기호 '${u.mark.symbol || '?'}' 를 본문에서 못 찾았어요` +
      ` — 앵커 '${String(u.mark.anchorText || '').slice(0, 24)}…'. 검수에서 붙이세요(팩에는 안 넣었습니다).`);
  });
  orphans.forEach((o) => {
    warns.push(`${U.SERIES_LABEL[o.series]}의 조각 '${o.workKey}' 을 붙일 작품을 못 찾았어요 —` +
      ' 그 작품의 이해완성 파일이 폴더에 없거나 제목 표기가 달라요.');
  });

  /* ── 지문 세트·문항 ──
     **지문 없이 나가는 문항을 막는 게 여기 책임이다.** 추출기는 지문 세트가 미심쩍으면
     그 세트만 검수로 내리는데, 그 세트를 가리키던 문항은 그대로 남아 팩에 실린다 —
     학생 화면에 '(라)를 …' 이라고 묻는데 (라)가 한 글자도 안 보이는 문항이 된다.
     검증기는 setId 가 **있을 때만** 참조를 보므로 이걸 못 잡는다(오류 0으로 통과한다). */
  const sets = [], items = [], dropped = [];
  const byId = {};
  works.forEach((w) => { byId[w.workId] = w; });
  results.forEach((r) => {
    (r.out.sets || []).forEach((set) => {
      /* 세트가 가진 ㉠ 앵커도 정본 표기로 맞춘다 — 작품 patch 만 맞추면 세트 쪽이 안 맞아
         '㉠와 ㉡의 공통점을 쓰시오' 문항의 지문에 표시가 안 뜬다(같은 시가 자료마다
         띄어쓰기가 다르다). 못 맞추면 그 기호만 빼고 검수로 넘긴다. */
      if (Array.isArray(set.marks) && set.marks.length) {
        const kept = [];
        set.marks.forEach((mk) => {
          const w = byId[mk.workId] || (set.works || []).map((ref) => byId[ref.workId]).filter(Boolean)[0];
          if (!w) { kept.push(mk); return; }
          const fixed = reanchor(w, mk.anchorText);
          if (!fixed) { unanchored.push({ workId: w.workId, title: w.title, series: r.series, setId: set.setId, mark: mk }); return; }
          if (fixed !== mk.anchorText) {
            reanchored.push({ workId: w.workId, title: w.title, series: r.series, setId: set.setId,
              symbol: mk.symbol || '', from: mk.anchorText, to: fixed });
          }
          kept.push({ ...mk, anchorText: fixed });
        });
        set.marks = kept;
      }
      sets.push(set);
    });
  });
  const setIds = {};
  sets.forEach((s) => { setIds[s.setId] = true; });
  const workIdSet = {};
  works.forEach((w) => { workIdSet[w.workId] = true; });
  results.forEach((r) => {
    (r.out.items || []).forEach((it) => {
      const hasSet = it.setId && setIds[it.setId];
      const hasWork = it.workId && workIdSet[it.workId];
      if (!hasSet && !hasWork) {
        dropped.push({ series: r.series, id: it.id, no: it.source && it.source.no, stem: String(it.stem || '').slice(0, 60) });
        return;
      }
      items.push(it);
    });
  });
  if (dropped.length) {
    warns.push(`지문을 못 찾은 문항 ${dropped.length}개를 팩에서 뺐어요 —` +
      ` 학생 화면에 지문 없이 뜰 문항이라서예요. 검수(review.dropped)에서 지문 세트를 확정한 뒤 넣으세요.` +
      ` (번호: ${dropped.map((d) => d.no || d.id).join(', ')})`);
  }

  /* 한 문맥(text)에 □ 무리가 여럿인 빈칸이 흔하다(개관 '특징' 한 줄에 정답 6~7개).
     학생 화면은 □ 무리 하나에만 입력칸을 뚫으므로, **몇 번째 무리인지**를 적어 주지 않으면
     보이는 칸과 채점할 정답이 어긋난다(실측 요약노트 106개 중 47개). 같은 문맥을 공유하는
     빈칸은 뽑힌 순서가 곧 지면의 왼→오 순서라 그대로 슬롯 번호가 된다.
     **병합보다 먼저 해야 한다** — 합치면서 남기는 변이 문맥도 자기 슬롯을 달고 가야 하기 때문이다. */
  works.forEach((w) => {
    const seen = {};
    (w.blanks || []).forEach((b) => {
      if (b.slot != null) return;
      const groups = (String(b.text || '').match(/□+/g) || []).length;
      if (groups <= 1) { b.slot = 0; return; }
      const k = b.text;
      seen[k] = (seen[k] == null ? -1 : seen[k]) + 1;
      b.slot = seen[k];
    });
  });

  /* 같은 개념을 가리키는 빈칸을 합친다 — 학습량이 개념 수에 비례하게(§2.2-2) */
  let mergedTotal = 0;
  const mergeLog = [];
  works.forEach((w) => {
    const before = w.blanks.length;
    const r = mergeBlanks(w);
    mergedTotal += r.merged;
    if (r.merged) mergeLog.push({ workId: w.workId, title: w.title, before, after: w.blanks.length, groups: r.log });
  });


  /* ── 팩 조립 ── */
  const pack = {
    meta: {
      packId,
      revision: metaTxt.revision ? Number(metaTxt.revision) : null,
      publisher: metaTxt.publisher || (meta.publisher ? `${meta.publisher}(${meta.publisherAuthor})` : ''),
      grade: metaTxt.grade || meta.grade || '',
      semester: metaTxt.semester || meta.semester || '',
      unit: metaTxt.unit || (meta.unit ? `${meta.unit}. ${meta.unitTitle || ''}`.trim() : ''),
      source: {
        provider: '족보닷컴(교육지대㈜)',
        producedAt: meta.madeAt || '',
        contentCode: meta.sourceId || '',
        protectNotice: '콘텐츠산업 진흥법 보호 표시 있음',
      },
    },
    works, sets, items,
  };

  /* ── 보고 ── */
  const blanks = works.reduce((a, w) => a + w.blanks.length, 0);
  const vocab = works.reduce((a, w) => a + (w.vocab || []).length, 0);
  report.push(`팩 id ${packId}`);
  report.push('자료 ' + found.length + '개: ' + found.map((f) => U.SERIES_LABEL[f.series]).join(' · '));
  report.push(`작품 ${works.length} · 지문 세트 ${sets.length} · 저장 문항 ${items.length}`);
  report.push(`개념 단위(빈칸) ${blanks} · 어휘 ${vocab}` +
    (mergedTotal ? ` (같은 개념 ${mergedTotal}개를 합쳐 ${blanks + mergedTotal} → ${blanks}. 나머지 문맥은 회전 변이로 남김)` : ''));
  report.push('메타: ' + [pack.meta.publisher, pack.meta.grade, pack.meta.semester && pack.meta.semester + '학기',
    pack.meta.unit, pack.meta.revision ? pack.meta.revision + ' 개정' : '개정 연도 없음'].filter(Boolean).join(' · '));

  const pending = [];
  results.forEach((r) => {
    (r.out.review && r.out.review.todo || r.out.todo || []).forEach((t) => todo.push(`[${U.SERIES_LABEL[r.series]}] ${t}`));
    (r.out.review && r.out.review.pending || []).forEach((p) => pending.push({ series: r.series, ...p }));
  });
  if (pending.length) {
    report.push(`검수 대기 ${pending.length}건 — 루브릭 미저작 서술형·대조 미달 등. 팩에 넣지 않았습니다.`);
  }
  if (!works.length) errors.push('작품 정본이 없어요 — 이해완성 파일이 폴더에 있어야 합니다.');

  const review = {
    packId, pending, unanchored, reanchored, dropped, mergeLog,
    candidates: results.flatMap((r) => ((r.out.review && r.out.review.candidates) || r.out.candidates || [])
      .map((c) => ({ series: r.series, ...c }))),
    report: results.flatMap((r) => ((r.out.review && r.out.review.report) || r.out.report || [])
      .map((x) => `[${U.SERIES_LABEL[r.series]}] ${x}`)),
    todo, warns,
  };
  return { packId, errors, warns, report, todo, pack, review, meta };
}

/* ── CLI ── */
const invokedDirectly = process.argv[1] && /build-pack\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
  if (!dir) {
    console.error('사용법: node naesin-ko/extract/build-pack.mjs <단원 폴더> [--out <내보낼 곳>]\n' +
      '폴더 규칙은 docs/자료-폴더-표준.md 를 보세요.');
    process.exit(1);
  }
  if (!fs.existsSync(dir)) { console.error(`폴더가 없어요: ${dir}`); process.exit(1); }

  const r = buildPack(dir);
  const say = (s) => process.stderr.write(s + '\n');
  say('\n[단원 팩 초안]');
  r.report.forEach((x) => say('  ' + x));
  if (r.warns.length) { say('\n[경고]'); r.warns.forEach((x) => say('  ! ' + x)); }
  if (r.errors.length) {
    say('\n[오류 — 이대로는 못 만듭니다]');
    r.errors.forEach((x) => say('  ✗ ' + x));
    process.exit(2);
  }
  if (r.todo.length) { say('\n[검수에서 할 일]'); r.todo.forEach((x) => say('  · ' + x)); }

  /* 팩과 검수 부속물을 **다른 디렉터리**에 쓴다. pack-validate 는 팩 루트의 *.json 과
     works/ 한 겹만 읽으므로 review/ 는 검증에도 업로드에도 절대 섞이지 않는다. */
  const out = opt('out') || path.join(dir, '_build');
  const packDir = path.join(out, 'pack'), reviewDir = path.join(out, 'review');
  fs.mkdirSync(path.join(packDir, 'works'), { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'meta.json'), JSON.stringify(r.pack.meta, null, 1));
  r.pack.works.forEach((w) => {
    const clean = { ...w }; delete clean._workKey;      // 조인용 임시 키는 팩에 안 나간다
    fs.writeFileSync(path.join(packDir, 'works', w.workId + '.json'), JSON.stringify({ work: clean }, null, 1));
  });
  if (r.pack.sets.length) fs.writeFileSync(path.join(packDir, 'sets.json'), JSON.stringify({ sets: r.pack.sets }, null, 1));
  if (r.pack.items.length) fs.writeFileSync(path.join(packDir, 'items.json'), JSON.stringify({ items: r.pack.items }, null, 1));
  fs.writeFileSync(path.join(reviewDir, 'review.json'), JSON.stringify(r.review, null, 1));

  say(`\n팩 초안 → ${packDir}\n검수 부속물 → ${reviewDir}  (팩에 섞이지 않습니다)`);
  say(`\n다음: node naesin-ko/pack-validate.mjs "${packDir}"  → 오류 0이면 관리 웹에 업로드\n`);
}
