// Read-only production page verification: no reload, navigation or clicks.
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SafariWindow,listSafariWindows} from './shopping.mjs';
import {expectedProduct} from '../protocol.mjs';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
if(!args.includes('--config'))throw Error('usage_--config_ROUTER_FILE_[--deployed-root_DIRECTORY]');
const config=JSON.parse(readFileSync(resolve(arg('--config')))),windows=await listSafariWindows();
const results=[];
for(const slot of config.slots||[]){
 try{
  const matches=windows.filter(w=>w.name.startsWith(slot.safari_profile+' — '));
  if(matches.length!==1||matches[0].tabs!==1)throw Error('profile_window_not_unique');
  const w=new SafariWindow(matches[0].id,slot.safari_profile),product=expectedProduct(slot.product_url);
  const state=await w.call('standbyState',{product}),location=await w.call('locationState');
  const passed=state.ready&&!state.protected&&!state.abandoned&&!state.expired&&!state.session_warning&&state.pickup_selected&&location.displayed_zip===(process.env.APPLE_PICKUP_ZIP??slot.pickup_zip??config.pickup_zip);
  results.push({profile:slot.label,passed,ready:state.ready,pickup_selected:state.pickup_selected,zip:location.displayed_zip,expired:state.expired,session_warning:state.session_warning,protection:state.protection,payment_sheet_verified:false});
 }catch(e){results.push({profile:slot.label,passed:false,error:e.message});}
}
const sources={};
if(args.includes('--deployed-root')){
 const base=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 for(const f of ['safari/dom.mjs','safari/browser.mjs','safari/shopping.mjs','engine.mjs','profile_router.mjs']){
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  sources[f]=hash(resolve(base,f))===hash(resolve(arg('--deployed-root'),f));
 }
}
const passed=results.length>0&&results.every(r=>r.passed)&&Object.values(sources).every(Boolean);
console.log(JSON.stringify({at:new Date().toISOString(),status:passed?'passed':'attention_required',read_only:true,source_matches:sources,profiles:results},null,2));
if(!passed)process.exitCode=1;
