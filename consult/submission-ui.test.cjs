const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const plain = 'function ' + name + '(';
  const asyncMarker = 'async function ' + name + '(';
  let start = html.indexOf(asyncMarker);
  if (start < 0) start = html.indexOf(plain);
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function eventCase(name) {
  const marker = "case '" + name + "':";
  const start = html.indexOf(marker);
  if (start < 0) return '';
  const tail = html.slice(start + marker.length);
  const next = tail.match(/\n\s*case '[^']+':/);
  return html.slice(start, next ? start + marker.length + next.index : html.length);
}

function submissionBlock() {
  const start = html.indexOf('/* ── 비공개 질문 · 인증사진 ──');
  const end = html.indexOf('\nfunction learningTasksFor(', start);
  assert.ok(start >= 0 && end > start, 'submission source block must exist');
  return html.slice(start, end);
}

test('proof and question UI reuse taskPanel and viewStudy without adding another tab or route', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.doesNotMatch(functionSource('renderTabs'), /\['submission'/);

  const taskPanel = functionSource('taskPanel');
  const study = functionSource('viewStudy');
  const proof = functionSource('submissionTaskPanel');
  const hub = functionSource('submissionHubCard');
  assert.match(taskPanel, /submissionTaskPanel\(t, date\)/);
  assert.match(study, /submissionHubCard\(me\)/);
  assert.match(proof, /task\.evidenceMode !== 'photo'/);
  assert.match(proof, /task\.staffId === session\.staffId/);
  assert.match(proof, /data-act="submissionproof"/);
  assert.match(hub, /data-act="submissionquestion"/);
  assert.match(hub, /질문 · 인증사진/);
  assert.match(hub, /비공개/);
});

test('student submits only their own proof/question while review and answer stay director-only', () => {
  const modal = functionSource('submissionModal');
  const taskPanel = functionSource('submissionTaskPanel');
  const itemCard = functionSource('submissionItemCard');
  const reviewModal = functionSource('submissionReviewModal');
  const saveReview = functionSource('saveSubmissionReview');
  assert.match(modal, /if \(!session\.isStaffLink\)/);
  assert.match(modal, /row\.staffId === session\.staffId/);
  assert.match(taskPanel, /session\.isStaffLink && task\.staffId === session\.staffId/);
  [taskPanel, itemCard, reviewModal, saveReview].forEach(source => {
    assert.match(source, /session\.isAdmin/);
    assert.doesNotMatch(source, /isManager\(\)/,
      'mutable manager metadata must not grant server review authority');
  });

  const actions = [
    'submissionproof', 'submissionquestion', 'submissionsubmit', 'submissionview',
    'submissionreview', 'submissionreviewsave', 'submissioncancel', 'submissionrefresh'
  ];
  actions.forEach(action => assert.ok(eventCase(action), action + ' action must be wired'));
  assert.match(eventCase('submissionreview'), /if \(!session\.isAdmin\) break/);
  assert.match(eventCase('submissionproof'), /row\.staffId === session\.staffId/);
});

test('director inbox requests pending submissions and never hides loading errors', () => {
  const load = functionSource('loadSubmissions');
  const inbox = functionSource('submissionBoardInbox');
  assert.match(load, /owner === '\*'.*query\.status = 'pending'/s);
  assert.match(load, /query\.limit = 50/);
  assert.match(inbox, /submissionCache\.error/);
  assert.match(inbox, /다시 불러오기/);
  assert.match(inbox, /최신 50건/);
});

