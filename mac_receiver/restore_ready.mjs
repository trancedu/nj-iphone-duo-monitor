// Desktop controller: only calls the local authenticated restore-only endpoint.
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const titles={A:'256 白',B:'256 黑',C:'512 白',D:'512 黑',E:'1024 白（1TB）',F:'1024 黑（1TB）'};
export function chooseLabels(selection){if(selection==='全部六个窗口'||selection==='all')return Object.keys(titles);if(Object.hasOwn(titles,selection))return [selection];const match=Object.entries(titles).find(([,title])=>title===selection);if(!match)throw Error('invalid_restore_selection');return [match[0]];}
function choose(){const choices=['全部六个窗口',...Object.values(titles)],list=choices.map(JSON.stringify).join(',');const script=`set selected to choose from list {${list}} with title "恢复自提就绪" with prompt "选择恢复全部或一个配置（不会下单）" default items {"全部六个窗口"}\nif selected is false then return ""\nreturn item 1 of selected`;const r=spawnSync('/usr/bin/osascript',['-e',script],{encoding:'utf8'});if(r.status!==0)throw Error('selection_failed');return r.stdout.trim();}
export async function main(){
 const args=process.argv.slice(2),root=resolve(homedir(),'Library/Application Support/iPhoneDuo/receiver-safari');
 const config=JSON.parse(readFileSync(join(root,'receiver.router.local.json'),'utf8'));
 const selected=args.includes('--all')?'all':args.includes('--profile')?args[args.indexOf('--profile')+1]:choose();
 if(!selected){console.log('已取消，没有改动页面。');return;}
 const labels=chooseLabels(selected),secret=process.env[config.secret_env||'PICKUP_SHARED_SECRET'];if(!secret||secret.length<32)throw Error('local_receiver_credentials_unavailable');
 const request=(path,body)=>new Promise((resolve,reject)=>{
  const data=body?JSON.stringify(body):undefined;
  const req=http.request({hostname:'127.0.0.1',port:config.port||8765,path,method:data?'POST':'GET',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'}},res=>{let raw='';res.on('data',b=>{raw+=b;if(raw.length>128000)req.destroy();});res.on('end',()=>{try{resolve({code:res.statusCode,...JSON.parse(raw)});}catch{reject(Error('invalid_receiver_reply'));}});});
  req.setTimeout(5000,()=>req.destroy(Error('receiver_timeout')));req.on('error',()=>reject(Error('local_receiver_unavailable')));req.end(data);
 });
 const results=[];console.log('就绪标准：Guest 自提已选中，邮编07094。已正确的页面保持原样。\n');
 for(const label of labels){
  console.log('【'+titles[label]+'】正在检查…');
  try{
   const health=await request('/health'),profile=health.profiles?.find(p=>p.profile_label===label);if(!profile)throw Error('profile_not_found');
   const response=await request('/retry',{profile_label:label,expected_event_id:profile.active_event_id||null,restore_only:true,confirm:true});
   if(response.code!==202){const reason=response.reason||response.status;console.log('  已跳过：'+({'order_result_unresolved':'订单结果尚未确认，保留付款现场。','task_still_running':'正在处理库存请求，稍后再恢复。','external_setup_in_progress':'另一个恢复任务正在准备此窗口。'}[reason]||reason));results.push({label,status:'skipped',reason});continue;}
   const started=Date.now();let item,lastStage='';
   while(Date.now()-started<240000){
    item=await request('/status/'+response.event_id);
    const stage=Object.keys(item.timestamps||{}).at(-1);
    if(stage!==lastStage){lastStage=stage;const message={manual_retry_requested:'后台正在检查，请保留窗口。',manual_restore_session_rebuild_started_at:'会话需要重新准备，可能需要约一分钟。',setup_checkout_clicked_at:'正在进入 Guest Checkout…',apple_account_cancel_clicked:'已取消 Apple Account 登录提示。',setup_shipping_verified_at:'地址准备完成，正在准备付款资料…',setup_payment_review_verified_at:'付款预填完成，正在切回自提…'}[stage];if(message)console.log('  '+message);}
    if(item.status==='manual_retry_ready')break;
    if(['manual_review','manual_retry_cancelled','automation_paused'].includes(item.status))throw Error(item.reason||'restore_failed');
    await new Promise(r=>setTimeout(r,1000));
   }
   if(item?.status!=='manual_retry_ready'){console.log('  后台仍在恢复；本次停止等待，不会重复启动。');results.push({label,status:'still_running',event_id:response.event_id});continue;}
   const mode=item.restore_result?.mode;
   console.log('  '+(mode==='already_ready'?'已就绪，页面未改动，旧锁已清理。':mode==='session_rebuilt'?'完整会话准备完成，已回到自提／07094。':'已恢复到自提／07094。'));
   results.push({label,status:'ready',mode,event_id:response.event_id});
  }catch(error){const reason=/^[a-z_]+$/.test(error.message)?error.message:'restore_failed';console.log('  恢复未完成：'+reason+'。');results.push({label,status:'failed',reason});}
 }
 const dir=resolve(root,config.state_dir||'runtime-router','restore-reports');mkdirSync(dir,{recursive:true,mode:0o700});
 const file=join(dir,Date.now()+'.json');writeFileSync(file,JSON.stringify({at:new Date().toISOString(),results},null,2),{mode:0o600});
 console.log('\n完成：'+results.filter(r=>r.status==='ready').length+'/'+labels.length+' 个窗口就绪。\n不会执行购买或最终下单。\n记录：'+file);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error('恢复脚本未完成：'+(/^[a-z_]+$/.test(error.message)?error.message:'unexpected_error'));process.exitCode=1;});
