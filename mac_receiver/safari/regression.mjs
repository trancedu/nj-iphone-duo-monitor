// Isolated live Safari smoke test; shares the production workflow, never clicks Pay.
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SafariWindow,listSafariWindows,prepareSafariStandby,prepareSafari,waitFor} from './shopping.mjs';
import {expectedProduct,productURL} from '../protocol.mjs';
export function testConfig(base,profile,url){
 if(!/^PickupTest[A-Za-z0-9_-]*$/.test(profile))throw Error('isolated_test_profile_required');
 if(!new URL(productURL(url)).pathname.includes('/iphone-18'))throw Error('iphone18_test_product_required');
 return {...base,safari_profile:profile,standby_page:'pickup_checkout',pickup_zip:'07094',open_apple_pay_sheet:false,handoff_idle_timeout_seconds:0,speech_enabled:false,pickup_first_available_store:true,test_any_available_store:true,pickup_details:{...base.pickup_details,preferred_slot:2}};
}
export async function runRound(window,url,config){
 const product=expectedProduct(url),before=await window.call('snapshot');
 const page=new URL(before.url);
 if(!/^secure\d*\.store\.apple\.com$/.test(page.hostname)||!['Fulfillment-init','PickupContact-init'].includes(page.searchParams.get('_s')))throw Error('test_checkout_start_required');
 const protection=await window.call('standbyState',{product});
 if(protection.protection?.payment_requested)throw Error('test_wallet_history_requires_manual_reset');
 // Explicit test-only reset from contacts; never used by the production receiver.
 await window.returnToTestPickup();
 await waitFor(async()=>{const s=await window.call('standbyState',{product});return s.pickup_ready&&s.pickup_selected;},config.step_timeout_ms??20000);
 await window.call('armPickupStandby',{product,explicit_test_reset:true});
 await prepareSafariStandby(window,url,{...config,urgent_same_configuration_retry:false});
 const initial=await window.call('standbyState',{product}),location=await window.call('locationState');
 if(!initial.ready||initial.protected||!initial.pickup_selected||location.displayed_zip!=='07094')throw Error('test_start_not_verified');
 const timestamps={},actions=[];const started=performance.now();
 const guarded=new Proxy(window,{get(target,key){
  if(['goto','reload','call'].includes(key))return async(...args)=>{
   const op=key==='call'?args[0]:key;actions.push(op);
   if(key==='goto'||op==='checkout'||op==='add'||op==='requestApplePay')throw Error('regression_forbidden_action_'+op);
   return target[key](...args);
  };
  const v=target[key];return typeof v==='function'?v.bind(target):v;
 }});
 const result=await prepareSafari(guarded,url,config,{stage:name=>timestamps[name]=new Date().toISOString()});
 const elapsed_ms=Math.round(performance.now()-started);
 if(result.status!=='awaiting_user'||result.finalApplePayClicked!==false||!timestamps.contact_verified_at)throw Error('regression_did_not_reach_verified_contact');
 const end=await window.call('standbyState',{product});
 if(!end.protection?.final_button_visible||end.protection.payment_requested)throw Error('regression_final_page_not_verified');
 return {status:'passed',elapsed_ms,timestamps,actions,final_button_visible:true,payment_clicked:false,payment_sheet_verified:false};
}
async function main(){
 const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
 for(const key of ['--config','--url'])if(!args.includes(key))throw Error('usage_--config_FILE_--url_IPHONE18_URL_[--rounds_1_to_3]');
 const profile=args.includes('--profile')?arg('--profile'):'PickupTest18Pro';
 const rounds=args.includes('--rounds')?Number(arg('--rounds')):1;
 if(!Number.isInteger(rounds)||rounds<1||rounds>3)throw Error('rounds_must_be_1_to_3');
 const config=testConfig(JSON.parse(readFileSync(resolve(arg('--config')))),profile,arg('--url'));
 // Safari can retain a closing window with zero tabs in AppleScript inventory.
 const windows=(await listSafariWindows()).filter(w=>w.name.startsWith(profile+' — ')&&w.tabs>0);
 if(windows.length!==1||windows[0].tabs!==1)throw Error('single_test_window_required');
 const reportDir=resolve('runtime/safari-regression');mkdirSync(reportDir,{recursive:true,mode:0o700});
 const lock=resolve(reportDir,profile+'.lock'),fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
 const source=dirname(fileURLToPath(import.meta.url));
 const hashes=Object.fromEntries(['shopping.mjs','dom.mjs','browser.mjs'].map(f=>[f,createHash('sha256').update(readFileSync(resolve(source,f))).digest('hex')]));
 const report={started_at:new Date().toISOString(),profile,product:expectedProduct(arg('--url')),hashes,rounds:[],status:'running'};
 const output=resolve(reportDir,Date.now()+'.json');
 const save=()=>writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
 try{
  save();const window=new SafariWindow(windows[0].id,profile);
  for(let i=0;i<rounds;i++){report.rounds.push(await runRound(window,arg('--url'),config));save();}
  report.status='passed';
 }catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}
 finally{report.finished_at=new Date().toISOString();save();unlinkSync(lock);}
 console.log(JSON.stringify({status:report.status,report:output,elapsed_ms:report.rounds.map(r=>r.elapsed_ms),error:report.error}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
