const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
function browser() {
  const players = [], urls = [], revoked = [], timers = new Map(); let next = 0;
  const context = { AbortController, Blob, setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); },
    Audio: function () { players.push(this); this.play = () => { this.played = true; return Promise.resolve(); };
      this.pause = () => { this.paused = true; }; this.removeAttribute = () => {}; },
    URL: { createObjectURL(blob) { urls.push(blob); return 'blob:own-' + urls.length; }, revokeObjectURL(url) { revoked.push(url); } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./voice.js'), 'utf8'), context);
  return { voice: context.WBVoice, players, urls, revoked, timers };
}
function wav(sample = 0) {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(4, 40); b.writeInt16LE(sample, 44); b.writeInt16LE(sample, 46);
  return new Blob([b], { type: 'audio/wav' });
}
(async () => {
  {
    const b = browser(); let starts = 0, ends = 0, loading = 0;
    b.voice.speak('Own English sentence.', { audioSource: async (text, rate, signal) => {
      assert.equal(text, 'Own English sentence.'); assert.equal(rate, 1); assert.equal(signal.aborted, false); return 'own-blob';
    }, rate: 0.8, onloading: () => loading++, onstart: () => starts++, onend: () => ends++ });
    assert.equal(loading, 1); assert.equal(b.voice.isSpeaking(), true); await flush();
    assert.equal(b.players[0].played, true); assert.equal(b.players[0].playbackRate,0.8); b.players[0].onplaying(); b.players[0].onplaying();
    assert.equal(starts, 1); b.players[0].onended(); b.players[0].onended();
    assert.equal(ends, 1); assert.equal(b.voice.isSpeaking(), false); assert.deepEqual(b.revoked, ['blob:own-1']);
  }
  {
    const b = browser(); let resolve, signal, ends = 0;
    b.voice.speak('Own delayed sentence.', { audioSource: (_, rate, s) => { signal = s; return new Promise(r => { resolve = r; }); }, onend: () => ends++ });
    await flush(); b.voice.stop(); assert.equal(signal.aborted, true); resolve('late blob'); await flush();
    assert.equal(b.urls.length, 0); assert.equal(b.players[0].played, undefined); assert.equal(ends, 0);
  }
  {
    const b = browser(); let calls = 0, ends = 0;
    const seq = b.voice.speakSeq(['Own first.', 'Own second.'], { audioSource: async () => { calls++; return 'blob'; }, onend: () => ends++ });
    await flush(); b.players[0].onended(); await flush(); assert.equal(calls, 2);
    b.players[1].onended(); assert.equal(ends, 1);
    b.voice.speakSeq(['Own cancelled.', 'Must not play.'], { audioSource: async () => { calls++; return 'blob'; } });
    await flush(); b.voice.stop(); b.players[2].onended(); await flush(); assert.equal(calls, 3);
    assert.doesNotThrow(() => seq.cancel());
  }
  {
    const b = browser(), texts = [], original = ('Own English practice sentence. ').repeat(60).trim();
    let ends = 0, signal;
    b.voice.speak(original, { audioSource: async (text, rate, s) => { texts.push(text); signal=s; return wav(texts.length); }, onend: () => ends++ });
    await flush(); assert.equal(texts.join(' '), original, '본문 전체를 재생 전에 받는다');
    assert.equal(b.urls.length, 1, '구간마다 src를 다시 열지 않고 한 WAV로 재생한다');
    const joined = Buffer.from(await b.urls[0].arrayBuffer());
    assert.equal(joined.length, 44 + texts.length * 4); assert.equal(joined.readUInt32LE(4), joined.length - 8);
    assert.equal(joined.readUInt32LE(40), texts.length * 4);
    for (let i = 0; i < texts.length; i++) assert.equal(joined.readInt16LE(44 + i * 4), i + 1, 'PCM 순서 보존');
    b.players[0].onplaying(); b.players[0].onended(); await flush();
    assert.equal(ends, 1); assert.ok(texts.every(text => text.length <= 180));
    assert.equal(b.revoked.length, 1);
    b.voice.speak(original, { audioSource: async (text, rate, s) => { signal=s; return wav(); } });
    await flush(); b.voice.stop(); assert.equal(signal.aborted, true);
    b.players[1].onended(); await flush(); assert.equal(b.voice.isSpeaking(), false);
  }
  {
    const b = browser(), pending = [], errors = [], original = ('Own bounded request sentence. ').repeat(40);
    b.voice.speak(original, { audioSource: (_, rate, signal) => new Promise(resolve => pending.push({ resolve, signal })), onerror: e => errors.push(e) });
    await flush(); assert.equal(pending.length, 2, '기기당 동시에 두 요청만 보낸다');
    b.voice.stop(); pending.forEach(p => { assert.equal(p.signal.aborted, true); p.resolve(wav()); });
    await flush(); assert.equal(pending.length, 2, '취소 뒤 나머지 원문을 요청하지 않는다');
    assert.equal(b.urls.length, 0); assert.deepEqual(errors, []);
  }
  {
    const wrongRate = Buffer.from(await wav().arrayBuffer()); wrongRate.writeUInt32LE(16000, 24);
    const truncated = new Blob([(await wav().arrayBuffer()).slice(0, 46)]);
    for (const bad of [new Blob(['invalid']), new Blob([Buffer.alloc(48)]), new Blob([wrongRate]), truncated]) {
      const b = browser(), errors = [];
      b.voice.speak(('Own invalid audio sentence. ').repeat(10), { audioSource: async () => bad, onerror: e => errors.push(e) });
      await flush(); assert.deepEqual(errors, ['audio-failed']); assert.equal(b.urls.length, 0);
    }
    const b = browser(), errors = []; let calls = 0;
    b.voice.speak(('Own unfinished audio sentence. ').repeat(10), { audioSource: async () => {
      if (++calls === 2) throw Object.assign(new Error('not ready'), { code: 'AUDIO_PREPARING' });
      return wav();
    }, onerror: e => errors.push(e) });
    await flush(); assert.deepEqual(errors, ['audio-preparing']); assert.equal(b.urls.length, 0, '미준비 본문을 중간까지 읽고 끊지 않는다');
  }
  {
    const b = browser(), errors = []; let reads = 0, calls = 0;
    b.voice.speak(('Own memory bounded sentence. ').repeat(200), { audioSource: async () => {
      calls++; return { size: 6000000, arrayBuffer() { reads++; throw new Error('must not allocate'); } };
    }, onerror: e => errors.push(e) });
    await flush(); assert.deepEqual(errors, ['audio-failed']); assert.equal(reads, 0, '64MB 상한은 PCM 복사 전에 검사한다');
    assert.ok(calls <= 12); assert.equal(b.urls.length, 0);
  }
  {
    const b = browser(), errors = [];
    b.voice.speak('Own failed sentence.', { audioSource: async () => { throw new Error('own error'); }, onerror: e => errors.push(e) });
    await flush(); assert.deepEqual(errors, ['audio-failed']); assert.equal(b.voice.isSpeaking(), false);
    b.voice.speak('Own stalled sentence.', { audioSource: () => new Promise(() => {}), onerror: e => errors.push(e) });
    await flush(); for (const fn of [...b.timers.values()]) fn();
    assert.deepEqual(errors, ['audio-failed', 'start-timeout']); assert.equal(b.voice.isSpeaking(), false);
  }
  console.log('✓ 서버 음성 실제 play 요청·시작/종료·연속 듣기·취소·늦은 응답·Blob 해제·오류·시간 초과');
})().catch(e => { console.error(e); process.exitCode = 1; });
