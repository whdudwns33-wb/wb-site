'use strict';
/* 배포가 wrangler.toml 의 D1 자리표를 실제로 갈아 끼우는지 — 지면이 아니라 절차를 잰다.
 *
 * 2026-11-21~23 의 배포 세 번이 모두 여기서 멈췄다. 워크플로우가 String.replace 로
 * 자리표를 바꾸는데 replace 는 **첫 한 자리만** 바꾼다. 그 첫 자리가 바로 위 주석이어서
 * 주석만 id 로 바뀌고 database_id 는 자리표째 남았고, wrangler 가 그대로 받아
 * 「Invalid property: databaseId => Invalid uuid [code: 7400]」로 떨어졌다.
 * 게다가 뒤따르는 guard 가 「id 가 파일 어딘가 있나」였기 때문에 주석에 들어간 id 로 통과해 버렸다.
 *
 * 그래서 두 가지를 못 박는다.
 *   ① wrangler.toml 에 자리표는 **한 자리뿐**이고 그 자리는 database_id 다.
 *   ② 워크플로우는 replaceAll 로 바꾸고, 「자리표가 남았는지」로 막는다.
 * 둘 중 하나만 지켜도 이 사고는 막히지만, 둘을 함께 두어야 다음 사람이 주석을 다시 늘려도 안전하다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toml = fs.readFileSync(path.join(here, 'wrangler.toml'), 'utf8');
const flow = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'deploy-reading.yml'), 'utf8');
const TOKEN = '__READING_MCP_D1_ID__';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('wrangler.toml 의 자리표는 한 자리뿐이다', () => {
  const hits = toml.split(TOKEN).length - 1;
  assert.equal(hits, 1, `자리표가 ${hits}자리다 — 주석에 적으면 첫 한 자리만 바꾸는 치환이 엉뚱한 곳을 바꾼다`);
});

t('그 한 자리는 database_id 다', () => {
  const line = toml.split('\n').find(l => l.includes(TOKEN));
  assert.match(line, /^database_id\s*=\s*"__READING_MCP_D1_ID__"$/, '자리표가 database_id 줄이 아니다: ' + line);
});

t('배포는 replaceAll 로 바꾼다', () => {
  assert.ok(flow.includes(`replaceAll("${TOKEN}"`), '워크플로우가 replaceAll 로 바꾸지 않는다');
  assert.ok(!new RegExp(`\\.replace\\("${TOKEN}"`).test(flow), 'replace 는 첫 한 자리만 바꾼다');
});

t('배포는 자리표가 남았는지로 막는다', () => {
  assert.ok(new RegExp(`grep -q "${TOKEN}" wrangler\\.toml`).test(flow),
    '자리표가 남았는지 보는 guard 가 없다 — 「id 가 어딘가 있나」로는 주석에 들어간 id 에 속는다');
});

t('첫 한 자리만 바꾸는 치환으로도 database_id 가 남지 않는다', () => {
  /* 지금 파일 모양에서 두 치환이 같은 결과를 내는지 직접 돌려 본다 */
  const id = '11111111-2222-3333-4444-555555555555';
  for (const out of [toml.replace(TOKEN, id), toml.replaceAll(TOKEN, id)]) {
    assert.ok(!out.includes(TOKEN), '치환 뒤에도 자리표가 남는다');
    assert.ok(out.includes(`database_id = "${id}"`), 'database_id 에 id 가 들어가지 않는다');
  }
});

console.log('OK — 배포 D1 자리표 ' + n + '/5');
