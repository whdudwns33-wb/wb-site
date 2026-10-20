// 양식에는 공개 필드의 자리와 장식만 저장한다. 발행 자료·외부 URL은 가져오지 않는다.
const optional=new Set(['voice','guidance','goal','records']);
const required={title:'text',meta:'text',summary:'text',chart:'image',details:'text'};
export function defaultLayout() {
 const text=(name,content,y,height,size=11)=>({name,type:'text',content,position:{x:16,y},width:178,height,fontName:'BlendedKorean',fontSize:size,fontColor:'#1B3A5C',lineHeight:1.5,overflow:'expand'});
 return {basePdf:{width:210,height:297,padding:[12,12,12,12]},schemas:[[
  text('title','샘플 학생 상담 리포트',17,13,20),text('meta','수학 · 2026-10-12 ~ 2026-10-18 · 공개본',34,13,10),
  text('summary','학습 배정 5건 · 학생 완료 4건 · 강사 확인 3건',52,10,12),
  {name:'chart',type:'image',position:{x:16,y:68},width:178,height:42,content:''},
  text('details','함께 확인한 점\n풀이를 자신의 말로 설명했어요.\n\n다음 실천 목표\n오답 두 문제의 풀이 과정을 설명해요.',120,110),
  {...text('label_footer','블렌디드 · 학생·보호자 공개 리포트',275,6,8),readOnly:true}
 ]]};
}
export function validateLayout(input) {
 const bad=()=>{throw Object.assign(Error('양식의 공개 필드·글꼴·이미지·A4 범위를 확인해 주세요. 필수 항목은 지울 수 없어요.'),{status:400,code:'REPORT_LAYOUT'})};
 if(!input||typeof input!=='object'||JSON.stringify(input).length>220000||Object.keys(input).some(k=>!['basePdf','schemas'].includes(k)))bad();
 const base=input.basePdf;
 if(!base||base.width!==210||base.height!==297||!Array.isArray(base.padding)||base.padding.length!==4||base.padding.some(v=>!Number.isFinite(v)||v<0||v>30)||Object.keys(base).some(k=>!['width','height','padding'].includes(k)))bad();
 if(!Array.isArray(input.schemas)||!input.schemas.length||input.schemas.length>3)bad();
 const names=new Set(),allowed=new Set(['name','type','content','position','width','height','fontName','fontSize','fontColor','backgroundColor','alignment','verticalAlignment','lineHeight','characterSpacing','rotate','opacity','readOnly','required','overflow','underline','strikethrough','borderWidth','borderColor','color','radius','dynamicFontSize','hide','textFormat','fontVariantFallback']);
 for(const page of input.schemas){
  if(!Array.isArray(page)||page.length>40)bad();
  for(const field of page){
   if(!field||typeof field!=='object'||Object.keys(field).some(k=>!allowed.has(k))||typeof field.name!=='string'||names.has(field.name))bad();names.add(field.name);
   if(!Object.hasOwn(required,field.name)&&!optional.has(field.name)&&!/^label_[a-zA-Z0-9_-]{1,50}$/.test(field.name)&&field.name!=='logo')bad();
   if(!['text','image'].includes(field.type)||Object.hasOwn(required,field.name)&&field.type!==required[field.name])bad();
   if(!field.position||Object.keys(field.position).some(k=>!['x','y'].includes(k))||![field.position.x,field.position.y,field.width,field.height].every(Number.isFinite)||field.position.x<0||field.position.y<0||field.width<=0||field.height<=0||field.position.x+field.width>210.1||field.position.y+field.height>297.1)bad();
   if(field.fontName&&field.fontName!=='BlendedKorean'||field.fontSize!==undefined&&(!Number.isFinite(field.fontSize)||field.fontSize<6||field.fontSize>60))bad();
   if(field.type==='text'&&(typeof field.content!=='string'||field.content.length>6000))bad();
   if(field.type==='image'&&(typeof field.content!=='string'||field.content&&!/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(field.content)))bad();
   for(const key of ['fontColor','backgroundColor','borderColor','color'])if(field[key]!==undefined&&field[key]!==''&&!/^#[a-fA-F0-9]{6}$/.test(field[key]))bad();
   for(const key of ['lineHeight','characterSpacing','rotate','opacity','borderWidth','radius'])if(field[key]!==undefined&&(!Number.isFinite(field[key])||Math.abs(field[key])>360))bad();
   if(field.textFormat!==undefined&&field.textFormat!=='plain')bad();if(field.fontVariantFallback!==undefined&&!['synthetic','plain','error'].includes(field.fontVariantFallback))bad();
   if(field.dynamicFontSize!==undefined&&field.dynamicFontSize!==null){const f=field.dynamicFontSize;if(!f||Object.keys(f).some(k=>!['min','max','fit'].includes(k))||!Number.isFinite(f.min)||!Number.isFinite(f.max)||f.min<6||f.max>60||f.min>f.max||!['vertical','horizontal'].includes(f.fit))bad();}
   if(field.alignment!==undefined&&!['left','center','right','justify'].includes(field.alignment)||field.verticalAlignment!==undefined&&!['top','middle','bottom'].includes(field.verticalAlignment)||field.overflow!==undefined&&!['expand','shrink','clip','wrap'].includes(field.overflow))bad();
   if(optional.has(field.name)&&field.type!=='text')bad();
   if((Object.hasOwn(required,field.name)||optional.has(field.name))&&(field.readOnly||field.hide))bad();
   for(const key of ['readOnly','required','underline','strikethrough','hide'])if(field[key]!==undefined&&typeof field[key]!=='boolean')bad();
  }
 }
 if(Object.keys(required).some(name=>!names.has(name)))bad();
 return structuredClone(input);
}
export function designerLayout(input) {
 const template={basePdf:input.basePdf,schemas:structuredClone(input.schemas)};
 for(const page of template.schemas)for(const field of page){
  if(!Object.hasOwn(required,field.name)&&!optional.has(field.name)){
   if(!/^label_[a-zA-Z0-9_-]{1,50}$/.test(field.name)&&field.name!=='logo')field.name='label_'+crypto.randomUUID().replaceAll('-','');
   field.readOnly=true;
  }
 }
 return validateLayout(template);
}

export const reportPresets={summary:'요약형',consultation:'상담형',detail:'상세형',custom:'원장 저장 양식'};
export function reportPreset(value) {
 if(value===undefined)return 'custom';
 if(typeof value!=='string'||!Object.hasOwn(reportPresets,value))throw Object.assign(Error('리포트 형식을 다시 선택해 주세요.'),{status:400,code:'REPORT_PRESET'});
 return value;
}
export function presetLayout(preset) {
 preset=reportPreset(preset);const template=defaultLayout();if(preset==='custom')return template;
 const fields=template.schemas[0],get=name=>structuredClone(fields.find(f=>f.name===name));
 const text=(name,y,height,size=11,x=16,width=178)=>({...get('details'),name,position:{x,y},height,width,fontSize:size,content:''});
 if(preset==='summary') {fields.find(f=>f.name==='details').fontSize=12;return template;}
 if(preset==='consultation') {
  template.schemas=[[get('title'),get('meta'),text('voice',51,18,12),{...get('summary'),position:{x:16,y:74}}, {...get('chart'),position:{x:16,y:89},height:36},text('details',136,62,10.5,16,85),text('guidance',136,62,10.5,109,85),text('goal',212,46,11),get('label_footer')]];
 } else {
  template.schemas=[[get('title'),get('meta'),get('summary'),get('chart'),text('guidance',122,70),text('goal',209,48),get('label_footer')],[text('records',18,105,10),text('details',137,125,10.5)]];
 }
 return validateLayout(template);
}
