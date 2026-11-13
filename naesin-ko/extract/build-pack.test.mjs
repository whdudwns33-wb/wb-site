/* 폴더 → 팩 병합기 (node naesin-ko/extract/build-pack.test.mjs)
 *
 * 병합기가 지는 책임은 추출기가 못 하는 것들이다 — 자료 하나만 봐서는 알 수 없고
 * 여러 자료를 같이 봐야 하는 것. 그 셋을 여기서 건다:
 *   ① 같은 개념을 가리키는 빈칸 합치기 (학습량이 지면 수가 아니라 개념 수에 비례하게)
 *   ② 자료마다 다른 띄어쓰기를 정본 표기로 맞추기 (기호 앵커)
 *   ③ 팩 전역 유일 id
 * 실제 지면은 저장소에 못 들어오므로(CLAUDE.md 절대 규칙 1) 자체 창작 값으로 만든다. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { basicFixture, puriFixture } from './practice-fixtures.mjs';
import PC from '../pack-check.js';
import { mergeBlanks, reanchor, reanchorSetMark, workIdFor, resolveSets, buildPack, writePack } from './build-pack.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const bl = (id, path, text, answers, slot) => ({ id, path, text, answers, slot: slot || 0, label: path.split('.')[1] || path });

t('같은 자리·같은 정답은 합친다 — 두 자료가 같은 칸을 뚫은 것이다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.갈래', '□□시, 서정시', ['자유']),
    bl('w:sum-001', 'overview.갈래', '□□시', ['자유']),
  ] };
  const r = mergeBlanks(w);
  assert.strictEqual(r.merged, 1);
  assert.strictEqual(w.blanks.length, 1);
  /* 이해완성 것이 대표가 된다 — 정본 문맥이 먼저 보여야 한다 */
  assert.strictEqual(w.blanks[0].id, 'w:bl-001');
  assert.strictEqual(w.blanks[0].mergedCount, 2);
});

t('자리가 달라도 같은 개념이면 합치고, 나머지 문맥은 회전 변이로 남긴다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'strategy.p4', '전략 절에서 □□를 설명한다', ['구두']),
    bl('w:bl-002', 'overview.제재', '부모님의 □□', ['구두']),
    bl('w:bl-003', 'composition.2', '벗어두신 □□의 모습을 배로 형상화함', ['구두']),
  ] };
  const r = mergeBlanks(w);
  assert.strictEqual(r.merged, 2);
  assert.strictEqual(w.blanks.length, 1);
  const b = w.blanks[0];
  /* 대표는 정본에 가까운 것(개관 > 구성 > 전략) */
  assert.strictEqual(b.path, 'overview.제재');
  assert.strictEqual(b.alts.length, 2);
  const paths = b.alts.map((a) => a.path).sort();
  assert.deepStrictEqual(paths, ['composition.2', 'strategy.p4']);
});

t('한 글자 정답은 자리가 같을 때만 합친다 — 같은 글자라고 같은 개념이 아니다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'strategy.p5', '□관념과 보조 관념', ['원']),
    bl('w:bl-002', 'strategy.p7', '고향의 □을 그린다', ['원']),
  ] };
  assert.strictEqual(mergeBlanks(w).merged, 0);
  assert.strictEqual(w.blanks.length, 2);
  /* 같은 자리면 합친다 */
  const w2 = { blanks: [
    bl('w:bl-001', 'strategy.p5', '□관념', ['원']),
    bl('w:sum-001', 'strategy.p5', '□관념과 보조 관념', ['원']),
  ] };
  assert.strictEqual(mergeBlanks(w2).merged, 1);
});

t('잘려 두 번 들어온 같은 문장은 변이가 아니다 — 긴 쪽만 남는다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.제재', '부모님의 □□', ['구두']),
    bl('w:bl-002', 'composition.2', '벗어두신 □□의', ['구두']),
    bl('w:bl-003', 'composition.2', '벗어두신 □□의 모습을 배로 형상화함', ['구두']),
  ] };
  mergeBlanks(w);
  const alts = w.blanks[0].alts;
  assert.strictEqual(alts.length, 1, JSON.stringify(alts));
  assert.ok(/형상화함/.test(alts[0].text), alts[0].text);
});

t('변이 문맥은 자기 슬롯을 달고 간다 — 안 그러면 엉뚱한 □에 입력칸이 뚫린다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.제재', '부모님의 □□', ['구두'], 0),
    bl('w:bl-002', 'strategy.p4', '□(보조)에 □□(원관념)를 비유', ['구두'], 1),
  ] };
  mergeBlanks(w);
  assert.strictEqual(w.blanks[0].alts[0].slot, 1);
});

