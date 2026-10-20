import {Designer} from '@pdfme/ui';
import {plugins,fontOptions} from './report-pdf.js';
export async function createDesigner(host,template) {
 return new Designer({domContainer:host,template:structuredClone(template),plugins,options:{...await fontOptions(),theme:{token:{colorPrimary:'#6d28d9',colorText:'#1b3a5c',fontFamily:'"Noto Sans KR","Malgun Gothic",sans-serif'}},sidebarOpen:true}});
}
