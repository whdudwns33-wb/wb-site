'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PREVIEW = require('./preview.js');
const S = require('./strings.js');
const M = require('./mastery.js');
const P = require('./plan.js');
const atoms = require('./atoms.json');
const own = require('./pack-sample.json');
const facts = require('./facts.json');
const post = body => ({ method: 'POST', body: JSON.stringify(body) });
let count = 0;
async function t(name, fn) { await fn(); count++; console.log('통과:', name); }
(async () => {
  await t('홈은 날짜가 지나도 잠기지 않고 세 과목 예시와 오늘 답안지를 제공', async () => {
    const session = PREVIEW.create(), { plan } = await session.api('/plan'), { today } = await session.api('/today');
    assert.equal(plan.locked, false);
    assert.equal(plan.retro, true);
    assert.equal(plan.notice, facts.notice);
    assert.equal(plan.phase.phase, 'p4');
    assert.equal(plan.days[0].d, P.kstDate(Date.now()));
    assert.equal(plan.days[0].subjects.length, 1);
    assert.equal(today.slots.length, 3);
    assert.deepEqual(today.slots.map(s => s.atomId), ['k-dev-pattern', 'm-frac-div', 'e-vocab-300']);
    assert.ok(today.slots.every(s => s.source === 'pack' && s.packId.startsWith('haru-preview-') && s.n === 3));
  });
  await t('16코어 이름은 정본과 같고 예시 지도에 네 상태를 표시', async () => {
    const session = PREVIEW.create(), listed = await session.api('/atoms'), { state } = await session.api('/state');
    assert.deepEqual(listed.core, atoms.coreByPhase.p2);
    for (const a of listed.atoms) {
      const actual = atoms.atoms.find(x => x.id === a.id);
      assert.equal(a.label, actual.label);
      assert.equal(a.subject, actual.subject);
      assert.equal(a.carryTo, actual.carryTo);
    }
    assert.deepEqual(new Set(listed.atoms.map(a => M.grade(state.atoms[a.id], a, Date.now()))), new Set(['unknown', 'hole', 'shaky', 'fluent']));
  });
  await t('자체 팩 네 문항으로 러너·새 문항 반증을 제공하며 정답 제거', async () => {
    const session = PREVIEW.create();
    for (const sub of ['kor', 'math', 'eng']) {
      const { pack } = await session.api('/pack?id=haru-preview-' + sub);
      assert.equal(pack.origin, 'own');
      assert.match(pack.source, /자체 창작/);
      assert.equal(pack.subject, sub);
      assert.equal(pack.items.length, 4);
      assert.equal(new Set(pack.items.map(q => q.instructionKo)).size, 4);
      assert.ok(pack.items.every(q => !('answerKey' in q) && !('explanationKo' in q) && q.choices.length === 4));
      assert.deepEqual(S.findForbidden(JSON.stringify(pack), 'student'), []);
    }
    const { pack } = await session.api('/pack?id=haru-preview-kor');
    assert.equal(pack.passages[0].textKo, own.passages[0].textKo);
    assert.equal(pack.items[0].instructionKo, own.items[0].instructionKo);
    assert.deepEqual(pack.items[0].choices, own.items[0].choices.map(c => ({ key: c.key, text: c.text })));
  });
  await t('예시 선택 비교만 수행하고 정답·다른 답·모름 결과를 기존 형태로 반환', async () => {
    const session = PREVIEW.create();
    for (const [subject, answers] of [['kor', ['2', '3', '1', '2']], ['math', ['1', '1', '1', '3']], ['eng', ['2', '3', '1', '4']]]) {
      for (const [i, correct] of answers.entries()) {
        const ref = { packId: 'haru-preview-' + subject, no: i + 1 };
        const good = await session.api('/answer', post({ ...ref, picked: correct }));
        assert.equal(good.result.ok, true);
        assert.equal(good.result.answerKey, correct);
        assert.equal(good.result.cause, null);
        assert.ok(good.result.explanationKo);
        assert.ok(good.result.item.atomId);
        for (const picked of [correct === '4' ? '3' : '4', 'skip']) {
          const other = await session.api('/answer', post({ ...ref, picked }));
          assert.equal(other.result.ok, false);
          assert.equal(other.result.cause, 'gap');
        }
        assert.deepEqual(S.findForbidden(JSON.stringify(good.result), 'student'), []);
      }
    }
    const probe = await session.api('/probe', post({ packId: 'haru-preview-math', no: 4, picked: 'skip' }));
    assert.equal(probe.cause, 'gap');
    assert.ok((await session.api('/cue?packId=haru-preview-math&no=4')).cue.text);
  });
  await t('답안지·제출·회고·보호자 응답은 예시 값만 반환', async () => {
    const session = PREVIEW.create(), { sheet } = await session.api('/sheet?keyId=haru-preview-sheet');
    assert.equal(sheet.n, 5);
    assert.equal(sheet.timeLimitSec, 2400);
    assert.ok(!('answer' in sheet));
    assert.equal((await session.api('/attempt', post({ kind: 'single', periods: [{ marks: {} }] }))).accepted, true);
    const { retro } = await session.api('/retro');
    assert.equal(retro.sat, 2);
    assert.equal(retro.numbersOpen, false);
    assert.ok(!('gained' in retro));
    const parent = session.parent();
    assert.equal(parent.dist, null);
    assert.equal(parent.milestones.filter(m => /고사장 입실/.test(m.text)).length, 1);
    assert.deepEqual(S.findForbidden(JSON.stringify(parent), 'parent'), []);
    assert.equal(parent.notice, facts.notice);
  });
  await t('응답 변경이 원본·다른 세션을 덮지 않으며 쓰기는 메모리 세션에만', async () => {
    const a = PREVIEW.create(), b = PREVIEW.create();
    const read = await a.api('/state'); read.state.days = {}; read.state.atoms = {};
    assert.equal(Object.keys((await a.api('/state')).state.days).length, 2);
    await a.api('/state', { method: 'PUT', body: JSON.stringify({ state: { days: {} } }) });
    assert.equal(Object.keys((await a.api('/state')).state.days).length, 0);
    assert.equal(Object.keys((await b.api('/state')).state.days).length, 2);
    const p = a.parent(); p.milestones[0].text = '변경';
    assert.equal(a.parent().milestones[0].text, '고사장 입실 마감');
    const pack = (await a.api('/pack?id=haru-preview-eng')).pack; pack.items[0].choices[0].text = '변경';
    assert.equal((await b.api('/pack?id=haru-preview-eng')).pack.items[0].choices[0].text, '연필');
  });
  await t('없는 기능·운영 팩·문항·잘못된 입력은 거절하고 폴백하지 않음', async () => {
    const session = PREVIEW.create();
    for (const [url, opt] of [
      ['/admin/students'], ['/gen?atomId=m-frac-div&seed=1'], ['/pack?id=haru-sample-kor-p01'],
      ['/answer', post({ packId: 'haru-preview-kor', no: 999, picked: '1' })],
      ['/answer', post({ packId: 'haru-preview-kor', no: 1, picked: '9' })],
      ['/plan', { method: 'POST' }], ['/state', { method: 'PUT', body: '{' }],
      ['/state', { method: 'PUT', body: 'null' }], ['/state', { method: 'PUT', body: '[]' }],
      ['/sheet?keyId=운영-회차'], ['/attempt', post({ kind: 'full', periods: [] })]
    ]) await assert.rejects(session.api(url, opt));
  });
  await t('브라우저 통신·인증·스토리지·서비스 워커 없이 독립 실행', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'preview.js'), 'utf8');
    const denied = name => { throw new Error(name + ' 사용 금지'); };
    const future = Date.parse('2030-02-01T23:30:00Z');
    const context = vm.createContext({ URLSearchParams, Date: class extends Date { static now() { return future; } },
      fetch: () => denied('통신'), localStorage: new Proxy({}, { get: () => denied('스토리지') }),
      navigator: new Proxy({}, { get: () => denied('서비스 워커') }) });
    vm.runInContext(source, context);
    const session = vm.runInContext('WBHARU_PREVIEW.create()', context);
    const { plan } = await session.api('/plan');
    assert.equal(plan.locked, false);
    assert.equal(plan.days[0].d, '2030-02-02');
    for (const url of ['/plan', '/atoms', '/state', '/today', '/pack?id=haru-preview-kor', '/retro', '/sheet?keyId=haru-preview-sheet']) await session.api(url);
    await session.api('/answer', post({ packId: 'haru-preview-kor', no: 1, picked: '2' }));
    await session.api('/probe', post({ packId: 'haru-preview-kor', no: 2, picked: 'skip' }));
    await session.api('/attempt', post({ kind: 'single', periods: [{}] }));
    assert.ok(session.parent().name);
  });
  console.log('검토용 샘플:', count, '개 통과');
})().catch(error => { console.error(error); process.exitCode = 1; });