t('변이는 회전 한 바퀴만큼만 남긴다 — 그 이상은 저장만 늘린다', () => {
  const many = [];
  for (let i = 0; i < 9; i++) many.push(bl('w:bl-' + i, 'strategy.p' + i, '문맥' + i + ' □□ 뒤', ['편견']));
  const w = { blanks: many };
  mergeBlanks(w);
  assert.strictEqual(w.blanks.length, 1);
  assert.strictEqual(w.blanks[0].alts.length, 3);
  assert.strictEqual(w.blanks[0].mergedCount, 9);
});

t('합쳐도 지면 순서는 지킨다 — 검수자가 지면 순서로 훑는다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.갈래', '□□시', ['자유']),
    bl('w:bl-002', 'overview.제재', '□□', ['구두']),
    bl('w:bl-003', 'strategy.p4', '□□ 어쩌고', ['자유']),
    bl('w:bl-004', 'text.stanza1', '□□가 어쩌고', ['바다']),
  ] };
  mergeBlanks(w);
  assert.deepStrictEqual(w.blanks.map((b) => b.id), ['w:bl-001', 'w:bl-002', 'w:bl-004']);
});

t('합칠 게 없으면 아무것도 안 건드린다', () => {
  const w = { blanks: [bl('w:bl-001', 'overview.갈래', '□□시', ['자유']), bl('w:bl-002', 'overview.제재', '□□', ['구두'])] };
  const r = mergeBlanks(w);
  assert.strictEqual(r.merged, 0);
  assert.strictEqual(w.blanks.length, 2);
  assert.strictEqual(w.blanks[0].alts, undefined);
});

t('기호 앵커는 정본 표기로 맞춘다 — 같은 시가 자료마다 다르게 조판돼 있다', () => {
  const w = { text: { stanzas: [{ no: 1, lines: ['닻을 내리고 쉬고 있다 우리 집 현관에서', '아빠 구두는 통통배'] }] } };
  /* 그대로 있으면 손대지 않는다 */
  assert.strictEqual(reanchor(w, '아빠 구두는 통통배'), '아빠 구두는 통통배');
  /* 띄어쓰기만 다르면 정본 표기를 돌려준다 */
  assert.strictEqual(reanchor(w, '있다우리 집 현관에서'), '있다 우리 집 현관에서');
  /* 본문에 아예 없으면 null — 조용히 지우지 않고 사람에게 넘기라는 뜻 */
  assert.strictEqual(reanchor(w, '없는 구절이다'), null);
  assert.strictEqual(reanchor(w, ''), null);
  /* 산문(문단)에서도 된다 */
  const prose = { text: { paragraphs: ['그는 천천히 걸어 나갔다.'] } };
  assert.strictEqual(reanchor(prose, '천천히걸어'), '천천히 걸어');
});

t('작품 id 는 머리말 좌표에서 기계적으로 나온다 — 한글은 팩 id 문자셋에 못 들어간다', () => {
  assert.strictEqual(workIdFor('1-1.(2)비린내라뇨!', 0), 'w-1-1-2');
  assert.strictEqual(workIdFor('2-3.(1)어떤 시', 5), 'w-2-3-1');
  assert.strictEqual(workIdFor('좌표 없는 제목', 4), 'w-05');
  assert.ok(/^[A-Za-z0-9-]+$/.test(workIdFor('1-1.(2)비린내라뇨!', 0)));
});


/* ── 지문 세트 살리기 ──
   추출기는 자기 파일만 본다. 폴더 전체를 보는 병합기만 할 수 있는 일을 여기서 건다. */
const res = (series, out) => [{ series, out }];
const pendSet = (setId, works, why) => ({ kind: 'set', setId, why: why || 'workId 를 못 찾은 작품이 있다', works });

