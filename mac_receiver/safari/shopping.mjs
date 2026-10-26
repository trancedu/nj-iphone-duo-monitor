// Shared deterministic Safari workflow and standalone test CLI.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {safariDOM} from './dom.mjs';
import {signalSafari} from './feedback.mjs';
import {productURL,expectedProduct,Stop} from '../protocol.mjs';
import {chooseTimeWindow,validatePickupDetails} from '../pickup_details.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const asString=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\r','\\r')+'"';
export async function appleScript(source) {
  return new Promise((ok,bad)=>{
    const child=spawn('/usr/bin/osascript',['-'],{stdio:['pipe','pipe','pipe']});let output='',error='';
    const timer=setTimeout(()=>child.kill(),10000);
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
    child.on('error',()=>{clearTimeout(timer);bad(new Stop('safari_apple_events_unavailable'));});
    child.on('close',code=>{clearTimeout(timer);code===0?ok(output.trim()):bad(new Stop(error.includes('Allow JavaScript')?'safari_javascript_permission_required':error.includes('profile_changed')?'safari_profile_changed':error.includes('single_test_tab_required')?'safari_single_test_tab_required':'safari_apple_event_failed'));});
    child.stdin.end(source);
  });
}
export async function listSafariWindows() {
  const raw=await appleScript('if application "Safari" is not running then return ""\ntell application "Safari"\nset resultText to ""\nrepeat with w in windows\nset resultText to resultText & (id of w) & (ASCII character 9) & (name of w) & (ASCII character 9) & (count of tabs of w) & linefeed\nend repeat\nreturn resultText\nend tell');
  if(!raw)return [];
  return raw.split('\n').map(line=>{const [id,name,tabs,...extra]=line.split('\t');if(extra.length||!/^\d+$/.test(id)||!/^\d+$/.test(tabs||''))throw new Stop('safari_window_list_unrecognized');return {id:Number(id),name,tabs:Number(tabs)};});
}
export class SafariWindow {
  constructor(id,profile){if(!Number.isInteger(id)||id<1||!profile||/[\r\n\t]/.test(profile))throw new Stop('invalid_safari_window');this.id=id;this.profile=profile;}
  script(body) {
    return `tell application "Safari"\nset w to window id ${this.id}\nif name of w does not start with ${asString(this.profile+' — ')} then error "profile_changed"\nif (count of tabs of w) is not 1 then error "single_test_tab_required"\n${body}\nend tell`;
  }
  async call(op,args={}) {
    const js=`(()=>{try{return JSON.stringify({ok:true,value:(${safariDOM.toString()})(${JSON.stringify({op,args})})});}catch(e){return JSON.stringify({ok:false,error:e.message});}})()`;
    const raw=await appleScript(this.script(`return do JavaScript ${asString(js)} in tab 1 of w`));
    let result;try{result=JSON.parse(raw);}catch{throw new Stop('safari_script_response_unrecognized');}
    if(!result.ok)throw new Stop(result.error||'safari_dom_failed');return result.value;
  }
  async goto(url){const u=new URL(url);if(u.origin!=='https://www.apple.com')throw new Stop('unexpected_navigation');await appleScript(this.script(`set URL of tab 1 of w to ${asString(url)}`));}
  async reload(){await appleScript(this.script('do JavaScript "location.reload()" in tab 1 of w'));}
  async foreground(){await appleScript(this.script('set index of w to 1\nactivate'));}
}
export async function waitFor(fn,timeout=20000) {
  const start=Date.now();
  do {try{const value=await fn();if(value)return value;}catch(e){if(!['safari_navigation_pending','safari_apple_event_failed','safari_script_response_unrecognized'].includes(e.code))throw e;}await pause(100);}while(Date.now()-start<timeout);
  throw new Stop('safari_step_timeout');
}
export async function prepareSafari(window,url,config,{seedOnly=false,stage=()=>{}}={}) {
  productURL(url);const product=expectedProduct(url);const call=(op,args={})=>window.call(op,{product,...args});
  const timeout=config.step_timeout_ms??20000;
  if(!Number.isInteger(timeout)||timeout<100||timeout>60000)throw new Stop('invalid_safari_step_timeout');
  const wait=fn=>waitFor(fn,timeout);
  stage('started_at');
  let snap=await call('snapshot');
  if(new URL(snap.url).pathname!=='/shop/bag'){await window.goto('https://www.apple.com/shop/bag');snap=await wait(async()=>{const s=await call('snapshot');return s.bag.length||s.empty?s:null;});}
  stage('bag_page_ready_at');
  if(snap.empty&&!snap.bag.length) {
    await window.goto(url);await wait(async()=>(await call('productReady')).ready);
    await wait(async()=>(await call('configure')).configured);stage('care_selected_at');
    // One Add invocation; an uncertain result never repeats the add.
    await call('add');stage('add_clicked_at');
    await wait(async()=>(await call('reviewBag')).ready);
    snap=await wait(async()=>{const s=await call('snapshot');return s.bag.length?s:null;});
  }
  if(snap.bag.length!==1||snap.bag[0].title!==product||snap.bag[0].quantity!=='1')throw new Stop('bag_not_exactly_one_target');
  stage('bag_verified_at');
  if(seedOnly)return {status:'seeded',product};
  validatePickupDetails(config.pickup_details);
  await wait(async()=>(await call('checkoutReady')).ready);stage('checkout_ready_at');
  await call('checkout');stage('checkout_clicked_at');
  const openPickup=async()=>{
    await wait(async()=>(await call('pickup')).ready);
    let ready=await wait(async()=>{const s=await call('pickupReady');return s.ready||s.zipNeeded?s:null;});
    if(ready.zipNeeded){await call('zip',{zip:config.pickup_zip});await wait(async()=>(await call('pickupReady')).ready);}
  };
  await openPickup();stage('pickup_page_ready_at');
  const retries=config.pickup_unavailable_retries??5,interval=config.pickup_retry_interval_ms??1000;
  if(!Number.isInteger(retries)||retries<0||retries>10||!Number.isInteger(interval)||interval<1000||interval>10000)throw new Stop('invalid_pickup_retry_config');
  const readStores=async()=>{
    try{return await wait(async()=>{const s=(await call('stores')).stores;return s.length?s:null;});}
    catch(e){if(e instanceof Stop&&e.code==='safari_step_timeout')throw new Stop('store_list_unrecognized');throw e;}
  };
  let chosen;
  for(let i=0;i<=retries;i++) {
    stage(`pickup_check_${i}_started_at`);
    let stores=await readStores();
    const preferred=config.pickup_details.store_name;
    const matches=s=>s.name.startsWith(preferred)&&/^(?:\s|\d|Available\b|Currently\b|$)/.test(s.name.slice(preferred.length));
    if(!config.test_any_available_store&&!stores.some(matches)){const more=await call('moreStores');if(more.expanded){stores=await wait(async()=>{const s=(await call('stores')).stores;return s.some(matches)?s:null;});}}
    chosen=stores.find(s=>s.enabled&&(config.test_any_available_store||matches(s)));
    if(chosen)break;
    stage(`pickup_check_${i}_unavailable_at`);
    if(i===retries)return {status:'pickup_unavailable',product,checks:i+1};
    await pause(interval);
    // Stock can update during the pause. Recheck immediately before reload so
    // a now-available target continues without destroying its current page.
    const current=await readStores();
    chosen=current.find(s=>s.enabled&&(config.test_any_available_store||matches(s)));
    if(chosen){stage('pickup_available_before_refresh_at');break;}
    stage(`pickup_refresh_${i+1}_at`);await window.reload();await openPickup();
  }
  await wait(async()=>(await call('selectStore',{name:chosen.name})).selected);stage('store_selected_at');
  const dates=await wait(async()=>{const ds=(await call('dates')).dates;return ds.some(d=>d.enabled)?ds:null;});
  const date=dates.find(d=>d.enabled&&d.checked)||dates.find(d=>d.enabled);
  await wait(async()=>(await call('selectDate',{name:date.name})).selected);
  const options=await wait(async()=>{const os=(await call('times')).options;return os.some(o=>o.value&&!o.disabled)?os:null;});
  const time=chooseTimeWindow(options,date.name,config.pickup_details);
  await call('selectTime',{value:time.value});stage('time_selected_at');
  await call('continuePickup');stage('details_navigation_at');
  await wait(async()=>(await call('detailsReady')).ready);stage('details_page_ready_at');
  await wait(async()=>(await call('fillContact',{contact:config.pickup_details})).filled);stage('contact_verified_at');
  await wait(async()=>(await call('handoffReady')).ready);stage('handoff_at');
  await window.foreground();
  return {status:'awaiting_user',product,store:chosen.name,date:date.name,time:time.label,finalApplePayClicked:false};
}
async function main() {
  const argv=process.argv.slice(2);const value=key=>argv[argv.indexOf(key)+1];
  if(argv.includes('--list-windows')) {
    console.log(await appleScript('tell application "Safari"\nset resultText to ""\nrepeat with w in windows\nset resultText to resultText & (id of w) & (ASCII character 9) & (name of w) & (ASCII character 9) & (count of tabs of w) & linefeed\nend repeat\nreturn resultText\nend tell'));return;
  }
  const action=argv[0];if(!['inspect','seed','prepare','release'].includes(action)||!argv.includes('--window-id')||!argv.includes('--profile')||!argv.includes('--config')||!argv.includes('--url'))throw new Stop('usage_safari_shopping_action_window_profile_config_url');
  const configFile=resolve(value('--config')),config=JSON.parse(readFileSync(configFile));
  const url=productURL(value('--url'));const window=new SafariWindow(Number(value('--window-id')),value('--profile'));
  const dir=resolve(dirname(configFile),config.safari_test_state_dir||'runtime-safari');mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=join(dir,'profile-'+createHash('sha256').update(window.profile).digest('hex').slice(0,16)+'.lock');let fd;
  if(action==='release'){
    if(!argv.includes('--confirm-test-finished'))throw new Stop('explicit_test_release_required');
    const pid=Number(readFileSync(lock,'utf8'));
    try{process.kill(pid,0);throw new Stop('safari_test_still_running');}catch(e){if(e.code!=='ESRCH')throw e;}
    unlinkSync(lock);console.log(JSON.stringify({status:'test_profile_released',profile:window.profile}));return;
  }
  if(action==='inspect'){console.log(JSON.stringify(await window.call('snapshot')));return;}
  try{fd=openSync(lock,'wx',0o600);}catch{throw new Stop('safari_test_window_locked');}
  writeFileSync(fd,String(process.pid));closeSync(fd);
  const timestamps={};const out=join(dir,`safari-${window.id}-${Date.now()}.local.json`);let result;
  const save=()=>{writeFileSync(out,JSON.stringify({window_id:window.id,profile:window.profile,timestamps,...result},null,2),{mode:0o600});};
  try{
    result=action==='inspect'?await window.call('snapshot'):await prepareSafari(window,url,config,{seedOnly:action==='seed',stage:name=>{timestamps[name]=new Date().toISOString();save();}});
    timestamps.finished_at=new Date().toISOString();save();
    result.feedback=await signalSafari(window,result,{profile:window.profile,product:expectedProduct(url)});
    timestamps.feedback_completed_at=new Date().toISOString();save();console.log(JSON.stringify({...result,timestamps,report:out}));
    // Standalone harness does not reset carts or auto-run further requests.
    // A successful handoff retains a lock until the user explicitly releases it.
    if(result.status!=='awaiting_user')unlinkSync(lock);
  }catch(e){result={status:'manual_review',reason:e instanceof Stop?e.code:'safari_test_failed'};timestamps.finished_at=new Date().toISOString();save();result.feedback=await signalSafari(window,result,{profile:window.profile,product:expectedProduct(url)});timestamps.feedback_completed_at=new Date().toISOString();save();console.log(JSON.stringify({...result,timestamps,report:out}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(async e=>{const result={status:'stopped',reason:e instanceof Stop?e.code:'safari_test_failed'};const i=process.argv.indexOf('--profile');result.feedback=await signalSafari(null,result,{profile:i>=0?process.argv[i+1]:'Safari'});console.error(JSON.stringify(result));process.exitCode=1;});
