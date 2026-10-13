'use strict';
/* 학생 화면 원본으로 계정 전환·구매팩 보관 금지·학원 연결 회수를 검사한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const inline = html.split('<script>')[1].split('</script>')[0];
const elementIds = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), match => match[1]));
for (const match of inline.matchAll(/(?:ttsBtnHtml|wireTtsBtn)\([^;\n]*,\s*'([^']+)'\)/g)) elementIds.add(match[1]);
elementIds.add('storedShortIn');elementIds.add('subBtn');elementIds.add('nextBtn');
const sample = require('./pack-sample.json');
const clone = value => JSON.parse(JSON.stringify(value));
const account = { code: 'ST1', token: 'self-created-token-1', name: '체험 학생' };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

function screen() {
  const store = new Map([['wbr.auth', JSON.stringify(account)]]), nodes = new Map();
  const documentEvents = new Map(), windowEvents = new Map(), timers = new Map(), requests = [];
  const voiceEngine = { voices: [], sent: [], cancels: 0, getVoices() { return this.voices; },
    speak(u) { this.sent.push(u); }, cancel() { this.cancels++; }, resume() {} };
  let nextTimer = 0, failLocalWrite = false, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  function node(id) {
    if (!elementIds.has(id)) return null;
    if (!nodes.has(id)) {
      const classes = new Set();
      const events = new Map();
      const selectors = new Map();
      nodes.set(id, { innerHTML: '', textContent: '', value: '', hidden: false, style: {}, dataset: {}, events,
        children: [], attrs:{}, appendChild(child) { this.children.push(child); },
        setAttribute(key,value){this.attrs[key]=String(value);},getAttribute(key){return Object.prototype.hasOwnProperty.call(this.attrs,key)?this.attrs[key]:null;},
        classList: { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value), toggle() {} },
        addEventListener: (type, fn) => events.set(type, fn), focus() {}, querySelector: selector => {
          if (!selectors.has(selector)) selectors.set(selector, { textContent: '',children:[],appendChild(child){this.children.push(child);} });return selectors.get(selector);
        }, querySelectorAll: () => [],
      });
    }
    return nodes.get(id);
  }
  const ctx = vm.createContext({
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => { if (failLocalWrite) throw new Error('quota'); store.set(key, value); }, removeItem: key => store.delete(key) },
    document: { getElementById: node, addEventListener: (type, fn) => documentEvents.set(type, fn), body: { style: {} }, contains: () => false,
      createElement: () => ({ textContent: '', attrs: {},setAttribute(key, value) { this.attrs[key] = value; },getAttribute(key) { return this.attrs[key]; },querySelector(){return node('nextBtn');},scrollIntoView(){},appendChild(){},addEventListener(){} }) },
    window: { addEventListener: (type, fn) => windowEvents.set(type, fn), speechSynthesis: voiceEngine },
    SpeechSynthesisUtterance: function (text) { this.text = text; }, navigator: {}, location: { reload() {} }, confirm: () => true,
    WBNAESIN: require('./engine.js'), WBGRADE: require('./grade.js'), WBGEN: require('./gen.js'), AbortController,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    fetch: async (url, opt) => { requests.push({ url, ...opt }); return fetchImpl(url, opt); },
  });
  const exportUi = `
  globalThis.ui={boot,api,checkAccount,checkAccess,stopStudy,clearPackCache,migrateLegacy,pullAdopt,pushState,persist,save,openDemo,renderItem,storedToRunner,wrongRetryItems,gradeItem,normalizeStoredAnswer,recoverStateStamps,loadDB,
    ttsOptions,wireTtsBtn,wireChunkWork,wireDialogueWork,wireSentenceWork,openPack,renderHeader,demoNotice,bootError,
    projector:(scope,pj)=>{liveScope=scope;liveState={projector:pj};pjApply(pj);},
    projectile:()=>({pjPick,pjSent,pjSeen}),
    addPack:(p,inRange)=>{PACKS[p.packId]=normPack(p);if(inRange)packList.push(p.packId);packDB(p.packId);},
    clock:now=>{Date.now=()=>now;},
    get:()=>({pack,PACKS,DB,studyStopped,pendingRemote}),
    setup:(a,p)=>{sessionCode=a.code;sessionToken=a.token;KEY='wbn.v1:'+a.code;DB={v:1,owner:a.code,packs:{},savedAt:100};
      pack=normPack(p);PACKS={[p.packId]:pack};packList=[p.packId];authed=true;demoMode=false;ensureStatesAll();},
    demo:()=>{sessionCode=null;sessionToken=null;KEY='wbn.v1:demo';DB={v:1,packs:{},savedAt:0};authed=false;},
    runner:value=>{RQ=value;},renderOff:()=>{render=function(){};}};`;
  assert.match(inline, /  boot\(\);/);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/voice.js'), 'utf8'), ctx);
  ctx.window.WBVoice = ctx.WBVoice;
  vm.runInContext(inline.replace('  boot();', exportUi), ctx);
  ctx.ui.setup(account, clone(sample));
  return { ...ctx.ui, store, node, requests, timers, documentEvents, windowEvents, voiceEngine, location: ctx.location,
    disableVoice: () => { ctx.SpeechSynthesisUtterance = undefined; },
    setFetch: fn => { fetchImpl = fn; }, failLocal: value => { failLocalWrite = value; }, changeAccount: a => store.set('wbr.auth', JSON.stringify(a)) };
}

(async () => {
  await t('철자 오답은 교정 대기에서 일반 다음을 숨기고, 복수 정답 채점·IME Enter·접근성 레이블을 유지한다', async () => {
    const start = inline.indexOf("if (!ok && item.type === 'spell')");
    const end = inline.indexOf("var nb = document.createElement('div');", start);
    assert.ok(start >= 0 && end > start, '오답 철자 교정 전용 가지가 일반 다음 버튼보다 앞에 있다');
    const correction = inline.slice(start, end);
    assert.match(correction, /gradeAnswer\(correctionInput\.value, item\.answers\)/);
    assert.match(correction, /교정 완료/);
    assert.match(correction, /aria-label', '정답 철자 다시 입력/);
    assert.match(correction, /e\.key === 'Enter' && !e\.isComposing/);
    assert.match(correction, /if \(RQ === q0 && RQ\.onGrade\) \{ RQ\.onGrade\(item, ok, answerKey, \{\}\); correctionRecorded = true; \}/, '정확한 교정 시 원래 오답만 1회 기록한다');
    assert.match(correction, /if \(correction\.getAttribute\('data-correct'\) === '1'\) \{ next\(\); return; \}/);
    const nextMatch = inline.match(/function next\(\) \{[\s\S]*?\n    \}/);
    const nextBody = nextMatch ? nextMatch[0] : '';
    assert.match(nextBody, /!correctionRecorded && RQ\.onGrade/, 'next avoids duplicate grade callback');
    assert.match(nextBody, /RQ\.i \+= 1; stepRunner\(\)/);
  });

  await t('저장형 주관식은 한 칸 답변·채점·오답 재시험 경로를 쓰고 잘못된 저장행은 건너뛴다', async () => {
    const ui=screen(),pack=clone(sample);pack.items=[{no:501,formatType:'short',instructionKo:'Write the missing word.',stimulus:{type:'text',parts:[{text:'The sky is blue.'}]},choices:[],answer:['A fully accepted answer'],answerCount:1,explanationKo:'자체 설명'}];ui.setup(account,pack);
    const converted=ui.storedToRunner(pack.items.concat([{no:502,formatType:'short',choices:[],answer:[]}])) ;assert.equal(converted.length,1);assert.equal(converted[0].type,'storedshort');assert.match(converted[0].prompt,/Write the missing word/);assert.match(converted[0].prompt,/The sky is blue/);
    assert.equal(ui.normalizeStoredAnswer(' A   fully accepted ANSWER '),ui.normalizeStoredAnswer('a fully accepted answer'));
    ui.gradeItem(converted[0],false,{},1700000000000,null);const retry=ui.wrongRetryItems(['i-501']);assert.equal(retry.length,1);assert.equal(retry[0].type,'storedshort');
    const root={innerHTML:''};ui.renderItem(retry[0],root);assert.match(root.innerHTML,/id="storedShortIn"/);assert.match(root.innerHTML,/id="subBtn"/);assert.match(root.innerHTML,/The sky is blue/);
    const grades=[];ui.runner({opts:{},i:0,items:[retry[0],retry[0]],onGrade:(item,ok)=>{grades.push(ok);ui.gradeItem(item,ok,{},1700000001000,null);}});
    ui.node('storedShortIn').value='  A fully accepted answer  ';ui.node('subBtn').onclick();ui.node('nextBtn').onclick();assert.deepEqual(grades,[true]);assert.equal(ui.get().DB.packs[pack.packId].wrong['i-501'].cleared,false);
  });

  await t('누적 관문은 passed/legacy 100%만 열고, 백지 통과·모의 즉시 다음 계약을 지킨다', async () => {
    assert.match(inline, /function cumRecordPassed\(record\)[\s\S]*?typeof record\.passed === 'boolean'[\s\S]*?record\.score === 100[\s\S]*?record\.okCount === record\.total[\s\S]*?record\.total > 0/);
    assert.match(inline, /open: i === 0 \? true : cumRecordPassed\(rec\[gs\[i - 1\]\.day\]\)/);
    assert.match(inline, /if \(!cumRecordPassed\(steps\[i\]\.rec\)\) break;/, '누적 카운트는 앞에서부터 연속 통과만 센다');
    assert.match(inline, /d\.okCount === targets\.length && d\.missingCount === 0 && d\.partialCount === 0 && d\.orderOk === true && !\(d\.extras \|\| \[\]\)\.length/);
    assert.match(inline, /passed: passed/, '각 시도에 명시 통과값을 저장한다');
    assert.match(inline, /\(passed \? 'good' : 'bad'\)/, '화면 통과 표시도 엄격한 passed 값만 사용한다');
    const start = inline.indexOf('function finishItem(');
    const mock = inline.indexOf('if (RQ.opts.mock)', start);
    const correction = inline.indexOf("if (!ok && item.type === 'spell')", start);
    assert.ok(start >= 0 && mock > start && correction > mock, '모의 분기는 철자 교정보다 먼저다');
    assert.match(inline.slice(mock, correction), /RQ\.i \+= 1; stepRunner\(\);\s*return;/, '모의 시험은 유형·정오답 무관하게 즉시 다음으로');
  });
  await t('localStorage 실패는 안내하고 서버 동기화 예약을 유지하며 다음 성공 때 로컬 오류를 해제한다', async () => {
    const ui = screen();
    ui.failLocal(true);
    assert.equal(ui.save(), false);
    assert.equal(ui.node('topBanner').textContent, '이 기기에 저장하지 못했어요. 서버 동기화를 확인하세요.');
    ui.persist();
    assert.ok(Array.from(ui.timers.values()).some(timer => timer.ms === 3000), '로컬 저장 실패에도 인증 서버 push 예약을 유지한다');
    assert.equal(ui.requests.length, 0, '실제 네트워크 요청은 하지 않는다');
    ui.failLocal(false);
    assert.equal(ui.save(), true);
    assert.equal(ui.node('topBanner').hidden, true, '로컬 저장 성공 시 로컬 오류 배너를 해제한다');
  });
  await t('체험·만료·학생 교대의 연동 링크는 영어 입구로 고정되고 늦은 이전 버튼은 새 인증을 지우지 않는다', async () => {
    const ui = screen();ui.demo();ui.renderOff();ui.setFetch(() => ({ json: async () => clone(sample) }));await ui.openDemo();
    assert.match(ui.demoNotice(), /href="\/\?app=naesin">학생 코드로 연동/);
    for (const changed of [false, true]) {
      const switched = screen(), savedKey = 'wbn.v1:' + account.code, before = '{"owner":"ST1","ownPractice":1}';
      switched.store.set(savedKey, before);
      if (changed) switched.changeAccount({ code: 'ST2', token: 'own-other-token' });
      switched.node('whoLine').onclick();
      assert.equal(switched.location.href, changed ? undefined : '/?app=naesin');
      assert.equal(switched.store.has('wbr.auth'), changed);assert.equal(switched.store.get(savedKey), before);
      const expired = screen();expired.bootError(new Error('api-401'));
      expired.store.set(savedKey, before);
      assert.match(expired.node('wrap').innerHTML, /href="\/\?app=naesin"/);
      if (changed) expired.changeAccount({ code: 'ST2', token: 'own-other-token' });
      expired.node('unlinkBtn').onclick();
      assert.equal(expired.store.has('wbr.auth'), changed);assert.equal(expired.location.href, changed ? undefined : '/?app=naesin');
      assert.equal(expired.store.get(savedKey), before);
    }
  });
  await t('학생 헤더는 과 번호 없는 팩에 Lundefined·Lnull을 붙이지 않고 교재와 실제 과 번호만 표시한다', () => {
    for (const lesson of [undefined, null, '', 6, '<own>']) {
      const ui = screen(), pack = { ...clone(sample), textbook: '자체 <교재>', lesson };
      ui.setup(account, pack);ui.renderHeader();
      const header = ui.node('whoLine').innerHTML;
      assert.match(header, /체험 학생/);assert.match(header, /자체 &lt;교재&gt;/);
      if (lesson == null || lesson === '') assert.ok(!/ L|Lundefined|Lnull/.test(header));
      else assert.ok(header.includes(lesson === 6 ? ' L6' : ' L&lt;own&gt;'));
      assert.ok(!header.includes('<own>'));assert.match(header, /다른 학생으로 연동/);
    }
  });

  await t('내신의 청크·대화·문장·러너·짝맞추기 듣기는 구매 자료의 원격 음성을 막고 로컬 영어만 쓴다', () => {
    const actions = [
      ui => { ui.wireChunkWork(sample.sentences[0].dayGroup);return () => ui.node('ckTts').onclick(); },
      ui => { ui.wireDialogueWork(sample.dialogues[0].id);return () => ui.node('dlgTts').onclick(); },
      ui => { ui.wireSentenceWork(sample.sentences[0].seq);return () => ui.node('ttsBtn').onclick(); },
      ui => { ui.wireTtsBtn({ ttsText: 'A toy is blue.' }, 'chTts');return () => ui.node('chTts').onclick(); },
      ui => { const root = ui.node('rBody');ui.renderItem({ type: 'ckmatch', pairs: [{ en: 'A toy', ko: '장난감' }] }, root);
        return () => root.querySelector('.pairs').onclick({ target: { closest: () => ({ disabled: false, hasAttribute: () => true, getAttribute: () => '0', classList: { add() {} } }) } }); },
    ];
    assert.equal((inline.match(/WBVoice\.(?:speak|speakSeq)\(/g) || []).length, actions.length);
    for (const action of actions) {
      const ui = screen(), before = JSON.stringify(ui.get().DB), remote = { lang: 'en-US', default: true, localService: false };
      const click = action(ui);ui.voiceEngine.voices = [remote];click();
      assert.equal(ui.voiceEngine.sent.length, 0);assert.match(ui.node('topBanner').textContent, /기기의 영어 음성 설정/);
      const local = { lang: 'en-GB', localService: true };ui.voiceEngine.voices = [remote, local];click();
      assert.equal(ui.voiceEngine.sent.length, 1);assert.equal(ui.voiceEngine.sent[0].voice, local);
      ui.voiceEngine.sent[0].onstart();assert.equal(ui.node('topBanner').hidden, true);
      assert.equal(JSON.stringify(ui.get().DB), before, '읽기 실패·성공은 학습 기록을 바꾸지 않는다');
    }
  });

  await t('체험은 기존 음성 선택을 유지하고 구매 자료의 엔진 미지원도 학생에게 알린다', async () => {
    const ui = screen();ui.demo();ui.renderOff();
    ui.setFetch(() => ({ json: async () => clone(sample) }));await ui.openDemo();
    const remote = { lang: 'en-US', default: true, localService: false };ui.voiceEngine.voices = [remote];
    ui.wireTtsBtn({ ttsText: 'A toy is blue.' }, 'chTts');ui.node('chTts').onclick();
    assert.equal(ui.ttsOptions().localOnly, false);assert.equal(ui.voiceEngine.sent[0].voice, remote);
    const unsupported = screen();unsupported.disableVoice();
    unsupported.voiceEngine.voices = [];unsupported.wireTtsBtn({ ttsText: 'A toy is blue.' }, 'chTts');unsupported.node('chTts').onclick();
    assert.equal(unsupported.voiceEngine.sent.length, 0);assert.match(unsupported.node('topBanner').textContent, /영어 읽기 음성/);
  });

  await t('체험 뒤 다른 교재를 열면 남은 체험 플래그로 구매 자료의 원격 음성을 허용하지 않는다', async () => {
    const ui = screen();ui.renderOff();ui.setFetch(() => ({ json: async () => clone(sample) }));await ui.openDemo();
    assert.equal(ui.ttsOptions().localOnly, false);
    const assigned = { ...clone(sample), packId: 'own-assigned-L1' };
    ui.addPack(assigned, true);ui.openPack(assigned, assigned.packId);
    ui.voiceEngine.voices = [{ lang: 'en-US', localService: false, default: true }];
    ui.wireTtsBtn({ ttsText: 'A self-created assigned sentence.' }, 'chTts');ui.node('chTts').onclick();
    assert.equal(ui.ttsOptions().localOnly, true);assert.equal(ui.voiceEngine.sent.length, 0);
    assert.match(ui.node('topBanner').textContent, /영어 읽기 음성/);
  });

  await t('계정 변경·원내 연결 이탈은 연속 듣기를 취소하고 늦은 종료·이전 듣기 버튼으로 재발화하지 않는다', () => {
    for (const reason of ['account', 'offline']) {
      const ui = screen();ui.voiceEngine.voices = [{ lang: 'en-US', localService: true }];
      ui.wireChunkWork(sample.sentences[0].dayGroup);const click = ui.node('ckTts').onclick;click();
      const first = ui.voiceEngine.sent[0];assert.ok(first);
      if (reason === 'account') ui.changeAccount({ code: 'ST2', token: 'own-changed-token' });
      else ui.windowEvents.get('offline')();
      click();first.onend();
      assert.equal(ui.get().studyStopped, true);assert.equal(ui.voiceEngine.sent.length, 1);
      assert.ok(ui.voiceEngine.cancels > 0);assert.equal(ui.get().pack, null);
    }
  });

  await t('실제 진단 문항의 모름 보기는 한 번만 나오고 기존 문항의 추가·일반 보기 동작도 유지한다', () => {
    const item = require('./gen.js').diagnosticSet(sample, () => 0.5)[0];
    for (const q of [item, { ...item, choices: item.choices.filter(c => c.key !== item.unknownKey) }, { ...item, unknownKey: undefined, choices: item.choices.filter(c => c.key !== item.unknownKey) }]) {
      const ui = screen();
      ui.renderItem(q, ui.node('rBody'));
      const choices = ui.node('chs').children;
      assert.equal(choices.filter(c => c.getAttribute('data-k') === item.unknownKey).length, q.unknownKey ? 1 : 0);
      assert.equal(choices.length, item.choices.length - (q.unknownKey ? 0 : 1));
    }
  });

  await t('옛 구매팩 캐시만 지우고 학생별 학습 기록은 보존한다', () => {
    const ui = screen();
    ui.store.set('wbn.packs', '{"private-pack":"old purchase"}');
    ui.store.set('wbn.pack', '{"private-pack":"older purchase"}');
    ui.store.set('wbn.v1:ST1', 'learning-record');
    ui.clearPackCache();
    assert.equal(ui.store.has('wbn.packs'), false);
    assert.equal(ui.store.has('wbn.pack'), false);
    assert.equal(ui.store.get('wbn.v1:ST1'), 'learning-record');
    assert.ok(!/function (cachePacks|loadPacksCache|cacheCurrentRange)\(/.test(inline), '구매팩 저장·오프라인 복원 경로가 남았다');
    assert.match(inline, /function boot\(\)\s*\{\s*clearPackCache\(\)/);
  });

  await t('다른 탭에서 학생이나 같은 학생의 토큰이 바뀌면 본문·러너를 닫고 쓰기를 막는다', async () => {
    for (const changed of [{ code: 'ST2', token: 'self-created-token-2' }, { code: 'ST1', token: 'new-token' }]) {
      const ui = screen();
      ui.persist();
      const prior = ui.store.get('wbn.v1:ST1');
      ui.node('rBody').innerHTML = 'private-question';
      ui.node('pjCh').innerHTML = 'private-answer-choices';
      ui.node('pjMsg').innerHTML = 'private-answer';
      ui.node('runner').classList.add('open');
      ui.runner({ timerId: 999, items: [{ prompt: 'private-question' }] });
      ui.changeAccount(changed);
      ui.windowEvents.get('storage')({ key: 'wbr.auth' });
      assert.equal(ui.get().studyStopped, true);
      assert.equal(ui.get().pack, null);
      assert.deepEqual(Object.keys(ui.get().PACKS), []);
      assert.equal(ui.node('runner').classList.contains('open'), false);
      assert.equal(ui.node('rBody').innerHTML, '');
      assert.equal(ui.node('pjCh').innerHTML, '');
      assert.equal(ui.node('pjMsg').innerHTML, '');
      assert.equal(ui.node('whoLine').innerHTML, '');
      assert.match(ui.node('wrap').innerHTML, /연동 학생이 바뀌었습니다/);
      ui.persist();
      await assert.rejects(ui.api('/state'), /account-changed/);
      assert.equal(ui.requests.length, 0);
      assert.equal(ui.store.get('wbn.v1:ST1'), prior);
      assert.equal(ui.store.has('wbn.v1:ST2'), false);
    }
  });

  await t('요청은 부팅 토큰을 쓰며 응답 도착 전에 계정이 바뀌면 채택하지 않는다', async () => {
    const ui = screen();
    let resolve;
    ui.setFetch(() => new Promise(r => { resolve = r; }));
    const pending = ui.api('/state');
    assert.equal(ui.requests[0].headers.Authorization, 'Bearer ' + account.token);
    assert.equal(ui.requests[0].cache, 'no-store');
    ui.changeAccount({ code: 'ST2', token: 'token-2' });
    resolve({ ok: true, status: 200, json: async () => ({ state: { owner: 'ST1' } }) });
    await assert.rejects(pending, /account-changed/);
    assert.equal(ui.get().studyStopped, true);
  });

  await t('소유자가 다른 원격·레거시 기록을 섞지 않고 원본 레거시는 남긴다', () => {
    const ui = screen();
    assert.equal(ui.pullAdopt({ owner: 'ST2', packs: { private: { savedAt: 999 } } }), false);
    assert.equal(ui.get().DB.packs.private, undefined);
    for (const legacy of [{ owner: 'ST2', packs: { private: {} } }, { packs: { private: {} } }]) {
      ui.store.set('wbn.v1', JSON.stringify(legacy));
      assert.equal(ui.migrateLegacy(), false);
      assert.equal(ui.get().DB.packs.private, undefined);
      assert.equal(ui.store.get('wbn.v1'), JSON.stringify(legacy));
    }
  });

  await t('기존 시험 조회로 연결을 확인하고 학원망 거절·단절·10초 무응답에는 자료를 닫는다', async () => {
    for (const failure of ['denied', 'offline', 'timeout']) {
      const ui = screen();
      ui.persist();
      const record = ui.store.get('wbn.v1:ST1');
      ui.setFetch((url, opt) => {
        if (failure === 'denied') return { ok: false, status: 403 };
        if (failure === 'offline') throw new Error('network');
        return new Promise((resolve, reject) => opt.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      });
      const pending = ui.checkAccess();
      assert.equal(ui.requests[0].url, '/api/naesin/exam');
      if (failure === 'timeout') [...ui.timers.values()].find(t => t.ms === 10000).fn();
      assert.equal(await pending, false);
      assert.equal(ui.get().pack, null);
      assert.deepEqual(Object.keys(ui.get().PACKS), []);
      assert.match(ui.node('wrap').innerHTML, /학원 연결을 확인/);
      assert.equal(ui.store.get('wbn.v1:ST1'), record);
    }
    const offline = screen();
    offline.windowEvents.get('offline')();
    assert.equal(offline.get().pack, null);
    assert.match(inline, /setInterval\(checkAccess, 30000\)/);
    assert.match(inline, /function onWake\(\)[\s\S]*?checkAccess\(\)/);
  });

  await t('연결 확인 성공은 자료를 유지하고 자체 창작 체험은 연결 검사 없이 열린다', async () => {
    const ui = screen();
    assert.equal(await ui.checkAccess(), true);
    assert.ok(ui.get().pack);
    const demo = screen();
    demo.demo(); demo.renderOff();
    demo.setFetch(url => { assert.equal(url, './pack-sample.json'); return { json: async () => clone(sample) }; });
    await demo.openDemo();
    assert.equal(demo.get().pack.packId, sample.packId);
    const count = demo.requests.length;
    assert.equal(await demo.checkAccess(), false);
    assert.equal(demo.requests.length, count);
    demo.windowEvents.get('offline')();
    assert.ok(demo.get().pack, '자체 창작 체험은 오프라인에서 닫지 않는다');
  });

  await t('투사 결과는 실제로 로드한 배정 과에만 기록하고 현재 다른 과와 미로드·범위 밖 과는 건드리지 않는다', () => {
    const other = { ...clone(sample), packId: 'own-class-projector' };
    const it = { ref: 'w-e2k:' + sample.words[0].id, choices: [{ key: '1', text: '자체 창작 답' }], answerKey: '2' };
    for (const loaded of ['assigned', 'outside', 'missing', 'legacy']) {
      const ui = screen(), current = ui.get().DB.packs[sample.packId];
      current.savedAt = 111;
      if (loaded === 'assigned' || loaded === 'outside') ui.addPack(other, loaded === 'assigned');
      const pj = { packId: loaded === 'legacy' ? undefined : other.packId, startedAt: 'class-session', index: 0, count: 1, item: it };
      ui.projector('cls:가반', pj);
      ui.node('pjCh').events.get('click')({ target: { closest: () => ({ disabled: false, getAttribute: () => '1' }) } });
      ui.projector('cls:가반', { ...pj, revealed: true });
      ui.projector('cls:가반', { ...pj, revealed: true });
      assert.equal(current.log.length, 0);assert.equal(Object.keys(current.wrong).length, 0);assert.equal(current.savedAt, 111);
      const pd = ui.get().DB.packs[other.packId];
      if (loaded === 'assigned') {
        assert.equal(pd.log.length, 1);assert.equal(Object.keys(pd.wrong).length, 1);assert.ok(pd.savedAt > 111);
      } else if (pd) { assert.equal(pd.log.length, 0);assert.equal(Object.keys(pd.wrong).length, 0);assert.equal(pd.savedAt, 0); }
      else assert.equal(pd, undefined);
    }
  });

  await t('학생 응답은 실제 반 scope를 보내고 이전 반의 늦은 응답이 새 반 선택을 바꾸지 않는다', async () => {
    const ui = screen();
    const pj = { packId: sample.packId, startedAt: 'session', index: 0, count: 1,
      item: { ref: 'w-e2k:' + sample.words[0].id, choices: [{ key: '1', text: '자체 창작 답' }] } };
    let resolve;ui.setFetch(() => new Promise(r => { resolve = r; }));
    ui.projector('cls:가반', pj);
    ui.node('pjCh').events.get('click')({ target: { closest: () => ({ disabled: false, getAttribute: () => '1' }) } });
    assert.equal(JSON.parse(ui.requests[0].body).scope, 'cls:가반');
    assert.equal(ui.projectile().pjPick, '1');
    ui.projector('default', pj);
    assert.equal(ui.projectile().pjPick, null);
    resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await new Promise(r => setImmediate(r));
    assert.equal(ui.projectile().pjSent, false);assert.equal(ui.projectile().pjPick, null);
  });

  await t('서버 동률 확정은 채택하고 요청 뒤 새 학습 기록은 지키며 요약을 한 번 갱신한다', async () => {
    const ui = screen(); ui.renderOff();
    const pid = sample.packId, state = ui.get().DB;
    state.packs[pid].savedAt = 100;
    let count = 0;
    ui.setFetch((url, opt) => {
      count++;
      const sent = JSON.parse(opt.body).state;
      if (count === 1) { sent.packs[pid].diagDone = true; return { ok: true, status: 200, json: async () => ({ state: sent }) }; }
      assert.equal(sent.packs[pid].diagDone, true);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    await ui.pushState();
    assert.equal(count, 2);
    assert.equal(state.packs[pid].diagDone, true);
    const sent = clone(state), remote = clone(state);
    state.packs[pid].savedAt = 101; state.packs[pid].diagDone = false;
    remote.packs[pid].diagDone = true;
    assert.equal(ui.pullAdopt(remote, sent), false);
    assert.equal(state.packs[pid].diagDone, false);
  });

  await t('시계 정상화 뒤 미래 idle 과는 내용·due·last를 지키고 저장 시각만 0으로 회복한다', async () => {
    const ui = screen(), now = Date.now(), future = now + 10 * 60e3;
    ui.clock(now); ui.renderOff();
    const state = ui.get().DB;
    state.savedAt = future;
    state.packs['idle-lesson'] = { savedAt: future, marker: '원래 학습', states: { word: { due: future, last: future } } };
    ui.store.set('wbn.v1:ST1', JSON.stringify(state));
    const loaded = ui.loadDB();
    assert.equal(loaded.savedAt, 0);
    assert.equal(loaded.packs['idle-lesson'].savedAt, 0);
    assert.equal(loaded.packs['idle-lesson'].states.word.due, future);
    ui.setFetch((url, opt) => {
      const sent = JSON.parse(opt.body).state;
      assert.equal(sent.savedAt, 0);
      assert.deepEqual(sent.packs['idle-lesson'], { savedAt: 0, marker: '원래 학습', states: { word: { due: future, last: future } } });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    await ui.pushState();
    const remote = { owner: 'ST1', savedAt: future, packs: { 'other-lesson': { savedAt: future, marker: '원격 원본' } } };
    assert.equal(ui.pullAdopt(remote), true);
    assert.equal(ui.get().DB.packs['other-lesson'].savedAt, 0);
    assert.equal(ui.get().DB.packs['other-lesson'].marker, '원격 원본');
    const current = { owner: 'ST1', savedAt: now, packs: { 'idle-lesson': { savedAt: now, marker: '정상 시계의 서버 최신' } } };
    assert.equal(ui.pullAdopt(current), true);
    assert.equal(ui.get().DB.packs['idle-lesson'].marker, '정상 시계의 서버 최신');
  });

  await t('기기 시계가 여전히 미래면 자동으로 정상 학습을 꾸미지 않고 서버의 시계 확인 안내를 보여 준다', async () => {
    const ui = screen(), future = Date.now() + 10 * 60e3, state = ui.get().DB;
    ui.clock(future);
    state.savedAt = future; state.packs[sample.packId].savedAt = future;
    ui.setFetch((url, opt) => {
      const sent = JSON.parse(opt.body).state;
      assert.equal(sent.savedAt, future);
      assert.equal(sent.packs[sample.packId].savedAt, future);
      return { ok: false, status: 400, json: async () => ({ error: '학습 시각이 올바르지 않아요. 기기 시간을 확인해 주세요.' }) };
    });
    await ui.pushState();
    assert.match(ui.node('topBanner').textContent, /기기 시간을 확인/);
    assert.equal(state.savedAt, future);
  });

  await t('러너가 참조하는 기록은 서버 응답 도착 때 바꾸지 않고 종료 뒤에 채택한다', async () => {
    const ui = screen(); ui.renderOff();
    const pid = sample.packId, before = ui.get().DB.packs[pid];
    before.savedAt = 100;
    ui.runner({ items: [] });
    let count = 0;
    ui.setFetch((url, opt) => {
      count++;
      const state = JSON.parse(opt.body).state;
      if (count === 1) { state.packs[pid].diagDone = true; return { ok: true, status: 200, json: async () => ({ state }) }; }
      assert.equal(state.packs[pid].diagDone, true);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    await ui.pushState();
    assert.equal(ui.get().DB.packs[pid], before);
    assert.equal(before.diagDone, false);
    assert.ok(ui.get().pendingRemote);
    ui.runner(null);
    await ui.pushState();
    assert.equal(ui.get().DB.packs[pid].diagDone, true);
    assert.equal(ui.get().pendingRemote, null);
  });

  await t('서비스 워커는 앱 셸·자체 창작 샘플만 캐시하고 다른 앱 캐시는 보존한다', async () => {
    const events = new Map(), deleted = [], stored = [];
    const origin = 'https://academy.invalid';
    const ctx = vm.createContext({
      URL, location: { origin },
      self: { location: { href: origin + '/naesin/sw.js' }, addEventListener: (type, fn) => events.set(type, fn), clients: { claim() {} } },
      caches: {
        match: async () => null,
        open: async () => ({ put: async key => stored.push(key) }),
        keys: async () => ['wbn-shell-old', 'wbn-shell-dev', 'other-app-shell'],
        delete: async key => { deleted.push(key); },
      },
      fetch: async () => ({ clone: () => ({}) }),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'), ctx);
    for (const url of ['/api/naesin/pack?id=private', '/naesin/private-pack.json', '/admin/naesin-admin.html']) {
      events.get('fetch')({ request: { url: origin + url, method: 'GET' }, respondWith: () => { throw new Error('구매 자료·관리 화면 캐시 경로: ' + url); } });
    }
    let response;
    events.get('fetch')({ request: { url: origin + '/naesin/pack-sample.json', method: 'GET' }, respondWith: promise => { response = promise; } });
    await response;
    assert.equal(stored.length, 1, '자체 창작 체험은 오프라인 캐시');
    let activated;
    events.get('activate')({ waitUntil: promise => { activated = promise; } });
    await activated;
    assert.deepEqual(deleted, ['wbn-shell-old']);
  });
  console.log('통과 ' + passed);
})().catch(e => { console.error(e); process.exitCode = 1; });
