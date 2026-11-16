/* Mac 로컬 서버 전용. 워커·학생 인증과 분리하고 두 관리자 서버는 같은 해시/세대를 읽는다. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const random = () => crypto.randomBytes(32).toString('hex');
const derive = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const equal = (a, b) => {
  const hash = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
};
const validPassword = p => typeof p === 'string' && p.length >= 10 && Buffer.byteLength(p) <= 1024 && !/[\x00-\x1f\x7f]/.test(p);
const failure = (status, error) => ({ ok: false, status, error });

export function resetState(id, temporaryPassword) {
  if (typeof id !== 'string' || !id.trim() || typeof temporaryPassword !== 'string' || !temporaryPassword) throw Error('Invalid reset input');
  const salt = random();
  return { version: 1, id: id.trim(), salt, hash: derive(temporaryPassword, salt), epoch: random(), mustChange: true };
}

export function createLocalAdminCredentials(file) {
  if (!path.isAbsolute(file) || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw Error('Invalid credential boundary');
  const parent = fs.statSync(path.dirname(file));
  if (parent.uid !== process.getuid() || (parent.mode & 0o077)) throw Error('Invalid credential directory permissions');
  const tickets = new Map(), attempts = new Map();
  function read() {
    const current = fs.lstatSync(path.dirname(file));
    if (!current.isDirectory() || current.dev !== parent.dev || current.ino !== parent.ino
        || current.uid !== process.getuid() || (current.mode & 0o077)
        || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw Error('Invalid credential directory boundary');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o077) || s.size > 4096) throw Error('Invalid credential file permissions');
      const r = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (r.version !== 1 || typeof r.id !== 'string' || !r.id || typeof r.mustChange !== 'boolean'
          || !['salt', 'hash', 'epoch'].every(k => typeof r[k] === 'string' && /^[a-f0-9]{64}$/.test(r[k]))) throw Error('Invalid credential record');
      return r;
    } finally { fs.closeSync(fd); }
  }
  read(); // 잘못된 설정이면 기존 환경 비밀번호로 돌아가지 않고 기동을 거부한다.
  function allowed(ip) {
    const now = Date.now();
    for (const [key, r] of attempts) if (r.until <= now) attempts.delete(key);
    let r = attempts.get(ip);
    if (!r) {
      if (attempts.size >= 10000) return false;
      r = { until: now + 15 * 60_000, count: 0 }; attempts.set(ip, r);
    }
    return ++r.count <= 20;
  }
  return {
    epoch: () => read().epoch,
    accepts: rec => { const r = read(); return !r.mustChange && rec.adminEpoch === r.epoch; },
    login(body, ip) {
      if (!allowed(ip)) return failure(429, '잠시 후 다시 로그인해 주세요.');
      const r = read(), b = body || {};
      const id = typeof b.id === 'string' ? b.id.trim() : '';
      const pw = typeof b.password === 'string' && Buffer.byteLength(b.password) <= 1024 ? b.password : '';
      const idOk = equal(id, r.id), pwOk = equal(derive(pw, r.salt), r.hash);
      if (!idOk || !pwOk) return failure(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
      if (!r.mustChange) return { ok: true, via: 'account', epoch: r.epoch };
      const now = Date.now();
      for (const [key, t] of tickets) if (t.until <= now || t.epoch !== r.epoch) tickets.delete(key);
      if (tickets.size >= 100) return failure(429, '잠시 후 다시 로그인해 주세요.');
      const token = random(); tickets.set(token, { epoch: r.epoch, until: now + 5 * 60_000 });
      // 이 표식은 일반 관리 토큰 저장소에 들어가지 않는다.
      return { ok: true, passwordChangeRequired: true, changeToken: token };
    },
    change(token, body) {
      const t = tickets.get(token), r = read();
      if (!t || t.until <= Date.now() || t.epoch !== r.epoch || !r.mustChange) return failure(401, '다시 로그인한 뒤 비밀번호를 변경해 주세요.');
      const b = body || {};
      if (!validPassword(b.password) || b.password !== b.confirmPassword) return failure(400, '새 비밀번호를 10자 이상 동일하게 두 번 입력해 주세요.');
      if (equal(derive(b.password, r.salt), r.hash)) return failure(400, '임시 비밀번호와 다른 비밀번호를 설정해 주세요.');
      let lock;
      try { lock = fs.openSync(file + '.lock', 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') return failure(409, '다른 화면에서 변경 중입니다. 잠시 후 다시 시도해 주세요.'); throw e; }
      const tmp = file + '.' + random() + '.tmp';
      try {
        if (read().epoch !== r.epoch) return failure(409, '비밀번호가 이미 변경되었습니다. 다시 로그인해 주세요.');
        const salt = random();
        const next = { ...r, salt, hash: derive(b.password, salt), epoch: random(), mustChange: false };
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
        const dir = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        tickets.clear();
        return { ok: true, via: 'account', epoch: next.epoch };
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        fs.closeSync(lock); fs.unlinkSync(file + '.lock');
      }
    },
  };
}
