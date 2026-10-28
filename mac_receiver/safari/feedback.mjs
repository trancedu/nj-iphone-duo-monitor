import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {AudioQueue} from './audio_queue.mjs';
import {appendDiagnostic} from './diagnostics.mjs';
const run=promisify(execFile);
const quote=s=>'"'+String(s).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\r','\\r')+'"';
export function feedbackPlan(result,{profile='Safari',product='',mode='test',preview=false,speech_enabled=true}={}) {
  const details={inventory_signal:['Sosumi','收到库存信号，正在核验门店并准备自提。'],idle_timeout_returned:['Pop','等待接管超时，已返回购物袋待命。'],awaiting_user:['Sosumi','已准备好，请接管 Apple Pay。最终付款按钮未点击。'],pickup_unavailable:['Ping','自提重查结束，仍无货。未进入付款。'],seeded:['Ping','预备购物袋已就绪，尚未结账。']};
  const errors={target_store_not_listed:'目标门店未出现在列表中，库存尚未确认，请检查页面。',pickup_unavailable_after_selection_preserved:'已发现可自提库存，后续步骤异常；已保留页面，请手动继续。'};
  const [sound,message]=details[result.status]||['Sosumi',result.status==='stopped'?'请求未运行：'+(result.reason||'unknown'):errors[result.reason]||'脚本异常停止，请检查页面：'+(result.reason||'unknown')];
  const urgent=['inventory_signal','awaiting_user'].includes(result.status)||preview;
  const repetitions=urgent?0:['manual_review','stopped','pickup_unavailable'].includes(result.status)?2:1;
  const variant=product.includes('Star White')?'白':product.includes('Night Sky')?'黑':'';
  const capacity=product.includes('512GB')?'五一二':product.includes('256GB')?'二五六':'';
  const spokenConfig=[capacity,variant].filter(Boolean).join('');
  const speech=speech_enabled&&urgent&&spokenConfig?spokenConfig:null;
  return {status:result.status,sound:'/System/Library/Sounds/'+(preview?'Sosumi':sound)+'.aiff',repetitions,speech,title:preview?'Safari 提醒试听':(mode==='production'?'Safari 自提 — ':'Safari 测试 — ')+profile,message:preview?'快速纯语音试听。':[product,message].filter(Boolean).join('：')};
}
export async function playAttentionSound(plan,{execute=run,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  let played=0;
  for(let i=0;i<plan.repetitions;i++){
    try{await execute('/usr/bin/afplay',['-v','1',plan.sound],{timeout:5000});played++;}catch{}
    if(i+1<plan.repetitions)await pause(180);
  }
  const result={sound_played:played>0,sound_repeats_played:played};
  if(plan.speech){try{await execute('/usr/bin/say',['-v','Tingting','-r','320',plan.speech],{timeout:15000});result.speech_spoken=true;}catch{result.speech_spoken=false;}}
  return result;
}
function recordAudio(job,result,stage){
  if(!job.context.state_dir)return;
  appendDiagnostic(join(job.context.state_dir,'feedback.jsonl'),{at:new Date().toISOString(),stage,audio_job_id:job.id,event_id:job.context.event_id||null,profile:job.context.profile||null,status:job.plan.status,queued_at:job.queued_at,started_at:job.started_at,finished_at:job.finished_at,...result});
}
const backgroundAudio=new AudioQueue({play:async plan=>{const result=await playAttentionSound(plan);if(!result.sound_played&&!result.speech_spoken)process.stderr.write('\x07');return result;},onSubmit:job=>recordAudio(job,{},'audio_queued'),onComplete:(job,result)=>recordAudio(job,result,'audio_completed')});
export const audioQueueState=()=>backgroundAudio.state;
const notify=plan=>new Promise((ok,bad)=>{
  const child=spawn('/usr/bin/osascript',['-'],{stdio:['pipe','ignore','ignore']});
  const timer=setTimeout(()=>child.kill(),5000);
  child.on('error',bad);child.on('close',code=>{clearTimeout(timer);code===0?ok():bad(new Error('notification_failed'));});
  child.stdin.end('display notification '+quote(plan.message)+' with title '+quote(plan.title));
});
// Attempt all channels independently. A failed notification must never change
// checkout state, click again, release an uncertain lock, or suppress the sound.
export async function signalSafari(window,result,context={},deps={}) {
  const plan=feedbackPlan(result,context),out={};
  if(window){try{await window.foreground();out.foreground=true;}catch{out.foreground=false;}}
  if(context.speech_enabled===false&&plan.repetitions===0){
    out.audio_skipped='speech_disabled';
    try{await (deps.notify||notify)(plan);out.notification_submitted=true;}catch{out.notification_submitted=false;}
    return out;
  }
  const bell=deps.bell||(()=>process.stderr.write('\x07'));
  // Production never waits for audio. Notification and foreground are separate;
  // the queued tone/speech job cannot hold up a checkout or standby restoration.
  if(!deps.playSound&&!context.wait_for_audio){
    if(context.mute_audio){out.audio_skipped='already_announced';try{await (deps.notify||notify)(plan);out.notification_submitted=true;}catch{out.notification_submitted=false;}return out;}
    let queued;try{queued=(deps.audioQueue||backgroundAudio).submit(plan,context);}catch{queued={audio_queued:false,audio_reason:'audio_submit_failed'};}
    Object.assign(out,queued);if(!queued.audio_queued)bell();
    try{await (deps.notify||notify)(plan);out.notification_submitted=true;}catch{out.notification_submitted=false;}
    return out;
  }
  const jobs=await Promise.allSettled([
    Promise.resolve().then(()=>deps.playSound?deps.playSound(plan.sound,plan):playAttentionSound(plan)),
    Promise.resolve().then(()=>(deps.notify||notify)(plan))
  ]);
  out.sound_played=jobs[0].status==='fulfilled'&&(jobs[0].value?.sound_played??true);out.notification_submitted=jobs[1].status==='fulfilled';
  if(jobs[0].status==='fulfilled'&&jobs[0].value&&typeof jobs[0].value==='object')Object.assign(out,jobs[0].value);
  if(!out.sound_played&&!out.speech_spoken)bell();
  return out;
}
