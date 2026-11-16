import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setPriority, constants } from 'node:os';

export function speechInput(body) {
  if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 800
      || !/[a-z]/i.test(body.text) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body.text)
      || (body.rate != null && (typeof body.rate !== 'number' || !Number.isFinite(body.rate) || body.rate < 0.5 || body.rate > 2))) return null;
  return { text: body.text.trim(), rate: body.rate == null ? 1 : body.rate };
}

export function createKokoro({ python, home, spawnProcess = spawn, timeoutMs = 45000 } = {}) {
  let child = null, bootTimer = null, nextId = 0, cacheBytes = 0;
  const pending = new Map(), cache = new Map();
  const unavailable = () => new Error('local-speech-unavailable');
  function fail() {
    const old = child; child = null;
    clearTimeout(bootTimer);
    if (old) old.kill();
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(unavailable()); }
    pending.clear();
  }
  function warm() {
    if (child || !python || !home) return;
    const proc = spawnProcess(python, ['-u', fileURLToPath(new URL('./kokoro-worker.py', import.meta.url))], {
      windowsHide: true, env: { ...process.env, WB_KOKORO_HOME: home, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child = proc;
    proc.once('spawn', () => { try { if (proc.pid > 0) setPriority(proc.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {} });
    bootTimer = setTimeout(fail, timeoutMs);
    const lines = createInterface({ input: proc.stdout });
    proc.on('error', () => { if (child === proc) fail(); });
    proc.on('exit', () => { lines.close(); if (child === proc) fail(); });
    proc.stdin.on('error', () => { if (child === proc) fail(); });
    lines.on('line', line => {
      if (child !== proc) return;
      let out;
      try { out = JSON.parse(line); } catch { fail(); return; }
      if (out.ready) { clearTimeout(bootTimer); return; }
      const job = pending.get(out.id);
      if (!job) return;
      pending.delete(out.id); clearTimeout(job.timer);
      const bytes = typeof out.audio === 'string' ? Buffer.from(out.audio, 'base64') : null;
      if (!bytes || bytes.length < 44 || bytes.length > 6_000_000 || bytes.toString('ascii', 0, 4) !== 'RIFF'
          || bytes.toString('ascii', 8, 12) !== 'WAVE') { job.reject(unavailable()); return; }
      cache.set(job.key, bytes); cacheBytes += bytes.length;
      while (cacheBytes > 32_000_000 || cache.size > 128) {
        const key = cache.keys().next().value; cacheBytes -= cache.get(key).length; cache.delete(key);
      }
      job.resolve(bytes);
    });
  }
  function speak(body) {
    const input = speechInput(body);
    if (!input) return Promise.reject(new Error('invalid-speech-input'));
    if (!python || !home) return Promise.reject(unavailable());
    const key = JSON.stringify(input);
    if (cache.has(key)) {
      const bytes = cache.get(key); cache.delete(key); cache.set(key, bytes);
      return Promise.resolve(bytes);
    }
    for (const job of pending.values()) if (job.key === key) return job.promise;
    if (pending.size >= 20) return Promise.reject(new Error('local-speech-busy'));
    warm();
    const id = ++nextId;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending.set(id, { key, promise, resolve, reject, timer: setTimeout(fail, timeoutMs) });
    child.stdin.write(JSON.stringify({ id, ...input }) + '\n');
    return promise;
  }
  return { enabled: !!(python && home), speak, warm, close: fail };
}
