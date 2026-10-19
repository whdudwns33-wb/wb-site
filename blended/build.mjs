import { mkdirSync,copyFileSync,writeFileSync } from 'node:fs';
import { plannerAssets } from './planner-build.mjs';
const target=new URL('./dist/blended/',import.meta.url);
mkdirSync(target,{recursive:true});
for(const name of ['index.html','app.js','style.css']) copyFileSync(new URL('./'+name,import.meta.url),new URL(name,target));
copyFileSync(new URL('../shared/external-links.js',import.meta.url),new URL('external-links.js',target));
mkdirSync(new URL('planner/',target),{recursive:true});
for(const [name,content] of Object.entries(plannerAssets()))writeFileSync(new URL('planner/'+name,target),content);
console.log('블렌디드·원본 플래너 자산 조립 완료 · DB/서버/시험/인증정보 제외');
