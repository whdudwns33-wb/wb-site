'use strict';
/* 빌드와 PC 서버가 같은 셸 내용 해시를 쓰며 원본 파일은 변경하지 않는다. */
import fs from 'node:fs';
import crypto from 'node:crypto';

export function stampServiceWorker(swPath, shellPaths, prefix) {
  const original = fs.readFileSync(swPath, 'utf8');
  const hash = crypto.createHash('sha256');
  for (const file of shellPaths.slice().sort()) hash.update(fs.readFileSync(file));
  hash.update(original);
  const tag = prefix + '-' + hash.digest('hex').slice(0, 10);
  const source = original.replace(/const VERSION = '[^']*';/, `const VERSION = '${tag}';`);
  if (source === original) throw new Error(`${swPath}: VERSION 을 못 바꿨습니다 — sw.js 의 선언 형태가 바뀌었나 봅니다`);
  return { tag, source };
}
