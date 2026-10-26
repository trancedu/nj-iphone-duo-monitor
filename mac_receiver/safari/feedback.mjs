import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const quote=s=>'"'+String(s).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\r','\\r')+'"';
export function feedbackPlan(result,{profile='Safari',product='',mode='test'}={}) {
  const details={awaiting_user:['Glass','已准备好，请接管 Apple Pay。最终付款按钮未点击。'],pickup_unavailable:['Pop','自提重查结束，仍无货。未进入付款。'],seeded:['Ping','预备购物袋已就绪，尚未结账。']};
  const [sound,message]=details[result.status]||['Basso',result.status==='stopped'?'请求未运行：'+(result.reason||'unknown'):'脚本异常停止，请检查页面：'+(result.reason||'unknown')];
  return {sound:'/System/Library/Sounds/'+sound+'.aiff',title:(mode==='production'?'Safari 自提 — ':'Safari 测试 — ')+profile,message:[product,message].filter(Boolean).join('：')};
}
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
  const jobs=await Promise.allSettled([
    Promise.resolve().then(()=>(deps.playSound||((p)=>run('/usr/bin/afplay',[p],{timeout:5000})))(plan.sound)),
    Promise.resolve().then(()=>(deps.notify||notify)(plan))
  ]);
  out.sound_played=jobs[0].status==='fulfilled';out.notification_submitted=jobs[1].status==='fulfilled';
  if(!out.sound_played)(deps.bell||(()=>process.stderr.write('\x07')))();
  return out;
}