test('submission requests keep consult auth in FormData or JSON bodies and never in URLs', () => {
  const post = functionSource('submissionPost');
  const submit = functionSource('submitSubmissionForm');
  const photo = functionSource('showSubmissionPhoto');

  assert.match(post, /const auth = sync\.auth\(\)/);
  assert.match(post, /sync\.post\('\/consult-submission'/);
  assert.match(post, /app: SYNC_APP, auth: auth/);

  assert.match(submit, /const auth = sync\.auth\(\)/);
  assert.match(submit, /new FormData\(\)/);
  for (const field of ['app', 'auth', 'kind', 'clientRequestId', 'taskId', 'taskDate', 'bodyText', 'file']) {
    assert.match(submit, new RegExp("form\\.set\\('" + field + "'"), field);
  }
  assert.match(submit, /JSON\.stringify\(auth\)/);
  assert.match(submit, /fetch\(SYNC_URL \+ '\/consult-submission-upload', \{ method: 'POST', body: form \}\)/);
  assert.doesNotMatch(submit, /['"]Content-Type['"]/,
    'the browser must add the multipart boundary');
  assert.match(submit, /submissionForm\.kind === 'proof' && !rawFile/);
  assert.match(submit, /submissionForm\.kind === 'question' && !(?:rawText|bodyText) && !rawFile/);

  assert.match(photo, /action: 'read_media', id: id/);
  assert.match(photo, /JSON\.stringify\(\{ app: SYNC_APP, auth: auth/);
  assert.doesNotMatch(submissionBlock(), /[?&](?:token|auth|staffId)=|URLSearchParams|searchParams/,
    'credentials and student ids must never be added to media URLs');
});

test('the browser re-encodes to a 1600px JPEG and targets 1.5MiB without dependencies', async () => {
  const source = functionSource('prepareSubmissionImage');
  const observations = { canvases: [], encodes: [], closed: 0, revoked: [] };
  const api = Function('observations', `
    const window={createImageBitmap:true};
    async function createImageBitmap(file, options) {
      observations.orientation=options.imageOrientation;
      return {width:3200,height:1600,close(){observations.closed++;}};
    }
    const URL={createObjectURL(){throw new Error('bitmap path should not need a blob URL');},revokeObjectURL(value){observations.revoked.push(value);}};
    class Image {}
    class File extends Blob { constructor(parts,name,options){super(parts,options);this.name=name;} }
    const document={createElement(tag){
      if(tag!=='canvas') throw new Error('only canvas is expected');
      const canvas={width:0,height:0,getContext(){return {
        fillStyle:'',fillRect(){},drawImage(){},
      };},toBlob(callback,type,quality){
        observations.canvases.push([canvas.width,canvas.height]);
        observations.encodes.push([type,quality]);
        callback(new Blob([new Uint8Array(1.4*1024*1024)],{type}));
      }};
      return canvas;
    }};
    ${source}
    return {prepareSubmissionImage};
  `)(observations);

  const result = await api.prepareSubmissionImage({ type: 'image/png', size: 4 * 1024 * 1024 });
  assert.equal(result.name, 'image.jpg');
  assert.equal(result.type, 'image/jpeg');
  assert.ok(result.size <= 1.5 * 1024 * 1024);
  assert.deepEqual(observations.canvases[0], [1600, 800]);
  assert.deepEqual(observations.encodes[0], ['image/jpeg', .82]);
  assert.equal(observations.orientation, 'from-image');
  assert.equal(observations.closed, 1);
  assert.match(source, /blob\.size <= 1\.5 \* 1024 \* 1024/);
  assert.match(source, /blob\.size > 2 \* 1024 \* 1024/);
  assert.doesNotMatch(source, /FileReader|readAsDataURL|base64/i);
});

test('photos and submission DTOs stay outside state/localStorage and never complete a task', () => {
  const block = submissionBlock();
  const blank = functionSource('blankState');
  const save = functionSource('save');
  const submit = functionSource('submitSubmissionForm');
  const review = functionSource('saveSubmissionReview');
  const cancel = functionSource('cancelSubmission');

  assert.match(block, /const submissionCache = \{/);
  assert.doesNotMatch(blank, /submission|media|photo|blob|base64/i);
  assert.match(save, /localStorage\.setItem\(LS_KEY, JSON\.stringify\(state\)\)/);
  const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(codeOnly, /localStorage|readAsDataURL|data:image|btoa\(/i);
  assert.doesNotMatch(block, /state\.checks\s*\[|state\.tasks\.push|setCheck\(|setDone\(|toggleDone\(/);
  for (const source of [submit, review, cancel]) {
    assert.doesNotMatch(source, /save\(\)|queueSync\(\)|setCheck\(|state\.checks|\.done\s*=/,
      'submission state must not silently mark the existing checklist complete');
  }
  assert.match(functionSource('submissionReviewModal'), /완료 체크는 별도로 유지/);
});

test('private photo object URLs are revoked both on replacement and every modal close', () => {
  const show = functionSource('showSubmissionPhoto');
  const clear = functionSource('clearSubmissionPreview');
  const close = functionSource('closeModal');
  assert.match(show, /clearSubmissionPreview\(\)/);
  assert.match(show, /URL\.createObjectURL\(await response\.blob\(\)\)/);
  assert.match(clear, /URL\.revokeObjectURL\(submissionPreviewUrl\)/);
  assert.match(clear, /submissionPreviewUrl = ''/);
  assert.match(close, /clearSubmissionPreview\(\)/,
    'closing the photo modal must release its private Blob URL immediately');
});
