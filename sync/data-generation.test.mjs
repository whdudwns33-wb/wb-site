import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/046_app_data_generations.sql', import.meta.url), 'utf8');

test('sync checks data generation before accepting changes', () => {
  const start = worker.indexOf('async function handleSync');
  const end = worker.indexOf('async function handleToken', start);
  const block = worker.slice(start, end);
  assert.match(block, /SELECT generation FROM app_data_generations/);
  assert.match(block, /DATA_GENERATION_MISMATCH/);
  assert.ok(block.indexOf('DATA_GENERATION_MISMATCH') < block.indexOf('// ── 올리기'));
  assert.match(block, /authRole, dataGeneration/);
});

test('schema and migration initialize both apps at generation zero', () => {
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS app_data_generations/);
    assert.match(source, /\('task', 0, 0\)/);
    assert.match(source, /\('consult', 0, 0\)/);
  }
});
