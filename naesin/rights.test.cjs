'use strict';
const assert = require('node:assert/strict');
const C = require('./pack-check.js');
const base = { basis: 'licensed', holder: 'Rights Holder', evidenceRef: 'contract-ref', studentUseAllowed: true, derivativeUseAllowed: true, externalAiAllowed: false };
assert.equal(C.rightsErrors(null).length, 1);
assert.equal(C.rightsErrors({ ...base, studentUseAllowed: false }).length, 1);
assert.equal(C.rightsErrors({ ...base, expiresAt: '2000-01-01' }).length, 1);
assert.equal(C.rightsErrors({ ...base, evidenceRef: '' }).length, 1);
assert.deepEqual(C.rightsErrors(base, '2026-10-13'), []);
const sample = require('./pack-sample.json');
assert.deepEqual(C.checkPack(sample).errors, []);
const legacy = { ...sample }; delete legacy.rights;
assert.ok(C.checkPack(legacy).errors.some((e) => e.where === 'rights'));
console.log('naesin rights tests passed');

assert.ok(C.rightsErrors({ ...base, expiresAt: '2026-02-31' }).length, '존재하지 않는 날짜 거절');
for (const bad of [{ ...base, externalAiAllowed: 'false' }, { ...base, holder: 12 }, { ...base, sneaky: true }, { ...base, notes: 4 }, { ...base, expiresAt: 20261013 }])
  assert.ok(C.rightsErrors(bad).length, '잘못된 타입/추가 키가 거절되어야 함');
assert.ok(C.rightsErrors({ ...base, basis: 'open_license', evidenceRef: '' }).length, '공개 라이선스 증빙 필수');
