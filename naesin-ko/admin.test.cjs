'use strict';
/* 실제 관리 웹 코드를 가짜 DOM·fetch로 눌러 본다. 운영 청소·망 호출은 하지 않는다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RENDER = require('./render.js');
const html = fs.readFileSync(path.join(__dirname, '../reading-server/public/naesin-ko-admin.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function page() {
  const elements = new Map(), calls = [], replies = [];
  class Element {
    constructor(id, tag, attrs) {
      this.id = id; this.tag = tag; this.value = decode((attrs.match(/\bvalue="([^"]*)"/) || [0, ''])[1]);
      this.disabled = /\bdisabled\b/.test(attrs); this.checked = /\bchecked\b/.test(attrs); this.textContent = '';
    }
    set innerHTML(value) {
      this._html = value;
      if (this.id === 'app') {
        for (const id of elements.keys()) if (!['app', 'btnLogout', 'sheet'].includes(id)) elements.delete(id);
        for (const m of value.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(m[3], new Element(m[3], m[1], m[2]));
        for (const m of value.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) elements.get(m[1]).innerHTML = m[2];
      }
      if (this.tag === 'select') {
        const option = value.match(/<option\b([^>]*)>([\s\S]*?)<\/option>/);
        this.value = option ? decode((option[1].match(/\bvalue="([^"]*)"/) || [0, option[2]])[1]) : '';
      }
    }
    get innerHTML() { return this._html || ''; }
    addEventListener() {}
  }
  ['app', 'btnLogout', 'sheet'].forEach((id) => elements.set(id, new Element(id, 'div', '')));
  const storage = new Map();
  const context = vm.createContext({
    window: {}, document: { querySelector: (s) => elements.get(s.slice(1)) || null, querySelectorAll: () => [] },
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    WBAdminLogin: { mount() {} }, WBKORENDER: RENDER,
    confirm: () => true,
    fetch: async (url, opt) => {
      calls.push({ url, opt });
      assert.ok(replies.length, '응답 없는 fetch: ' + url);
      return typeof replies[0] === 'function' ? replies.shift()() : replies.shift();
    }
  });
  vm.runInContext(script, context);
  vm.runInContext("TOKEN = 'admin-token'; PACKS = ['own']; render();", context);
  return { context, calls, replies, el: (id) => elements.get(id),
    reply: (body, status = 200) => replies.push({ ok: status < 400, status, json: async () => body }) };
}

const counts = { dryRun: true, records: 9, touched: 2, labels: 3 };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve: (body, status = 200) => resolve({ ok: status < 400, status, json: async () => body }) };
};
let passed = 0;
async function t(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }

const pack = {
  packId: 'own', works: [{
    workId: 'w', title: '자체 창작 <작품>', author: 'WB',
    text: { stanzas: [{ lines: ['우리 창가에 나무가 선다'] }] },
    marks: [{ symbol: '㉠', anchorText: '나무' }],
    lineNotes: [{ anchor: '나무', note: '날개 <풀이>' }],
    composition: [{ range: '1연', summary: '연별 <내용>' }],
    structureMap: { center: '나무', branches: [{ category: '구조', children: ['관찰', '성찰'] }] },
    blanks: [{ id: 'own-1', label: '주제' }]
  }, { workId: 'other', title: '다른 작품' }],
  sets: [{ setId: 'set-own', works: [{ workId: 'w', text: { paragraphs: ['발췌 속 나무'] } }],
    marks: [{ workId: 'w', symbol: '㉡', anchorText: '나무' }] },
  { setId: 'unrelated', works: [{ workId: 'other' }] }]
};
const overlay = {
  notes: [{ workId: 'w', text: '학교 <강조>' }, { workId: 'other', text: '남의 강조' }],
  overrides: [{ targetRef: 'b-own-1', answers: ['성찰'], note: '학교 <해석>' },
    { targetRef: 'b-other', answers: ['표시하면 안 됨'] }]
};

(async () => {
  await t('세어 보기 성공 전에는 POST가 없고, 삭제 확인을 취소하면 기록을 건드리지 않는다', async () => {
    const p = page();
    assert.ok(p.el('btnScrubRun').disabled);
    await p.el('btnScrubRun').onclick();
    assert.equal(p.calls.length, 0);
    p.reply(counts);
    await p.el('btnScrubCount').onclick();
    assert.equal(p.calls[0].url, '/api/naesin-ko/admin/scrub');
    assert.equal(p.calls[0].opt.headers.Authorization, 'Bearer admin-token');
    assert.ok(!p.el('btnScrubRun').disabled);
    assert.match(p.el('scrubMsg').textContent, /발문 3개/);
    let warning;
    p.context.confirm = (msg) => { warning = msg; return false; };
    await p.el('btnScrubRun').onclick();
    assert.match(warning, /되돌릴 수 없습니다/);
    assert.equal(p.calls.length, 1);
    assert.ok(!p.el('btnScrubRun').disabled);
  });

  await t('POST 성공·실패 뒤에는 다시 세어야 하며 중복 실행은 막는다', async () => {
    const p = page();
    p.reply(counts); await p.el('btnScrubCount').onclick();
    const pending = deferred(); p.replies.push(() => pending.promise);
    const run = p.el('btnScrubRun').onclick();
    assert.ok(p.el('btnScrubRun').disabled && p.el('btnScrubCount').disabled);
    await p.el('btnScrubRun').onclick();
    assert.equal(p.calls.length, 2);
    pending.resolve({ ...counts, dryRun: false }); await run;
    assert.equal(p.calls[1].opt.method, 'POST');
    assert.match(p.el('scrubMsg').textContent, /청소 완료/);
    assert.ok(p.el('btnScrubRun').disabled && !p.el('btnScrubCount').disabled);
    p.reply(counts); await p.el('btnScrubCount').onclick();
    p.reply({ error: '저장 실패' }, 500); await p.el('btnScrubRun').onclick();
    assert.match(p.el('scrubMsg').textContent, /일부는 이미 지워졌을 수/);
    assert.ok(p.el('btnScrubRun').disabled && !p.el('btnScrubCount').disabled);
  });

  await t('403·망 오류·잘못된 카운트·대상 없음으로는 삭제 버튼이 열리지 않는다', async () => {
    const p = page();
    p.reply({ error: 'forbidden' }, 403); await p.el('btnScrubCount').onclick();
    assert.match(p.el('scrubMsg').textContent, /관리 권한/);
    p.replies.push(() => Promise.reject(new Error('네트워크 실패'))); await p.el('btnScrubCount').onclick();
    assert.match(p.el('scrubMsg').textContent, /네트워크 실패/);
    p.reply({ ...counts, labels: '3' }); await p.el('btnScrubCount').onclick();
    assert.match(p.el('scrubMsg').textContent, /결과를 확인하지 못/);
    p.reply({ dryRun: true, records: 1, touched: 0, labels: 0 }); await p.el('btnScrubCount').onclick();
    assert.match(p.el('scrubMsg').textContent, /지울 발문이 없/);
    assert.ok(p.el('btnScrubRun').disabled && !p.el('btnScrubCount').disabled);
  });

  await t('새로고침과 로그아웃 뒤 도착한 옛 카운트는 삭제를 허용하지 않는다', async () => {
    const p = page(), pending = deferred();
    p.replies.push(() => pending.promise);
    const count = p.el('btnScrubCount').onclick();
    p.reply({ students: [] }); p.reply({ packs: ['own'] }); p.reply({ reviews: [] });
    await p.context.refresh();
    pending.resolve(counts); await count;
    assert.ok(p.el('btnScrubRun').disabled);
    p.reply(counts); await p.el('btnScrubCount').onclick();
    assert.ok(!p.el('btnScrubRun').disabled);
    p.el('btnLogout').onclick();
    vm.runInContext("TOKEN = 'next-admin'; render();", p.context);
    await p.el('btnScrubRun').onclick();
    assert.ok(p.el('btnScrubRun').disabled);
    assert.equal(p.calls.filter((c) => c.opt.method === 'POST').length, 0);
  });

  await t('옛 토큰의 늦은 401은 새 로그인을 지우지 않고 현재 토큰의 401만 재로그인시킨다', async () => {
    const p = page(), pending = deferred();
    p.replies.push(() => pending.promise);
    const old = p.el('btnScrubCount').onclick();
    p.el('btnLogout').onclick();
    vm.runInContext("TOKEN = 'next-admin'; render();", p.context);
    pending.resolve({ error: 'old token expired' }, 401); await old;
    assert.equal(vm.runInContext('TOKEN', p.context), 'next-admin');
    assert.ok(p.el('btnScrubRun').disabled);
    p.reply({ error: 'current token expired' }, 401); await p.el('btnScrubCount').onclick();
    assert.equal(vm.runInContext('TOKEN', p.context), null);
    assert.ok(p.el('loginHost'));
  });

  await t('지문 보드는 공용 렌더러로 본문·기호·구조를 그리고 강조와 토글을 분리한다', async () => {
    const p = page();
    p.reply({ pack }); p.reply({ overlay }); await p.el('btnBoardLoad').onclick();
    assert.equal(p.calls[0].url, '/api/naesin-ko/pack?id=own');
    assert.equal(p.calls[1].url, '/api/naesin-ko/admin/overlay?scope=default');
    let out = p.el('boardOut').innerHTML;
    ['우리 창가', '㉠', '구조도', '성찰', 'school-note', '학교 &lt;강조&gt;', '학교 &lt;해석&gt;'].forEach((s) => assert.ok(out.includes(s), s));
    ['날개 &lt;풀이&gt;', '연별 &lt;내용&gt;', '남의 강조', '표시하면 안 됨', '<작품>'].forEach((s) => assert.ok(!out.includes(s), s));
    assert.ok(!p.el('boardSet').innerHTML.includes('unrelated'));
    p.el('boardWings').checked = true; p.el('boardWings').onchange();
    p.el('boardStanzas').checked = true; p.el('boardStanzas').onchange();
    out = p.el('boardOut').innerHTML;
    assert.ok(out.includes('날개 &lt;풀이&gt;') && out.includes('연별 &lt;내용&gt;'));
    p.el('boardSet').value = 'set-own'; p.el('boardSet').onchange();
    out = p.el('boardOut').innerHTML;
    assert.ok(out.includes('발췌 속') && out.includes('㉡') && !out.includes('우리 창가'));
    assert.ok(out.includes('날개 &lt;풀이&gt;'));
    p.el('boardWork').value = 'other'; p.el('boardWork').onchange();
    assert.ok(!p.el('boardOut').innerHTML.includes('학교 &lt;강조&gt;'));
  });

  await t('지문 보드의 대상 변경·실패·늦은 응답은 옛 본문과 학교 강조를 남기지 않는다', async () => {
    const p = page(), pending = deferred();
    p.replies.push(() => pending.promise); p.reply({ overlay });
    const load = p.el('btnBoardLoad').onclick();
    p.el('boardScope').value = 'student'; p.el('boardScope').oninput();
    pending.resolve({ pack }); await load;
    assert.ok(p.el('boardWork').disabled && !p.el('btnBoardLoad').disabled);
    assert.ok(!p.el('boardOut').innerHTML.includes('우리 창가'));
    p.reply({ error: 'forbidden' }, 403); p.reply({ overlay }); await p.el('btnBoardLoad').onclick();
    assert.match(p.el('boardMsg').textContent, /관리 권한/);
    assert.ok(p.el('boardWork').disabled);
    p.reply({ pack: { works: [] } }); p.reply({ overlay: {} }); await p.el('btnBoardLoad').onclick();
    assert.match(p.el('boardOut').innerHTML, /표시할 작품이 없/);
    p.reply({ pack }); p.reply({ overlay }); await p.el('btnBoardLoad').onclick();
    p.el('boardPack').onchange();
    assert.ok(!p.el('boardOut').innerHTML.includes('학교 &lt;강조&gt;'));
    assert.ok(p.el('boardWork').disabled);
  });

  await t('학생별 강조가 없을 때만 반 공통을 쓰고 유효한 빈 강조는 그대로 따른다', async () => {
    const p = page();
    p.el('boardScope').value = 'st-1';
    p.reply({ pack }); p.reply({ overlay: {}, scope: 'st-1', found: false });
    p.reply({ overlay, scope: 'default', found: true }); await p.el('btnBoardLoad').onclick();
    assert.equal(p.calls[2].url, '/api/naesin-ko/admin/overlay?scope=default');
    assert.match(p.el('boardMsg').textContent, /학교 강조 default \(반 공통\)/);
    assert.match(p.el('boardOut').innerHTML, /학교 &lt;강조&gt;/);
    p.reply({ pack }); p.reply({ overlay: {}, scope: 'st-1', found: true });
    await p.el('btnBoardLoad').onclick();
    assert.equal(p.calls.length, 5, '빈 강조가 등록돼 있으면 default를 요청하지 않는다');
    assert.match(p.el('boardMsg').textContent, /학교 강조 st-1/);
    assert.ok(!p.el('boardOut').innerHTML.includes('학교 &lt;강조&gt;'));
  });
  console.log('OK — ' + passed + '개 통과');
})().catch((e) => { console.error(e); process.exitCode = 1; });
