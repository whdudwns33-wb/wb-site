import { mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,readdirSync,unlinkSync } from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import { plannerAssets } from './planner-build.mjs';
const target=new URL('./dist/blended/',import.meta.url);
mkdirSync(target,{recursive:true});
for(const name of ['index.html','app.js','style.css','navigation.js','ui.css']) copyFileSync(new URL('./'+name,import.meta.url),new URL(name,target));
copyFileSync(new URL('../shared/external-links.js',import.meta.url),new URL('external-links.js',target));
mkdirSync(new URL('planner/',target),{recursive:true});
for(const [name,content] of Object.entries(plannerAssets()))writeFileSync(new URL('planner/'+name,target),content);
const reports=new URL('reports/',target);mkdirSync(reports,{recursive:true});
copyFileSync(new URL('./reports.html',import.meta.url),new URL('index.html',reports));copyFileSync(new URL('./reports.css',import.meta.url),new URL('reports.css',reports));
for(const name of readdirSync(reports))if(/^chunk-[A-Z0-9]+\.js(?:\.LEGAL\.txt)?$/.test(name))unlinkSync(new URL(name,reports));
await build({entryPoints:[fileURLToPath(new URL('./reports-page.js',import.meta.url))],outdir:fileURLToPath(reports),bundle:true,splitting:true,format:'esm',platform:'browser',external:['node:*'],target:'es2022',minify:true,legalComments:'linked',chunkNames:'chunk-[hash]'});
mkdirSync(new URL('vendor/',reports),{recursive:true});copyFileSync(new URL('./node_modules/clawpdf/dist/vendor/pdfium.esm.wasm',import.meta.url),new URL('vendor/pdfium.esm.wasm',reports));
const cache=new URL('./.cache/',import.meta.url);mkdirSync(cache,{recursive:true});
for(const [name,remote,sha]of [['NotoSansKR-194018e6.ttf','NotoSansKR%5Bwght%5D.ttf','194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252'],['FONT-LICENSE.txt','OFL.txt','1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9']]) {
 const file=new URL(name,cache);if(!existsSync(file)){const response=await fetch('https://raw.githubusercontent.com/google/fonts/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr/'+remote);if(!response.ok)throw Error('한글 글꼴을 준비하지 못했어요.');writeFileSync(file,Buffer.from(await response.arrayBuffer()));}
 if(createHash('sha256').update(readFileSync(file)).digest('hex')!==sha)throw Error('글꼴 원본 해시를 확인해 주세요.');copyFileSync(file,new URL(name,reports));
}
copyFileSync(new URL('./node_modules/echarts/LICENSE',import.meta.url),new URL('ECHARTS-LICENSE.txt',reports));
writeFileSync(new URL('PDFME-LICENSE.txt',reports),'pdfme 6.2.6 · MIT License\nCopyright (c) 2020 HandDot\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n');
console.log('블렌디드·원본 플래너 자산 조립 완료 · DB/서버/시험/인증정보 제외');

for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])copyFileSync(new URL('./node_modules/clawpdf/'+name,import.meta.url),new URL('PDFIUM-'+name.replace('.md','')+'.txt',reports));
