/* PR 번들 관문이 배포 워커를 빠뜨리거나 수동 시크릿 도구 버전이 갈라지는 것을 막는다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = name => fs.readFileSync(fileURLToPath(new URL('../.github/workflows/' + name, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const steps = source => source.split(/^      - /m).slice(1);
const checks = read('checks.yml');
const checkSteps = steps(checks);

assert.doesNotMatch(checks, /\$\{\{\s*secrets\./, 'PR 검증은 저장소 시크릿을 사용하지 않는다');
for (const [dir, build] of [['reading-server', 'build-dist.mjs'], ['desk', 'build.mjs'], ['crm', 'build.mjs']]) {
  const step = checkSteps.find(s => s.includes('working-directory: ' + dir + '\n') && s.includes('deploy --dry-run'));
  assert.ok(step, dir + ' 워커의 PR dry-run 이 없다');
  assert.ok(step.indexOf('node ' + build) >= 0 && step.indexOf('node ' + build) < step.indexOf('deploy --dry-run'),
    dir + ' 의 자산을 먼저 조립해야 깨끗한 체크아웃에서도 번들할 수 있다');
  const outdir = step.match(/--outdir=(\S+)/)?.[1];
  assert.ok(outdir, dir + ' 의 번들 출력 경로가 없다');
  assert.ok(step.includes("if grep -l 'node:' " + outdir + '/*.js; then'), dir + ' 에 Node 잔류 관문이 없다');
  assert.match(step, /if grep[^\n]+\n[\s\S]*?exit 1\n\s+fi/, dir + ' 의 Node 잔류 관문이 실패로 종료하지 않는다');
}

const version = checks.match(/^  WRANGLER: (wrangler@\d+\.\d+\.\d+)$/m)?.[1];
assert.ok(version, 'PR 검증의 Wrangler 버전이 정확히 고정돼야 한다');
for (const file of ['admin-secrets.yml', 'vocab-secrets.yml']) {
  const workflow = read(file);
  assert.equal(workflow.match(/^  WRANGLER: (\S+)$/m)?.[1], version, file + ' 도 배포와 같은 Wrangler 버전을 쓴다');
  assert.match(workflow, /key: npx-\$\{\{ runner\.os \}\}-\$\{\{ env\.WRANGLER \}\}/, file + ' 캐시 키가 도구 버전을 포함해야 한다');
  assert.doesNotMatch(workflow, /npx\s+wrangler@/, file + ' 에 개별 Wrangler 버전 호출이 남아 있다');
  assert.match(workflow, /npx --yes --prefer-offline \$WRANGLER secret/, file + ' 시크릿 호출이 고정 버전을 써야 한다');
}

const portal = steps(read('admin-secrets.yml')).find(s => s.includes('inputs.portal_link'));
assert.ok(portal, '부모 포털 키 등록 스텝이 없다');
assert.match(portal, /if \[ -z "\$\{KEY:-\}" \]; then\n[^\n]*Settings → Secrets and variables → Actions/, '미등록 키는 등록 위치를 안내해야 한다');
assert.match(portal, /if \[ "\$\{#KEY\}" -lt 32 \]; then\n[^\n]*32자 이상/, '짧은 키를 미등록과 구분해야 한다');
assert.ok(portal.indexOf('echo "::add-mask::$KEY"') >= 0 && portal.indexOf('echo "::add-mask::$KEY"') < portal.indexOf("printf '%s'"),
  '부모 포털 키는 외부 명령으로 보내기 전에 마스킹해야 한다');
console.log('workflow-safety: PR 워커 3곳·고정 버전·부모 포털 키 관문 통과');