t('제목은 있는데 이해완성이 없는 작품 — 정본 없는 작품으로 세우고 지문은 발췌로 담는다', () => {
  const works = [{ workId: 'w-1-1-1', title: '저녁 노을', hasCanon: true, text: { stanzas: [{ no: 1, lines: ['가'] }] } }];
  const results = res('danwon', { sets: [], review: {
    pending: [pendSet('s-01', [{ label: '(가)', title: '저녁 노을' }, { label: '(나)', title: '산버들 가리어', author: '홍랑' }])],
    candidates: [{ kind: 'setText', setId: 's-01', label: '(나)', title: '산버들 가리어', author: '홍랑',
      lines: ['첫 행', '둘째 행', '셋째 행'] }] } });
  const r = resolveSets(results, works);
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.added[0].title, '산버들 가리어');
  const stub = works.filter((w) => w.workId === r.added[0].workId)[0];
  assert.strictEqual(stub.hasCanon, false, '정본이 없다는 사실을 숨기면 안 된다');
  assert.deepStrictEqual(stub.blanks, []);
  /* 세트가 살아났고, 정본 없는 작품의 지문은 세트가 들고 있다 */
  const set = results[0].out.sets[0];
  assert.strictEqual(set.setId, 's-01');
  const ref = set.works.filter((w) => w.workId === stub.workId)[0];
  assert.strictEqual(ref.kind, 'excerpt', 'full 이면 정본에서 가져다 쓰는데 정본이 없어 화면이 빈다');
  assert.deepStrictEqual(ref.text.stanzas[0].lines, ['첫 행', '둘째 행', '셋째 행']);
  /* 정본이 있는 쪽은 그대로 full 이다 — 본문을 두 번 담지 않는다 */
  assert.strictEqual(set.works.filter((w) => w.workId === 'w-1-1-1')[0].kind, 'full');
  assert.strictEqual(results[0].out.review.pending.length, 0);
});

t('제목 없는 발췌는 그 자료의 발췌 작품이 하나뿐일 때만 귀속한다 — 아니면 추론하지 않는다', () => {
  const mk = (titles) => res('seosul', { sets: [], review: {
    pending: [
      pendSet('s-01', titles.map((t2, i) => ({ label: '', title: t2, kind: 'excerpt',
        text: { paragraphs: ['본문 ' + i] } }))),
      pendSet('s-02', [{ label: '', title: '', kind: 'excerpt', text: { paragraphs: ['제목 없는 발췌'] } }],
        '제목·작가가 지면에 인쇄돼 있지 않다'),
    ], candidates: [] } });

  /* 후보가 하나 → 귀속하고 검수 표시를 남긴다 */
  const one = mk(['축구공과 응원 봉']);
  const w1 = [];
  const r1 = resolveSets(one, w1);
  assert.strictEqual(r1.inferred.length, 1);
  assert.strictEqual(r1.inferred[0].title, '축구공과 응원 봉');
  assert.strictEqual(one[0].out.sets.length, 2, '제목 없는 세트도 살아나야 한다');

  /* 후보가 둘 → 추론하지 않고 그대로 검수로 */
  const two = mk(['축구공과 응원 봉', '다른 소설']);
  const w2 = [];
  const r2 = resolveSets(two, w2);
  assert.strictEqual(r2.inferred.length, 0, '후보가 여럿이면 찍지 않는다');
  assert.strictEqual(two[0].out.sets.length, 1);
  assert.ok(r2.stillPending.some((p) => p.setId === 's-02'));
});

t('본문이 없는 발췌는 못 살린다 — 지문 없는 지문 세트를 만드느니 검수로 넘긴다', () => {
  const results = res('danwon', { sets: [], review: {
    pending: [pendSet('s-01', [{ label: '(가)', title: '없는 작품', kind: 'excerpt' }])], candidates: [] } });
  const works = [];
  const r = resolveSets(results, works);
  assert.deepStrictEqual(results[0].out.sets, []);
  assert.ok(r.stillPending.some((p) => p.setId === 's-01'));
});

t('제목 생략 본문은 다른 파일의 본문과 유일하게 일치할 때만 잇는다', () => {
  const lines = ['창문을 열자 파란 종이배가 하늘로 날아갔다', '나는 그 배에 오늘의 약속을 하나씩 적었다'];
  const results = [{ series: 'danwon', out: { sets: [], review: {
    pending: [pendSet('s-01', [{ label: '(가)', title: '' }])],
    candidates: [{ kind: 'setText', setId: 's-01', label: '(가)', lines }] } } },
    { series: 'seosul', out: { review: { candidates: [{ kind: 'setText', title: '(가) 종이배 약속', body: lines }] } } }];
  const works = [];
  const r = resolveSets(results, works);
  assert.strictEqual(r.inferred[0].title, '종이배 약속');
  assert.strictEqual(results[0].out.sets[0].works[0].kind, 'excerpt');
  assert.deepStrictEqual(results[0].out.sets[0].works[0].text.stanzas[0].lines, lines);
  const ambiguous = structuredClone(results);
  ambiguous[0].out.sets = [];
  ambiguous[0].out.review.pending = [pendSet('s-01', [{ label: '(가)', title: '' }])];
  ambiguous[1].out.review.candidates.push({ kind: 'setText', title: '다른 제목', body: lines });
  assert.strictEqual(resolveSets(ambiguous, []).inferred.length, 0, '같은 본문에 제목이 둘이면 추측하면 안 된다');
});

