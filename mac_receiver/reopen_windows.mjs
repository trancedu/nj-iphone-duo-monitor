// Explicit user-run window recycling. No operation here submits an order.
import http from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {SafariWindow,listSafariWindows,appleScript,waitFor,withPreparationTimeout} from './safari/shopping.mjs';
import {runGuestDOM} from './safari/guest_checkout.mjs';
import {prepareGuestPaymentSession,validateSetupProfile} from './safari/guest_setup.mjs';
import {safeErrorCode} from './safari/diagnostics.mjs';
const titles={A:'256 白',B:'256 黑',C:'512 白',D:'512 黑',E:'1024 白（1TB）',F:'1024 黑（1TB）'};
export function assertRecyclable(profile,page,standby){
 if(profile.active_event_id||profile.request_reserved||profile.maintenance_in_progress||profile.recovery_pending)throw Error('profile_busy');
 if(page.path==='/shop/signIn'&&page.guest===true)return;
 if(page.path!=='/shop/checkout'||!['Fulfillment','Fulfillment-init'].includes(page.step)||!standby.ready||!standby.pickup_selected||!standby.matching_product||standby.protected||standby.expired||standby.session_warning||standby.protection?.payment_requested||standby.protection?.script_store_selected)throw Error('idle_pickup_required');
}
export function openProfileScript(profile){
 if(!/^Duo(?:256|512|1024)(?:White|Black)$/.test(profile))throw Error('unsupported_profile');
 return `tell application "Safari" to activate\ntell application "System Events"\ntell process "Safari"\nclick menu bar item "File" of menu bar 1\nclick menu item ${JSON.stringify('New '+profile+' Window')} of menu 1 of menu item "New Window" of menu 1 of menu bar item "File" of menu bar 1\nend tell\nend tell`;
}
function memory(){const r=spawnSync('/bin/ps',['-Ao','rss=,comm='],{encoding:'utf8'});let rss=0,count=0;for(const line of (r.stdout||'').split('\n'))if(line.includes('com.apple.WebKit.WebContent')){rss+=Number(line.trim().split(/\s+/)[0])||0;count++;}return {webkit_resident_kib:rss,webkit_processes:count};}
function select(){const choices=['全部六个窗口',...Object.values(titles)];const script=`set selected to choose from list {${choices.map(JSON.stringify).join(',')}} with title "重建 Safari 自提窗口" with prompt "逐个关闭并重开空闲窗口，重新准备付款及自提；不下单。"\nif selected is false then return ""\nreturn item 1 of selected`;const r=spawnSync('/usr/bin/osascript',['-e',script],{encoding:'utf8'});if(r.status!==0)throw Error('selection_failed');const name=r.stdout.trim();return name==='全部六个窗口'?'all':Object.keys(titles).find(k=>titles[k]===name);}
export async function main(){
 const root=resolve(homedir(),'Library/Application Support/iPhoneDuo/receiver-safari'),cfg=JSON.parse(readFileSync(join(root,'receiver.router.local.json'))),args=process.argv.slice(2);
 const selection=args.includes('--all')?'all':args.includes('--profile')?args[args.indexOf('--profile')+1]:select();if(!selection)return;
 if(selection!=='all'&&!Object.hasOwn(titles,selection))throw Error('unsupported_profile');
 const secret=process.env[cfg.secret_env||'PICKUP_SHARED_SECRET'];if(!secret||secret.length<32)throw Error('local_receiver_credentials_unavailable');
 const request=(path,body)=>new Promise((ok,bad)=>{const data=body?JSON.stringify(body):undefined;const req=http.request({hostname:'127.0.0.1',port:cfg.port||8765,path,method:data?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'}},res=>{let raw='';res.on('data',b=>{raw+=b;if(raw.length>128000)req.destroy();});res.on('end',()=>{try{ok({code:res.statusCode,...JSON.parse(raw)});}catch{bad(Error('invalid_receiver_reply'));}});});req.setTimeout(5000,()=>req.destroy());req.on('error',()=>bad(Error('local_receiver_unavailable')));req.end(data);});
 const dir=resolve(root,cfg.state_dir||'runtime-router'),reportDir=join(dir,'reopen-reports');mkdirSync(reportDir,{recursive:true,mode:0o700});const report={at:new Date().toISOString(),before:memory(),results:[]};const reportFile=join(reportDir,Date.now()+'.json');const save=()=>writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600});save();
 for(const label of selection==='all'?Object.keys(titles):[selection]){
  const row={label,stages:[]};report.results.push(row);const stage=(name,detail)=>{row.stages.push({name,at:new Date().toISOString(),...(detail?.error_code?{error_code:detail.error_code}:{})});save();};
  const slot=cfg.slots.find(s=>s.label===label),profile=slot?.safari_profile;let lease,owned=false;
  console.log('【'+titles[label]+'】检查是否空闲…');
  try{
   if(!profile)throw Error('unsupported_profile');
   const health=await request('/health'),status=health.profiles?.find(p=>p.profile_label===label);if(!status)throw Error('profile_not_found');
   const matches=(await listSafariWindows()).filter(w=>w.name.startsWith(profile+' — '));if(matches.length!==1||matches[0].tabs!==1)throw Error('exactly_one_profile_tab_required');
   const old=new SafariWindow(matches[0].id,profile),product=validateSetupProfile(old,slot.product_url);
   const inspect=async()=>{const page=await runGuestDOM(old,'state');return {page,standby:page.path==='/shop/signIn'?{}:await old.call('standbyState',{product})};};
   const initial=await inspect();assertRecyclable(status,initial.page,initial.standby);
   const leaseDir=join(dir,'setup-leases');mkdirSync(leaseDir,{recursive:true,mode:0o700});lease=join(leaseDir,label+'.json');const fd=openSync(lease,'wx',0o600);closeSync(fd);owned=true;writeFileSync(lease,JSON.stringify({pid:process.pid,at:new Date().toISOString(),reason:'user_window_recycle'}),{mode:0o600});
   const latest=(await request('/health')).profiles.find(p=>p.profile_label===label);if(latest.active_event_id||latest.request_reserved||latest.recovery_pending)throw Error('profile_busy');
   // Safari Apple Events bind by exact ID/profile even for background windows.
   // Do not require native Window-menu enumeration to close this verified tab.
   const checked=await inspect();assertRecyclable({...latest,maintenance_in_progress:false},checked.page,checked.standby);
   row.old_window_id=old.id;await appleScript(old.script('close w'));stage('old_window_closed');console.log('  旧窗口已关闭，正在原 Profile 重开…');
   await appleScript(openProfileScript(profile));
   const fresh=await withPreparationTimeout(()=>waitFor(async()=>{const a=(await listSafariWindows()).filter(w=>w.name.startsWith(profile+' — '));if(a.length>1)throw Error('profile_window_ambiguous');return a.length===1&&a[0].id!==old.id&&a[0].tabs===1?a[0]:false;}));
   const w=new SafariWindow(fresh.id,profile);row.new_window_id=w.id;stage('new_window_verified');
   console.log('  正在准备 Guest 地址、付款及自提／07094…');
   try{await prepareGuestPaymentSession(w,slot.product_url,{...cfg,...slot},{allowReplenish:false,stage});}
   catch(error){
    if(!['guest_target_window_not_visible','unknown_guest_sheet_requires_manual_review','guest_account_prompt_did_not_close'].includes(safeErrorCode(error)))throw error;
    stage('native_preparation_retry_once');console.log('  登录提示确认未完成，重新准备一次（不再关闭窗口）…');
    await prepareGuestPaymentSession(w,slot.product_url,{...cfg,...slot},{allowReplenish:false,stage});
   }
   const page=await runGuestDOM(w,'state'),standby=await w.call('standbyState',{product}),location=await w.call('locationState');assertRecyclable({},page,standby);if(page.path!=='/shop/checkout'||!['Fulfillment','Fulfillment-init'].includes(page.step)||location.displayed_zip!==cfg.pickup_zip)throw Error('restored_pickup_zip_not_verified');
   stage('fresh_pickup_verified');unlinkSync(lease);owned=false;
   const h=(await request('/health')).profiles.find(p=>p.profile_label===label);
   // Bind the live receiver to the new ID, but never interrupt a new stock task.
   if(!h.active_event_id&&!h.request_reserved){const reply=await request('/retry',{profile_label:label,expected_event_id:null,restore_only:true,confirm:true});if(reply.code!==202)throw Error(reply.reason||'receiver_rebind_failed');for(let i=0;i<40;i++){const item=await request('/status/'+reply.event_id);if(item.status==='manual_retry_ready'){row.receiver_verified=true;break;}if(['manual_review','automation_paused'].includes(item.status))throw Error(item.reason||'receiver_rebind_failed');await new Promise(r=>setTimeout(r,250));}if(!row.receiver_verified)throw Error('receiver_rebind_timeout');}else row.new_inventory_task_started=true;
   row.status='ready';stage('completed');console.log('  已重建并恢复就绪，不下单。');
  }catch(error){row.status='failed';row.reason=safeErrorCode(error,'reopen_failed');stage('failed');console.log('  未完成：'+row.reason+'。停止后续窗口，保留现场。');break;}
  finally{if(owned)try{unlinkSync(lease);}catch{}save();}
 }
 report.after=memory();report.finished_at=new Date().toISOString();save();console.log('完成 '+report.results.filter(r=>r.status==='ready').length+'/'+report.results.length+'。记录：'+reportFile);if(report.results.some(r=>r.status!=='ready'))process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(safeErrorCode(e,'reopen_failed'));process.exitCode=1;});
