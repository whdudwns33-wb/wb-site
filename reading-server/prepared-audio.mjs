/* 원내 PC의 비공개 음성 보관함. 학생 요청에서는 합성을 실행하지 않는다. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import VOICE from '../shared/voice.js';
import CHECK from '../naesin/pack-check.js';

export const audioKey = text => crypto.createHash('sha256').update('kokoro-0.9.4-82m-v1-af_heart-pcm24k-rate1\0' + text.trim()).digest('hex');
export function packAudioInputs(pack) {
  const texts = [];
  for (const s of pack.sentences || []) {
    texts.push(s.en); for (const c of s.chunks || []) texts.push(c.en);
  }
  for (const d of pack.dialogues || []) for (const line of d.lines || []) texts.push(line.en);
  for (const item of pack.items || []) texts.push(item.ttsText);
  const inputs = new Map();
  for (const text of texts) if (typeof text === 'string' && /[a-z]/i.test(text)) {
    for (const part of VOICE.audioParts(text)) inputs.set(audioKey(part), part);
  }
  return inputs;
}
function validWav(b, size = b.length) {
  return size >= 44 && size <= 6_000_000 && b.length >= 44 && b.toString('ascii', 0, 4) === 'RIFF'
    && b.readUInt32LE(4) + 8 === size && b.toString('ascii', 8, 12) === 'WAVE'
    && b.toString('ascii', 12, 16) === 'fmt ' && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1
    && b.readUInt32LE(24) === 24000 && b.readUInt16LE(34) === 16 && b.toString('ascii', 36, 40) === 'data'
    && b.readUInt32LE(40) + 44 === size;
}

export function createPreparedAudio({ dir, engine }) {
  let ready = new Set(), packs = new Map(), inputs = new Map(), queue = new Map();
  let running = false, closed = false, current = null, lastError = null, scanned = false, scanBusy = false;
  let secondsPerClip = 0, completed = 0, lastSave = 0;
  const failed = new Set();
  const root = path.resolve(dir), file = key => path.join(root, key + '.wav');
  const enabled = !!engine.enabled;
  async function directory() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('AUDIO_DIRECTORY_UNSAFE');
  }
  async function atomic(target, bytes) {
    const temp = target + '.' + crypto.randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, target);
    } finally { if (handle) await handle.close(); await fs.unlink(temp).catch(() => {}); }
  }
  async function exists(key) {
    let handle;
    try {
      const stat = await fs.lstat(file(key));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 6_000_000) return false;
      handle = await fs.open(file(key), 'r'); const header = Buffer.alloc(44); await handle.read(header, 0, 44, 0);
      return validWav(header, stat.size);
    } catch { return false; } finally { if (handle) await handle.close(); }
  }
  function status() {
    const byPack = [...packs].map(([packId, keys]) => ({ packId, total: keys.size, ready: [...keys].filter(k => ready.has(k)).length }));
    const count = [...inputs.keys()].filter(k => ready.has(k)).length;
    return { enabled, scanned, running: running || queue.size > 0, total: inputs.size, ready: count, failed: failed.size, lastError,
      remainingSeconds: secondsPerClip ? Math.ceil((inputs.size - count) * secondsPerClip) : null,
      packs: byPack, updatedAt: new Date().toISOString() };
  }
  async function saveStatus(force = false) {
    if (!force && Date.now() - lastSave < 30000) return;
    lastSave = Date.now(); await atomic(path.join(root, 'status.json'), JSON.stringify(status()));
  }
  async function pump() {
    if (running || closed || !enabled || scanBusy) return;
    running = true;
    try {
      while (queue.size && !closed) {
        const [key, text] = queue.entries().next().value; queue.delete(key); current = key;
        if (!inputs.has(key) || ready.has(key)) continue;
        const start = Date.now();
        try {
          const bytes = await engine.speak({ text, rate: 1 });
          if (!validWav(bytes)) throw new Error('AUDIO_INVALID');
          await atomic(file(key), bytes); ready.add(key); failed.delete(key); lastError = null;
          completed++; secondsPerClip += ((Date.now() - start) / 1000 - secondsPerClip) / Math.min(completed, 100);
        } catch { failed.add(key); lastError = 'PC 음성 생성 또는 저장 실패'; }
        await saveStatus();
      }
    } catch { lastError = 'PC 음성 보관 상태 저장 실패'; }
    finally { current = null; running = false; await saveStatus(true).catch(() => {}); }
  }
  async function update(records) {
    if (!enabled || closed || scanBusy) return;
    scanBusy = true;
    try {
      await directory();
      const nextPacks = new Map(), nextInputs = new Map();
      for (const pack of records) {
        // 재시작 시 큰 교재 DB가 다시 메모리에 올라와도 학생 요청을 사이사이에 처리한다.
        await new Promise(resolve => setImmediate(resolve));
        if (CHECK.rightsErrors(pack.rights).length) continue;
        const parts = packAudioInputs(pack); nextPacks.set(pack.packId, new Set(parts.keys()));
        for (const [key, text] of parts) nextInputs.set(key, text);
      }
      if (!scanned) {
        for (const entry of await fs.readdir(root)) if (/^[a-f0-9]{64}\.wav$/.test(entry)) {
          const key = entry.slice(0, 64); if (nextInputs.has(key) && await exists(key)) ready.add(key);
        }
      }
      packs = nextPacks; inputs = nextInputs;
      queue = new Map([...inputs].filter(([key]) => !ready.has(key) && key !== current));
      for (const key of failed) if (!inputs.has(key)) failed.delete(key);
      scanned = true; lastError = null; await saveStatus(true);
    } catch { lastError = 'PC 음성 보관함 준비 실패'; }
    finally { scanBusy = false; void pump(); }
  }
  async function read(pack, text) {
    const key = audioKey(text);
    if (!packAudioInputs(pack).has(key)) return { forbidden: true };
    if (!enabled) return { missing: true };
    try {
      const stat = await fs.lstat(file(key));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 6_000_000) throw new Error('AUDIO_INVALID');
      const bytes = await fs.readFile(file(key)); if (!validWav(bytes)) throw new Error('AUDIO_INVALID');
      return { bytes };
    } catch {
      ready.delete(key);
      if (inputs.has(key) && key !== current) queue = new Map([[key, text], ...queue]);
      return { missing: true };
    }
  }
  function prioritize(packId) {
    const keys = packs.get(packId);
    if (keys) queue = new Map([...queue].filter(([key]) => keys.has(key)).concat([...queue].filter(([key]) => !keys.has(key))));
  }
  return { enabled, update, read, status, prioritize, close() { closed = true; queue.clear(); } };
}
