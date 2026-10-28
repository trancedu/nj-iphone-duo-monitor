// Optional, asynchronous, window-only evidence. Never asks for screen permissions.
import {spawn} from 'node:child_process';
import {mkdirSync,chmodSync,unlinkSync,existsSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {appendDiagnostic} from './diagnostics.mjs';
import {runGuestDOM} from './guest_checkout.mjs';
function run(command,args,timeout){return new Promise(resolve=>{let output='',done=false;const p=spawn(command,args,{stdio:['ignore','pipe','ignore']});const timer=setTimeout(()=>p.kill('SIGKILL'),timeout);p.stdout.on('data',b=>{if(output.length<500)output+=b;});const finish=ok=>{if(done)return;done=true;clearTimeout(timer);resolve({ok,output:output.trim()});};p.once('error',()=>finish(false));p.once('close',code=>finish(code===0));});}
export async function captureFailureEvidence(browser,item){
 if(!browser.config.failure_screenshots||browser.evidenceBusy||browser.activeTaskId!==item.event_id)return;
 browser.evidenceBusy=true;
 const at=new Date().toISOString(),start=Date.now();let status='skipped';
 try{
  const s=await runGuestDOM(browser.window,'state');
  // Contact, Billing and Review may contain payment/identity data. Never capture them.
  if(s.path!=='/shop/sorry/session_expired'&&!(s.path==='/shop/checkout'&&['Fulfillment','Fulfillment-init'].includes(s.step)))return;
  if(browser.activeTaskId!==item.event_id||Date.now()-start>500)return;
  const helper=resolve(homedir(),'.config/iphone-duo/window-id');
  const id=await run(helper,[browser.config.safari_profile],500);
  if(!id.ok||!/^\d+$/.test(id.output)){status='screen_permission_or_window_unavailable';return;}
  if(browser.activeTaskId!==item.event_id)return;
  const dir=join(browser.config.state_dir,'failure-screenshots');mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,item.event_id+'.png');
  const result=await run('/usr/sbin/screencapture',['-x','-o','-l',id.output,file],1000);
  if(!result.ok||!existsSync(file)){status='capture_unavailable';return;}
  // If a new request started, discard potentially stale evidence.
  const after=await runGuestDOM(browser.window,'state');
  if(browser.activeTaskId!==item.event_id||after.document_time_origin!==s.document_time_origin||!['Fulfillment','Fulfillment-init'].includes(after.step)&&after.path!=='/shop/sorry/session_expired'){unlinkSync(file);status='discarded_page_changed';return;}
  chmodSync(file,0o600);status='captured';
  const older=readdirSync(dir).filter(n=>n.endsWith('.png')).map(n=>join(dir,n)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);for(const old of older.slice(5))unlinkSync(old);
 }catch{status='capture_unavailable';}
 finally{browser.evidenceBusy=false;appendDiagnostic(join(browser.config.state_dir,'evidence.jsonl'),{at,event_id:item.event_id,profile:browser.config.safari_profile,status,elapsed_ms:Date.now()-start});}
}
