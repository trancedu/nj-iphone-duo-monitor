// Shared deterministic Safari workflow and standalone test CLI.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {safariDOM} from './dom.mjs';
import {handoffActivity} from './idle.mjs';
import {pickupLocationDOM} from '../pickup_location.mjs';
import {signalSafari} from './feedback.mjs';
import {classifyStores,sanitizeObservation} from './diagnostics.mjs';
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
    const locationOperation=['locationState','openLocation'].includes(op);
    const execute=locationOperation?pickupLocationDOM:['armIdle','idleState','claimIdleReturn'].includes(op)?handoffActivity:safariDOM;
    const input=locationOperation?{open:op==='openLocation'}:{op,args};
    const js=`(()=>{const t=performance.now();try{const value=(${execute.toString()})(${JSON.stringify(input)});return JSON.stringify({ok:true,value,dom_ms:performance.now()-t});}catch(e){return JSON.stringify({ok:false,error:e.message});}})()`;
    const bridgeStart=performance.now();
    const raw=await appleScript(this.script(`return do JavaScript ${asString(js)} in tab 1 of w`));
    let result;try{result=JSON.parse(raw);}catch{throw new Stop('safari_script_response_unrecognized');}
    this.onMetric?.({op,at:new Date().toISOString(),bridge_ms:performance.now()-bridgeStart,dom_ms:result.dom_ms,ok:result.ok});
    if(!result.ok)throw new Stop(result.error||'safari_dom_failed');return result.value;
  }
  async goto(url){const u=new URL(url);if(u.origin!=='https://www.apple.com')throw new Stop('unexpected_navigation');await appleScript(this.script(`set URL of tab 1 of w to ${asString(url)}`));}
  async reload(){await appleScript(this.script('do JavaScript "location.reload()" in tab 1 of w'));}
  async foreground(){await appleScript(this.script('set index of w to 1\nactivate'));}
  async returnToTestPickup(){
    if(!/^PickupTest[A-Za-z0-9_-]*$/.test(this.profile))throw new Stop('test_profile_required');
    const s=await this.call('snapshot'),u=new URL(s.url);
    if(!/^secure\d*\.store\.apple\.com$/.test(u.hostname)||u.pathname!=='/shop/apw/checkout'||!['PickupContact-init','Fulfillment-init'].includes(u.searchParams.get('_s')))throw new Stop('unexpected_test_checkout_page');
    if(u.searchParams.get('_s')==='PickupContact-init'){u.searchParams.set('_s','Fulfillment-init');await appleScript(this.script(`set URL of tab 1 of w to ${asString(u.href)}`));}
  }

}
export async function waitFor(fn,timeout=20000,interval=100) {
  const start=Date.now();
  do {try{const value=await fn();if(value)return value;}catch(e){if(!['safari_navigation_pending','safari_apple_event_failed','safari_script_response_unrecognized'].includes(e.code))throw e;}await pause(interval);}while(Date.now()-start<timeout);
  throw new Stop('safari_step_timeout');
}
// Only the unselected fulfillment page is eligible for standby refresh.
export async function prepareSafariStandby(window,url,config,{refresh=false,stage=()=>{}}={}){
  const product=expectedProduct(url),call=(op,args={})=>window.call(op,{product,...args});
  const wait=fn=>waitFor(fn,config.step_timeout_ms??20000);
  let state=await call('standbyState');
  if(state.session_warning){
    await call('continueShoppingSession');
    await wait(async()=>!(await call('standbyState')).session_warning);
    state=await call('standbyState');
  }
  if(state.protected)throw new Stop('standby_checkout_protected');
  if(!state.ready){
    const current=await call('snapshot');
    if(new URL(current.url).pathname!=='/shop/bag')await window.goto('https://www.apple.com/shop/bag');
    await wait(async()=>{const s=await call('snapshot');return s.ready==='complete'&&(s.empty||s.bag.length&&s.bag.every(i=>i.title&&i.quantity));});
    await prepareSafari(window,url,config,{seedOnly:true,stage});
    await wait(async()=>(await call('checkoutReady')).ready);
    await call('checkout');stage('checkout_clicked_at');
  }else if(refresh){
    const before=state;
    stage('standby_refresh_requested_at');await window.reload();stage('standby_refresh_at');
    state=await wait(async()=>{const s=await call('standbyState');return s.document_time_origin!==before.document_time_origin&&(s.expired||!s.checkout||s.pickup_ready||s.zip_needed)?s:null;});
    // Expired sessions can return to Bag or an error page. Rebuild once from
    // the verified quantity-one Bag, never loop on a stale checkout URL.
    if(state.pickup_ready)state=await wait(async()=>{const s=await call('armPickupStandby');return s.armed?s:null;});
    if(state.protected)throw new Stop('standby_checkout_protected');
    if(!state.ready)return prepareSafariStandby(window,url,config,{stage});
  }
  if(!state.pickup_selected)await wait(async()=>(await call('pickup')).ready);
  if(!state.pickup_ready)await wait(async()=>{const s=await call('pickupReady');return s.ready||s.zipNeeded;});
  const location=await call('locationState');
  if(location.displayed_zip!==config.pickup_zip){
    stage('pickup_location_correction_started_at');
    if(!location.editable)await call('openLocation');
    await wait(async()=>(await call('locationState')).editable);
    await call('zip',{zip:config.pickup_zip});
    await new Promise(r=>setTimeout(r,500));
    await wait(async()=>(await call('pickupReady')).ready);
    const actual=await call('locationState');
    if(actual.displayed_zip!==config.pickup_zip)throw new Stop('standby_zip_not_verified');
    stage('pickup_location_corrected_at');
  }
  const ready=await wait(async()=>{const s=await call('armPickupStandby');return s.armed?s:null;});
  if(!ready.ready||ready.protected)throw new Stop('standby_checkout_not_verified');
  stage('pickup_page_ready_at');
  return {status:'standby_checkout',product,zip:config.pickup_zip};
}
export async function prepareSafari(window,url,config,{seedOnly=false,stage=()=>{}}={}) {
  productURL(url);const product=expectedProduct(url);const call=(op,args={})=>window.call(op,{product,...args});
  const timeout=config.step_timeout_ms??20000;
  if(!Number.isInteger(timeout)||timeout<100||timeout>60000)throw new Stop('invalid_safari_step_timeout');
  const wait=fn=>waitFor(fn,timeout);
  stage('started_at');
  const warm=config.standby_page==='pickup_checkout'&&!seedOnly;
  if(warm)validatePickupDetails(config.pickup_details);
  if(warm)await prepareSafariStandby(window,url,config,{refresh:true,stage});
  if(!warm){
  let snap=await call('snapshot');
  if(new URL(snap.url).pathname!=='/shop/bag'){await window.goto('https://www.apple.com/shop/bag');snap=await wait(async()=>{const s=await call('snapshot');return s.bag.length||s.empty?s:null;});}
  if(!snap.empty&&(snap.ready!=='complete'||!snap.bag.length||snap.bag.some(i=>!i.title||!i.quantity))){
    snap=await wait(async()=>{const s=await call('snapshot');return s.ready==='complete'&&(s.empty||s.bag.length&&s.bag.every(i=>i.title&&i.quantity))?s:null;});
  }
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
  }
  const openPickup=async()=>{
    await wait(async()=>(await call('pickup')).ready);
    let ready=await wait(async()=>{const s=await call('pickupReady');return s.ready||s.zipNeeded?s:null;});
    if(ready.zipNeeded){await call('zip',{zip:config.pickup_zip});await wait(async()=>(await call('pickupReady')).ready);}
    if(config.standby_page==='pickup_checkout')await wait(async()=>{const s=await call('armPickupStandby');return s.armed?s:null;});
  };
  if(!warm){await openPickup();stage('pickup_page_ready_at');}
  const retries=config.pickup_unavailable_retries??2,interval=config.pickup_retry_interval_ms??1000;
  if(!Number.isInteger(retries)||retries<0||retries>10||!Number.isInteger(interval)||interval<1000||interval>10000)throw new Stop('invalid_pickup_retry_config');
  let lastRead;
  const readStores=async()=>{
    try{return await wait(async()=>{const r=await call('stores');if(!r.stores.length)return null;lastRead=r;return r.stores;});}
    catch(e){if(e instanceof Stop&&e.code==='safari_step_timeout')throw new Stop('store_list_unrecognized');throw e;}
  };
  const preferred=config.pickup_details.store_name,any=config.pickup_first_available_store!==false||config.test_any_available_store===true;
  const observe=(attempt,phase,stores,extra={})=>{
    const result=classifyStores(stores,preferred,any);
    if(lastRead?.no_availability&&!result.target&&result.verdict!=='target_store_ambiguous')result.verdict='pickup_area_unavailable';
    stage('pickup_inventory_observed_at',{kind:'pickup_inventory',attempt,phase,requested_store_name:preferred,configured_zip:config.pickup_zip,page:lastRead?.page,displayed_zip:lastRead?.displayed_zip,stores,verdict:result.verdict,...extra});
    return result;
  };
  let chosen,locationChecked=false;
  for(let i=0;i<=retries;i++) {
    stage(`pickup_check_${i}_started_at`);
    let stores=await readStores(),check=observe(i,'initial',stores);
    if(!any&&!locationChecked&&!check.target&&check.verdict!=='target_store_ambiguous'){
      locationChecked=true;
      const location=await call('locationState');
      if(location.displayed_zip!==config.pickup_zip){
        stage('pickup_location_correction_started_at');
        await call('openLocation');
        await wait(async()=>(await call('locationState')).editable);
        await call('zip',{zip:config.pickup_zip});
        await pause(500);
        await wait(async()=>(await call('pickupReady')).ready);
        stores=await readStores();check=observe(i,'after_zip_correction',stores);
        stage('pickup_location_corrected_at');
      }
    }
    if(!any&&check.verdict==='target_store_not_listed'&&!lastRead?.no_availability){
      const more=await call('moreStores');
      if(more.expanded){
        try{stores=await wait(async()=>{const r=await call('stores');if(r.stores.length)lastRead=r;return r.stores.length&&classifyStores(r.stores,preferred,any).verdict!=='target_store_not_listed'?r.stores:null;});}
        catch(error){if(error instanceof Stop&&error.code==='safari_step_timeout'){observe(i,'after_expansion',lastRead?.stores||stores,{expansion_available:true});throw new Stop('target_store_not_listed');}throw error;}
      }
      check=observe(i,'after_expansion',stores,{expansion_available:more.expanded});
    }
    if(check.verdict==='target_store_ambiguous')throw new Stop('target_store_ambiguous');
    chosen=check.target;if(chosen)break;
    stage(`pickup_check_${i}_unavailable_at`);
    if(i===retries){
      if(check.verdict==='target_store_not_listed')throw new Stop('target_store_not_listed');
      return {status:'pickup_unavailable',product,checks:i+1};
    }
    await pause(interval);
    // Recheck before reloading; keep an available target's page intact.
    const current=await readStores(),next=observe(i,'before_refresh',current);
    if(next.verdict==='target_store_ambiguous')throw new Stop('target_store_ambiguous');
    chosen=next.target;
    if(chosen){stage('pickup_available_before_refresh_at');break;}
    stage(`pickup_refresh_${i+1}_at`);await window.reload();await openPickup();
  }
  stage('pickup_stock_found_at');
  if(chosen.visible===false){
    const more=await call('moreStores');
    if(!more.expanded)throw new Stop('target_store_hidden');
    chosen=await wait(async()=>{
      const stores=await readStores(),result=classifyStores(stores,preferred,any);
      observe(null,'reveal_target',stores,{expansion_available:true});
      if(result.verdict==='target_store_not_selectable')throw new Stop('target_store_changed_after_expansion');
      if(result.verdict==='target_store_ambiguous')throw new Stop('target_store_ambiguous');
      return result.target&&result.target.visible!==false?result.target:null;
    });
    stage('target_store_revealed_at');
  }
  // selectStore verifies selection and protects this page; checked radios are never clicked again.
  const selection=await wait(async()=>{const r=await call('selectStore',{name:chosen.name,store_id:chosen.store_id});return r.selected?r:null;});
  if(selection.alreadySelected)stage('store_selection_reused_at');
  stage('store_selected_at');
  const available=await wait(async()=>{const r=await call('dates');return r.dates.some(d=>d.enabled)?r:null;});
  const date=available.dates.find(d=>d.enabled&&d.checked)||available.dates.find(d=>d.enabled);
  if(!date.checked)await wait(async()=>(await call('selectDate',{name:date.name})).selected);
  const hasTime=os=>os?.some(o=>o.value&&!o.disabled&&/^\d{1,2}:\d{2}\s*[ap]\.?m\.?/i.test(o.label));
  const options=date.checked&&hasTime(available.options)?available.options:await wait(async()=>{const os=(await call('times')).options;return hasTime(os)?os:null;});
  let time=chooseTimeWindow(options,date.name,config.pickup_details);
  await call('selectTime',{value:time.value});stage('time_selected_at');
  if(window.onPerformance)window.onPerformance('before_details',await call('performanceState'));
  let reselections=0;
  await wait(async()=>{
    const r=await call('continuePickup',{expected_time:time.value,expected_store_id:chosen.store_id,expected_date:date.name,allow_time_reselect:true});
    if(r.time_reset&&hasTime(r.options)){
      if(++reselections>3)throw new Stop('pickup_time_keeps_resetting');
      stage('pickup_time_reset_observed_at');time=chooseTimeWindow(r.options,date.name,config.pickup_details);
      await call('selectTime',{value:time.value});stage('time_reselected_at');
    }
    return r.clicked;
  });stage('details_navigation_at');
  let contactSeen=false;
  await wait(async()=>{
    const r=await call('prepareContact',{contact:config.pickup_details});
    if(r.filled&&!contactSeen){stage('details_page_ready_at');stage('contact_verified_at');contactSeen=true;}
    return r.ready;
  });
  if(config.handoff_idle_timeout_seconds>0&&config.handoff_event_id){const idle=await call('armIdle',{event_id:config.handoff_event_id});if(['tracking','payment_started'].includes(idle.status))stage('handoff_idle_armed_at');}
  if(window.onPerformance)window.onPerformance('contact_ready',await call('performanceState'));
  stage('handoff_at');
  await window.foreground();
  if(config.open_apple_pay_sheet===true){
    stage('apple_pay_sheet_requested_at');
    await call('requestApplePay',{contact:config.pickup_details}); // Exactly one invocation, never a wait/retry loop.
    stage('apple_pay_button_clicked_at');
  }
  return {status:'awaiting_user',product,store:chosen.name,date:date.name,time:time.label,finalApplePayClicked:config.open_apple_pay_sheet===true,applePayAuthenticated:false};
}
async function main() {
  const argv=process.argv.slice(2);const value=key=>argv[argv.indexOf(key)+1];
  if(argv.includes('--list-windows')) {
    console.log(await appleScript('tell application "Safari"\nset resultText to ""\nrepeat with w in windows\nset resultText to resultText & (id of w) & (ASCII character 9) & (name of w) & (ASCII character 9) & (count of tabs of w) & linefeed\nend repeat\nreturn resultText\nend tell'));return;
  }
  const action=argv[0];if(!['inspect','seed','standby','prepare','release'].includes(action)||!argv.includes('--window-id')||!argv.includes('--profile')||!argv.includes('--config')||!argv.includes('--url'))throw new Stop('usage_safari_shopping_action_window_profile_config_url');
  const configFile=resolve(value('--config')),config=JSON.parse(readFileSync(configFile));
  if(process.env.APPLE_PICKUP_ZIP!==undefined){if(!/^\d{5}$/.test(process.env.APPLE_PICKUP_ZIP))throw new Stop('invalid_pickup_zip');config.pickup_zip=process.env.APPLE_PICKUP_ZIP;}
  const url=productURL(value('--url'));const window=new SafariWindow(Number(value('--window-id')),value('--profile'));
  if(argv.includes('--test-auto-cancel-apple-pay'))throw new Stop('automatic_wallet_cancellation_disabled');
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
  const timestamps={},observations=[],metrics=[],performanceMarkers=[];const out=join(dir,`safari-${window.id}-${Date.now()}.local.json`);let result;
  const trace=argv.includes('--trace')||argv.includes('--trace-bridge');
  if(trace)window.onMetric=m=>metrics.push(m);
  if(argv.includes('--trace'))window.onPerformance=(label,data)=>performanceMarkers.push({label,data});
  const save=()=>{writeFileSync(out,JSON.stringify({window_id:window.id,profile:window.profile,timestamps,observations,...(trace?{metrics,performance_markers:performanceMarkers}:{}),...result},null,2),{mode:0o600});};
  const stage=(name,detail)=>{timestamps[name]=new Date().toISOString();if(detail)observations.push({at:timestamps[name],...sanitizeObservation({...detail,backend:'safari',profile:window.profile,window_id:window.id})});save();};
  const feedback=async()=>argv.includes('--quiet')?{audio_skipped:'quiet_test'}:signalSafari(window,result,{speech_enabled:config.speech_enabled,profile:window.profile,product:expectedProduct(url)});
  try{
    stage('command_started_at');
    if(action==='standby'&&argv.includes('--adopt-test-standby')){
      if(!/^PickupTest[A-Za-z0-9_-]*$/.test(window.profile))throw new Stop('test_profile_required');
      if(argv.includes('--return-to-pickup'))await window.returnToTestPickup();
      await waitFor(async()=>{const s=await window.call('standbyState',{product:expectedProduct(url)});return s.pickup_ready&&s.pickup_selected;},config.step_timeout_ms??20000);
      await window.call('armPickupStandby',{product:expectedProduct(url),explicit_test_reset:true});
    }
    if(action==='prepare'&&argv.includes('--require-standby')){
      const s=await window.call('standbyState',{product:expectedProduct(url)}),location=await window.call('locationState');
      if(!s.ready||s.protected||s.expired||!s.pickup_selected||location.displayed_zip!==config.pickup_zip)throw new Stop('verified_pickup_standby_required');
      stage('verified_standby_at');
    }
    if(action==='standby'&&argv.includes('--return-to-standby')){
      // Explicit standalone test reset; never invoked by incoming inventory.
      await window.goto('https://www.apple.com/shop/bag');
      await waitFor(async()=>{const s=await window.call('snapshot');return s.ready==='complete'&&s.bag.length&&s.bag.every(i=>i.title&&i.quantity);},config.step_timeout_ms??20000);
    }
    result=action==='standby'?await prepareSafariStandby(window,url,config,{stage}):await prepareSafari(window,url,config,{seedOnly:action==='seed',stage});
    timestamps.finished_at=new Date().toISOString();save();
    result.feedback=await feedback();
    timestamps.feedback_completed_at=new Date().toISOString();save();console.log(JSON.stringify({...result,timestamps,report:out}));

    // Standalone harness does not reset carts or auto-run further requests.
    // A successful handoff retains a lock until the user explicitly releases it.
    if(result.status!=='awaiting_user')unlinkSync(lock);
  }catch(e){result={status:'manual_review',reason:e instanceof Stop?e.code:'safari_test_failed'};timestamps.finished_at=new Date().toISOString();save();result.feedback=await feedback();timestamps.feedback_completed_at=new Date().toISOString();save();console.log(JSON.stringify({...result,timestamps,report:out}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(async e=>{const result={status:'stopped',reason:e instanceof Stop?e.code:'safari_test_failed'};const i=process.argv.indexOf('--profile');result.feedback=await signalSafari(null,result,{profile:i>=0?process.argv[i+1]:'Safari'});console.error(JSON.stringify(result));process.exitCode=1;});
