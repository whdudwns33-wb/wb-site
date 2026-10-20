import {generate} from '@pdfme/generator';
import {text,image} from '@pdfme/schemas';
import {validateLayout} from './report-layout.mjs';
export const plugins={'텍스트':text,'이미지':image};
let loadedFont;
export async function fontOptions() {loadedFont ||= fetch('/blended/reports/NotoSansKR-194018e6.ttf').then(r=>{if(!r.ok)throw Error('한글 글꼴을 불러오지 못했어요. 다시 시도해 주세요.');return r.arrayBuffer();}).catch(e=>{loadedFont=null;throw e;});return {font:{BlendedKorean:{data:await loadedFont,fallback:true}},lang:'ko'};}
export async function downloadPdf(template,inputs,title,beforeDownload=async()=>{}) {
 const valid=validateLayout(template),options=await fontOptions();
 const bytes=await generate({template:valid,inputs:[inputs],plugins,options});
 await beforeDownload();const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),a=document.createElement('a');a.href=url;a.download=title.replace(/[<>:"/\\|?*]/g,'')+'.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
