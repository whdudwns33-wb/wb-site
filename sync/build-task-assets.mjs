import { mkdir, readdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'sync/dist');
// import.meta.url에서 정한 저장소 내부의 생성물 경로만 비운다.
await rm(out,{recursive:true,force:true});
// 저장소 전체를 업로드하지 않고 실행에 필요한 정적 파일만 조립한다.
async function copy(source,target) {
  await mkdir(target,{recursive:true});
  for (const entry of await readdir(source,{withFileTypes:true})) {
    if (entry.name.startsWith('.') || /(?:\.test\.|README|AGENTS|CLAUDE|private-names)/i.test(entry.name)) continue;
    const from=path.join(source,entry.name), to=path.join(target,entry.name);
    if (entry.isDirectory()) { await copy(from,to); continue; }
    if (/\.(?:html|css|js|json|png|svg|ico|webp|woff2?)$/.test(entry.name) || entry.name==='_headers') await copyFile(from,to);
  }
}
await copy(path.join(root,'parent'),out);
await copy(path.join(root,'task'),path.join(out,'task'));
await copy(path.join(root,'shared'),path.join(out,'shared'));
await writeFile(path.join(out,'version.json'),await readFile(path.join(root,'version.json')));
console.log('task + parent assets: sync/dist');
