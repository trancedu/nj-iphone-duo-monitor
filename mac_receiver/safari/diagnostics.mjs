import {appendFileSync,existsSync,statSync,renameSync,unlinkSync} from 'node:fs';
const text=(v,n=200)=>typeof v==='string'?v.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,n):null;
const code=v=>typeof v==='string'&&/^[a-z0-9_]{1,80}$/.test(v)?v:null;
export function sanitizeObservation(input={}) {
  const page=input.page||{},origin=text(page.origin,100),path=text(page.path,200);
  return {kind:code(input.kind),attempt:Number.isInteger(input.attempt)?input.attempt:null,phase:code(input.phase),
    backend:input.backend==='safari'?'safari':null,profile:text(input.profile,80),window_id:Number.isInteger(input.window_id)?input.window_id:null,
    requested_store_name:text(input.requested_store_name),requested_store_id:text(input.requested_store_id,40),
    page:{origin:origin&&/^https:\/\/(?:www\.apple\.com|secure\d*\.store\.apple\.com)$/.test(origin)?origin:null,path:['/shop/apw/checkout','/shop/bag'].includes(path)?path:null,state:['Fulfillment-init','PickupContact-init'].includes(page.state)?page.state:null},
    displayed_zip:/^\d{5}$/.test(input.displayed_zip||'')?input.displayed_zip:null,
    displayed_location:text(input.displayed_location,100),
    configured_zip:/^\d{5}$/.test(input.configured_zip||'')?input.configured_zip:null,
    verdict:code(input.verdict),error_code:code(input.error_code),expansion_available:typeof input.expansion_available==='boolean'?input.expansion_available:null,
    stores:Array.isArray(input.stores)?input.stores.slice(0,40).map(s=>({name:text(s.name),store_id:text(s.store_id,40),availability_text:text(s.availability_text,80),enabled:s.enabled===true,visible:typeof s.visible==='boolean'?s.visible:null})):[]};
}
// Dedicated diagnostic history: 10 MiB per file, two older files retained.
export function appendDiagnostic(file,record,maxBytes=10*1024*1024) {
  const line=JSON.stringify(record)+'\n';
  if(existsSync(file)&&statSync(file).size+Buffer.byteLength(line)>maxBytes){
    if(existsSync(file+'.2'))unlinkSync(file+'.2');
    if(existsSync(file+'.1'))renameSync(file+'.1',file+'.2');renameSync(file,file+'.1');
  }
  appendFileSync(file,line,{mode:0o600});
}
export function classifyStores(stores,requested,any=false) {
  const matches=s=>s.name.startsWith(requested)&&/^(?:\s|\d|Available\b|Currently\b|$)/.test(s.name.slice(requested.length));
  const targets=any?stores:stores.filter(matches);
  return {verdict:!targets.length?'target_store_not_listed':!any&&targets.length>1?'target_store_ambiguous':targets.some(s=>s.enabled)?'target_store_selectable':'target_store_not_selectable',target:targets.find(s=>s.enabled)};
}
