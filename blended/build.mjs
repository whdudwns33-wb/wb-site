import { mkdirSync,copyFileSync } from 'node:fs';
const target=new URL('./dist/blended/',import.meta.url);
mkdirSync(target,{recursive:true});
for(const name of ['index.html','app.js','style.css']) copyFileSync(new URL('./'+name,import.meta.url),new URL(name,target));
copyFileSync(new URL('../shared/external-links.js',import.meta.url),new URL('external-links.js',target));
console.log('블렌디드 공개 자산 4개 조립 완료 · DB/서버/시험/인증정보 제외');
