import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createKokoro, speechInput } from './kokoro.mjs';

const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
function rig(timeoutMs = 1000) {
  const children = [], requests = [];
  const engine = createKokoro({ python: 'own-python', home: 'own-models', timeoutMs, spawnProcess(command, args, opt) {
    assert.equal(command, 'own-python'); assert.equal(opt.windowsHide, true); assert.equal(opt.stdio[2], 'ignore');
    assert.ok(args[1].endsWith('kokoro-worker.py')); assert.equal(opt.env.WB_KOKORO_HOME, 'own-models');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', line => requests.push(JSON.parse(String(line))));
    child.kill = () => { child.emit('exit', 0); };
    children.push(child); return child;
  } });
  return { engine, children, requests, reply(id, audio = wav) {
    children.at(-1).stdout.write(JSON.stringify({ id, audio: audio.toString('base64') }) + '\n');
  } };
}
for (const body of [null, {}, { text: '' }, { text: '한글만' }, { text: 'x'.repeat(801) }, { text: 'x\0y' },
  ...[0, 3, '1', NaN, Infinity].map(rate => ({ text: 'Own sentence.', rate }))]) assert.equal(speechInput(body), null);
assert.deepEqual(speechInput({ text: '  Own sentence.  ' }), { text: 'Own sentence.', rate: 1 });
await assert.rejects(createKokoro().speak({ text: 'Own sentence.' }), /unavailable/);
{
  const r = rig();
  try {
    r.engine.warm(); r.engine.warm(); assert.equal(r.children.length, 1);
    const jobs = Array.from({ length: 20 }, () => r.engine.speak({ text: 'Own sentence.' }));
    assert.equal(r.requests.length, 1, '같은 문장의 동시 요청은 한 번만 생성');
    r.reply(1); for (const result of await Promise.all(jobs)) assert.deepEqual(result, wav);
    await r.engine.speak({ text: 'Own sentence.' }); assert.equal(r.requests.length, 1);
    const slower = r.engine.speak({ text: 'Own sentence.', rate: 0.8 });
    assert.equal(r.requests.length, 2); r.reply(2); await slower;
  } finally { r.engine.close(); }
}
{
  const r = rig();
  const jobs = Array.from({ length: 20 }, (_, i) => r.engine.speak({ text: 'Own sentence ' + i }));
  const rejected = Promise.all(jobs.map(p => assert.rejects(p, /unavailable/)));
  await assert.rejects(r.engine.speak({ text: 'Own extra sentence' }), /busy/);
  r.engine.close(); await rejected;
  const retry = r.engine.speak({ text: 'Own retry sentence.' });
  assert.equal(r.children.length, 2); r.reply(r.requests.at(-1).id); await retry; r.engine.close();
}
{
  const r = rig(20);
  await assert.rejects(r.engine.speak({ text: 'Own timeout sentence.' }), /unavailable/);
  const invalid = r.engine.speak({ text: 'Own invalid audio.' });
  r.reply(r.requests.at(-1).id, Buffer.from('not a wave')); await assert.rejects(invalid, /unavailable/);
  const crashed = r.engine.speak({ text: 'Own crash sentence.' });
  r.children.at(-1).emit('error', new Error('own test crash')); await assert.rejects(crashed, /unavailable/);
  r.engine.close();
}
const python = await import('node:fs');
const worker = python.readFileSync(new URL('./kokoro-worker.py', import.meta.url), 'utf8');
assert.match(worker, /HF_HUB_OFFLINE.*'1'/); assert.match(worker, /TRANSFORMERS_OFFLINE.*'1'/);
const server = python.readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(server, /kokoro|\/api\/naesin\/tts/);
console.log('✓ Kokoro 입력·동시 요청 합치기·캐시·속도·대기 상한·시간 초과·복구·로컬 전용');
