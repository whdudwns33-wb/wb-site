import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';

// DB의 상위 지도는 순회하고 개별 레코드만 직렬화해 전체 교재 크기의 문자열을 만들지 않는다.
function* jsonParts(value, depth = 0) {
  if (typeof value === 'string' && value.length > 32768) {
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 32768, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end;
    }
    yield '"'; return;
  }
  if (!value || typeof value !== 'object' || depth >= 3 || typeof value.toJSON === 'function') {
    yield JSON.stringify(value); return;
  }
  const array = Array.isArray(value);
  yield array ? '[' : '{';
  let first = true;
  for (const key of array ? Array.from({ length: value.length }, (_, i) => i) : Object.keys(value)) {
    const item = value[key], omitted = item === undefined || typeof item === 'function' || typeof item === 'symbol';
    if (omitted && !array) continue;
    if (!first) yield ','; first = false;
    if (!array) yield JSON.stringify(key) + ':';
    if (omitted) yield 'null'; else yield* jsonParts(item, depth + 1);
  }
  yield array ? ']' : '}';
}

export async function writeJson(file, value) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    let parts = [], size = 0;
    for (const part of jsonParts(value)) {
      parts.push(part); size += part.length;
      if (size < 262144) continue;
      fs.writeFileSync(fd, parts.join('')); parts = []; size = 0;
      await setImmediate();
    }
    if (size) fs.writeFileSync(fd, parts.join(''));
    await new Promise((resolve, reject) => fs.fsync(fd, e => e ? reject(e) : resolve()));
  } finally { fs.closeSync(fd); }
}