t('시의 제목을 모른다고 유일한 소설에 붙이지 않는다', () => {
  const results = res('danwon', { sets: [], review: {
    pending: [pendSet('s-01', [{ title: '창작 소설', kind: 'excerpt', text: { paragraphs: ['소설 본문'] } }]),
      pendSet('s-02', [{ title: '', kind: 'full' }])],
    candidates: [{ kind: 'setText', setId: 's-02', lines: ['짧은 시의 행'] }] } });
  const r = resolveSets(results, []);
  assert.ok(r.stillPending.some((p) => p.setId === 's-02'));
});

t('여러 객관식 상품과 서술형 회차의 id를 가르고 미지원·손상 파일은 경고로 넘긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-multi-'));
  const sp = (x, text, size = 9.1, color = '#000000') => ({ x, text, size, color, w: Math.min(text.length * 8, 200) });
  const ln = (y, ...spans) => ({ y, spans });
  const pg = (no, lines) => ({ no, width: 595, height: 842, lines });
  const fixture = (series, essay) => ({ pages: [pg(1, [ln(45, sp(60, '[' + series + ']')),
    ln(100, sp(60, '※ 다음 글을 읽고 물음에 답하시오.', 7.9)),
    ln(125, sp(150, '별의 약속')), ln(145, sp(253, '윤여름')),
    ln(170, sp(70, '저녁 창가에서 별에게 편지를 쓴다')),
    ln(300, sp(60, '1.', 13.7, '#191919')), ln(306, sp(86, '이 글의 마음을 고르시오.')),
    ...(essay ? [] : ['① 빛', '② 창', '③ 별', '④ 길', '⑤ 밤'].map((text, n) => ln(340 + n * 20, sp(70, text))))]),
    pg(2, essay ? [ln(100, sp(66, '1)', 7.9)), ln(120, sp(66, '모범 답안', 7, '#3e88ab')),
      ln(140, sp(66, '별을 기다리는 마음이다.', 7.9))] : [ln(100, sp(66, '1) [정답] ③', 7.9)),
      ln(120, sp(66, '[해설] 창작 근거이다.', 7.9))])] });
  try {
    fs.writeFileSync(path.join(dir, '_meta.txt'), 'revision: 2022\nscope: unit7\n');
    const docs = [fixture('단원집중'), fixture('단원집중'), fixture('최다빈출 공략'), fixture('서술형 공략', true), fixture('서술형 공략', true)];
    docs.forEach((doc, i) => fs.writeFileSync(path.join(dir, 'file' + i + '.json'), JSON.stringify(doc)));
    const concept = { pages: [pg(1, [ln(45, sp(60, '중3 국어 1-1.별의 약속')),
      ln(90, sp(60, '이해 전략 핵심 내용을 파악하자!!')),
      ln(120, sp(40, '주제'), sp(120, '기다림', 9.1, '#ffffff'))])] };
    fs.writeFileSync(path.join(dir, 'concept.json'), JSON.stringify(concept));
    fs.writeFileSync(path.join(dir, 'unsupported.json'), JSON.stringify({ pages: [pg(1, [ln(45, sp(60, '[새로운워크북]'))])] }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    fs.writeFileSync(path.join(dir, 'not-spans.json'), 'null');
    const result = buildPack(dir);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.review.skipped.length, 3);
    assert.ok(result.warns.some((w) => w.includes('앱에 아직 안 들어가는 자료 3개')));
    assert.strictEqual(result.pack.items.length, 3);
    const canon = result.pack.works.find((w) => w.title === '별의 약속');
    assert.strictEqual(canon.hasCanon, true);
    assert.ok(canon.blanks.length);
    assert.ok(canon.text.stanzas[0].lines.length, '전문이 없는 개념 자료의 읽기 화면을 비워 두면 안 된다');
    assert.strictEqual(canon.textSource.kind, 'excerpt');
    assert.strictEqual(result.review.reconstructedTexts.length, 1);

    assert.ok(result.pack.items.some((i) => i.source.series === '최다빈출 공략'));
    const draftItems = result.review.pending.filter((p) => p.kind === 'item').map((p) => p.item);
    assert.strictEqual(draftItems.length, 2);
    const ids = result.pack.items.concat(draftItems).map((i) => i.id);
    assert.strictEqual(new Set(ids).size, 5);
    assert.ok(ids.every((id) => id.includes('-unit7-f')));
    assert.strictEqual(new Set(result.pack.sets.map((set) => set.setId)).size, result.pack.sets.length);
    assert.ok(result.pack.items.every((i) => result.pack.sets.some((set) => set.setId === i.setId)));
    assert.ok(!('pending' in result.pack) && !('skipped' in result.pack));
    const conceptCli = spawnSync(process.execPath, ['naesin-ko/extract/build-ihae.mjs', path.join(dir, 'concept.json')], { encoding: 'utf8' });
    assert.strictEqual(conceptCli.status, 0, conceptCli.stderr);
    assert.strictEqual(JSON.parse(conceptCli.stdout).work.title, '별의 약속');
    const mcCli = spawnSync(process.execPath, ['naesin-ko/extract/build-danwon.mjs', path.join(dir, 'file2.json')], { encoding: 'utf8' });
    assert.strictEqual(mcCli.status, 0, mcCli.stderr);
    assert.strictEqual(JSON.parse(mcCli.stdout).items[0].source.series, '최다빈출 공략');

  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('재실행에서 빠진 JSON은 팩에서 빼되 검수 쪽에 보존한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-rerun-'));
  try {
    writePack(dir, { meta: { packId: 'fixture' }, works: [{ workId: 'w-old', _workKey: '임시', title: '옛 작품' }],
      sets: [{ setId: 's-old' }], items: [{ id: 'q-old' }] }, {});
    writePack(dir, { meta: { packId: 'fixture' }, works: [{ workId: 'w-new', _workKey: '임시', title: '새 작품' }], sets: [], items: [] }, {});
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'pack/works')), ['w-new.json']);
    assert.ok(!fs.existsSync(path.join(dir, 'pack/items.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'pack/sets.json')));
    assert.ok(!('_workKey' in JSON.parse(fs.readFileSync(path.join(dir, 'pack/works/w-new.json'))).work));
    const review = JSON.parse(fs.readFileSync(path.join(dir, 'review/review.json')));
    assert.strictEqual(review.previousFiles.length, 3);
    review.previousFiles.forEach((f) => assert.ok(fs.existsSync(path.join(dir, 'review', f))));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('세트 기호는 실제 발췌에 유일하게 있는 구절의 작품에 연결한다', () => {
  const byId = { a: { text: { paragraphs: ['공통 구절과 정본 A'] } }, b: { text: { paragraphs: ['다른 정본 B'] } } };
  const set = { works: [{ workId: 'a', kind: 'full' },
    { workId: 'b', kind: 'excerpt', text: { paragraphs: ['새로운 발췌 구절과 공통 구절'] } }] };
  const fixed = reanchorSetMark(set, byId, { symbol: '㉠', workId: '', anchorText: '새로운발췌 구절' });
  assert.strictEqual(fixed.workId, 'b');
  assert.strictEqual(fixed.anchorText, '새로운 발췌 구절');
  assert.strictEqual(reanchorSetMark(set, byId, { symbol: '㉠', anchorText: '공통 구절' }), null);
  assert.strictEqual(reanchorSetMark(set, byId, { symbol: '㉠', workId: 'a', anchorText: '새로운 발췌 구절' }), null);
});

t('새 네 상품을 폴더에서 자동 판별하고 기존 mc5·ox 계약으로 합친다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-practice-'));
  try {
    const docs = [basicFixture('실력완성'), basicFixture('대표유형'), puriFixture('solution'), puriFixture('concept2')];
    docs.forEach((doc, i) => fs.writeFileSync(path.join(dir, 'fixture' + i + '.json'), JSON.stringify(doc)));
    fs.writeFileSync(path.join(dir, '_meta.txt'), 'revision: 2022\n');
    const result = buildPack(dir);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.review.skipped, []);
    assert.deepStrictEqual(result.review.dropped, []);
    assert.strictEqual(result.pack.items.length, 16);
    assert.strictEqual(result.review.pending.filter((p) => p.kind === 'item').length, 2);
    assert.strictEqual(new Set(result.pack.items.map((i) => i.id)).size, result.pack.items.length);
    assert.strictEqual(new Set(result.pack.sets.map((s) => s.setId)).size, result.pack.sets.length);
    assert.deepStrictEqual(new Set(result.pack.items.map((i) => i.source.series)),
      new Set(['실력완성', '대표유형', '풀이완성', '개념완성 step2.풀이전략']));
    assert.deepStrictEqual(PC.checkPack({ ...result.pack.meta, works: result.pack.works, sets: result.pack.sets, items: result.pack.items }).errors, []);
    assert.ok(!('files' in result.pack) && !('candidates' in result.pack));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\nOK — ${passed}개 통과. 병합기는 자료 하나만 봐서는 못 하는 것을 한다.`);
