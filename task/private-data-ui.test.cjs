const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const textbooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'textbooks.json'), 'utf8'));

test('student private data is never shipped as a Pages static file', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'roster.json')), false);
  assert.equal(Object.prototype.hasOwnProperty.call(textbooks, 'students'), false);
  assert.doesNotMatch(html, /fetch\(['"]roster\.json/);
  assert.match(html, /sync\.post\('\/roster', \{ app: SYNC_APP, auth: auth, action: 'get' \}\)/);
  assert.match(html, /d\.students = privateBookStudents\.slice\(\)/);
  assert.match(html, /if \(rosterErr\) return '<div class="card alert">[\s\S]{0,500}data-act="rosterretry"/);
  assert.match(html, /학생 배정과 진도를 0명으로 잘못 표시하지 않도록/);
  assert.match(html, /if \(bookDbErr\) return '<div class="card alert">[\s\S]{0,500}data-act="bookretry"/);
  assert.match(html, /rosterErr = '';[\s\S]{0,100}renderAfterSync\(\)/);
});

test('migrated student names never reappear in public source or documentation', () => {
  const forbidden = new Set([
    '0db6f8a8715ae3caa1d64518ef2580e23abb27553a51fca8b05ec43b16ae0980','18e647aa24acbac3fdbc38f72dfdb9ac09bb379514414ace788e2a0a77e738d1',
    '1a9a9599a966bb004043f6669fab25269eef2c846000b18cf06c554e714b804f','20b027ae410ac94890669ece78da37ebef38ae85711b55205d820817d14808ad',
    '284fa5ce8c88e7899b54c013b407916826c2a6528cde4464af16795323a2b8d5','6c0111331209991a8f258e158776eec2490857a9bf47123023b6b5da0b8c26f7',
    '6c0120bb0aa56efe1460cc27d5b97a5f79f923826db2c14687625624bac1d6d7','722736b09a6bd4eb7b72fb26b78ad1bf2835232bb4065fe0245e8fecb251b5dd',
    '8ba85044995a8da57fd54c26d6f98594025e876ad06e90a06fd1a47f3a4edd3e','8bcc04259b032eeb2c3e2aa461e2c679eddba40c794620f3650b7730d545c245',
    '90e91f2ae64f5dab44acd1806d5797fd34306128ef0124a536b8987f731f227e','97fda80974658ad15bfa600e7a1cfd47fbde93b57b18f8cd9634ebf5efd8c24e',
    '9865e47e0de1fa36f6df0a0f951be4ed169fdb8b5f30204387adc5a2eb0c3ab3','99ce3e170969fcbf7fb46e55c7dff2f33f1d42e936d3d39e6f1f96bcdeb594de',
    '9a5a536418cbd18253af24bde62978126bd15133ce02381835754fa7a5116a03','a1235f0d049ba8b09794094afdbd6f3e7e0cad929f185e45f5d7977826ca99a0',
    'ac858025be806b3cd744a477e6511bee4a1fc6da46e8a5ab3807b62f6ea5d9cc','b0a7da461120ecf748777a2d3a3d45387b3a9b97ea3accdfcef679e35b1aa1ae',
    'c70d7cdffc276fe5d61ab98808db6b9cbc6e44c17be969219a546035475420b5','c7e14a211792f2d7e43ddea7ea16c971b8b78a158840fc4c7592a85add7b5266',
    'd9416d8968be0b40227a2c983c728824ab9cb099516b3b4f248e0490d9f4e33a','dd17427378bf7e0f9d4ea0386fcff08a9abf5bb94f5d78981058f46d6d741df1',
    'ddee2e3f81cfbdbca4ab3549b35a317633403174c344c299e281600418c4330f','df2a026b1fd2303b3d8fa5b4dfaaeebaf1a200c9404020c6148a25662fe7796d',
    'e4ce4b4bf68b58e052d87c2fb6f754eb9d0f2be25fcd2ded4e8c92540ae95322','e7b768d0d08afc1aa967e0497aff7a09670bded15b2cd5dfcd302fa36be58672',
    'eaf34916199de4f475d1f3c8fa406772d2d356b0d080a3f01d08df5e2d7b5528','eb0c06e669eaf571e15d12d3d23bcbb5d8c505763361a2096f2f1a7500f3f11d',
    'ed89375a0da4b7aae91857d6fe0af1850b8152a3603458dd5781aa483efb19b9','f574a9d131f01e74cd89e725c589385d9ebf19d31bcd122fe20ae64537323a72',
    'f5914421fefa2e73943d879f521334000f3e9436125855d1832ba99fdb480372','f876282573a5e7d629d736d28c098de323ace3f4d3d1d5087e497c9ce769ee60',
    'faa519f7019cf72669010d99dbb53c689d240322b483d32ab45940291eac2dc5','fb2206349893db220bfd45a4394eb45d5fa5d13c8da47bf144deb6030397d0da',
    'fc0b0cb80850fd704b7ccd783f14ce31e4af2e6b3773154dca7083ff879a6d02'
  ]);
  const root = path.join(__dirname, '..');
  const leaks = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(file);
    if (!entry.isFile() || fs.statSync(file).size > 2_000_000) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const token of text.match(/[가-힣]{2,}/g) || []) {
      for (let size = 2; size <= 4; size++) for (let at = 0; at + size <= token.length; at++) {
        const hash = crypto.createHash('sha256').update(token.slice(at, at + size)).digest('hex');
        if (forbidden.has(hash)) leaks.push(path.relative(root, file));
      }
    }
  });
  ['consult', 'docs', 'sync', 'task'].forEach(name => walk(path.join(root, name)));
  assert.deepEqual([...new Set(leaks)], []);
});
