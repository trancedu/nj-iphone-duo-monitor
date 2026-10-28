import test from 'node:test';
import assert from 'node:assert/strict';
import {feedbackPlan,signalSafari,playAttentionSound} from '../safari/feedback.mjs';
for(const [status,sound] of [['awaiting_user','Sosumi'],['pickup_unavailable','Ping'],['manual_review','Sosumi'],['stopped','Sosumi'],['seeded','Ping']])test('Safari feedback identifies '+status,()=>{
 const p=feedbackPlan({status,reason:'test'},{profile:'Duo256White',product:'iPhone Duo 256GB Star White'});
 assert.ok(p.sound.endsWith('/'+sound+'.aiff'));assert.ok(p.title.includes('Duo256White'));assert.ok(p.message.includes('256GB Star White'));
});
test('Safari completion attempts foreground, sound and notification',async()=>{
 const calls=[];const r=await signalSafari({foreground:async()=>{calls.push('foreground');}},{status:'awaiting_user'},{profile:'Test'},{playSound:async()=>{calls.push('sound');},notify:async()=>{calls.push('notification');}});
 assert.deepEqual(r,{foreground:true,sound_played:true,notification_submitted:true});assert.deepEqual(calls,['foreground','sound','notification']);
});
test('foreground and speech failures preserve notification without an ambiguous beep',async()=>{
 let notified=0,bells=0;const r=await signalSafari({foreground:async()=>{throw Error();}},{status:'manual_review'},{},{playSound:()=>{throw Error();},notify:async()=>{notified++;},bell:()=>{bells++;}});
 assert.deepEqual(r,{foreground:false,sound_played:false,notification_submitted:true});assert.equal(notified,1);assert.equal(bells,0);
});
test('notification failure does not change successful checkout outcome or suppress sound',async()=>{
 const result={status:'awaiting_user'};let sounds=0;
 const r=await signalSafari(null,result,{},{playSound:async()=>{sounds++;},notify:async()=>{throw Error();}});
 assert.equal(result.status,'awaiting_user');assert.equal(sounds,1);assert.equal(r.notification_submitted,false);assert.equal(r.sound_played,true);
});
test('post-stock error notification says current page is preserved for manual continuation',()=>{
 const p=feedbackPlan({status:'manual_review',reason:'pickup_unavailable_after_selection_preserved'});assert.ok(p.message.includes('已保留页面'));assert.ok(p.message.includes('手动继续'));assert.ok(!p.message.includes('unknown'));
});

test('completion speaks its outcome without tones',()=>{
 const ready=feedbackPlan({status:'awaiting_user'},{product:'iPhone Duo 512GB Night Sky'}),sold=feedbackPlan({status:'pickup_unavailable'});
 assert.equal(ready.repetitions,0);assert.equal(ready.speech,'五一二黑，已准备好，请手动确认付款');assert.equal(sold.repetitions,0);assert.equal(sold.speech,'没有库存');
});
test('ready playback speaks a clear Chinese handoff without tone prefix',async()=>{
 const calls=[];const r=await playAttentionSound(feedbackPlan({status:'awaiting_user'},{product:'iPhone Duo 256GB Star White'}),{execute:async(file,args)=>{calls.push({file,args});},pause:async()=>{}});
 assert.equal(calls.length,1);assert.equal(calls[0].file,'/usr/bin/say');assert.deepEqual(calls[0].args,['-v','Tingting','-r','240','二五六白，已准备好，请手动确认付款']);assert.equal(r.sound_repeats_played,0);assert.equal(r.speech_spoken,true);
});
test('speech failure is reported and successful completion uses voice only',async()=>{
 const ready=await playAttentionSound(feedbackPlan({status:'awaiting_user'},{product:'iPhone Duo 256GB Star White'}),{execute:async()=>{throw Error();},pause:async()=>{}});
 assert.equal(ready.sound_played,false);assert.equal(ready.speech_spoken,false);
 const normal=await playAttentionSound(feedbackPlan({status:'pickup_unavailable'}),{execute:async()=>{},pause:async()=>{}});assert.equal(normal.sound_played,false);assert.equal(normal.speech_spoken,true);
});
test('preview identifies itself and does not claim live inventory',()=>{
 const p=feedbackPlan({status:'awaiting_user'},{preview:true});assert.ok(p.title.includes('试听'));assert.ok(p.message.includes('试听'));assert.ok(!p.message.includes('已准备好'));assert.equal(p.repetitions,0);
});
test('receiver speech can be disabled without queueing a voice or fallback bell',async()=>{
 for(const status of ['inventory_signal']){
  const context={speech_enabled:false,product:'iPhone Duo 512GB Night Sky'};
  const plan=feedbackPlan({status},context);assert.equal(plan.speech,null);
  let notified=0;const calls=[];
  await playAttentionSound(plan,{execute:async file=>calls.push(file)});assert.equal(calls.length,0);
  const r=await signalSafari(null,{status},context,{audioQueue:{submit:()=>{throw Error('must not queue audio');}},bell:()=>{throw Error('must not beep');},notify:async()=>notified++});
  assert.equal(r.audio_skipped,'speech_disabled');assert.equal(notified,1);
 }
});

test('completion Chinese speech works when server owns arrival speech, without fallback tones',async()=>{
 for(const [status,phrase] of [['pickup_unavailable','没有库存'],['manual_review','请手动介入'],['awaiting_user','已准备好，请手动确认付款']]){
  const context={speech_enabled:false};const p=feedbackPlan({status},context);assert.equal(p.speech,phrase);assert.equal(p.repetitions,0);
  const calls=[];await playAttentionSound(p,{execute:async(file,args)=>calls.push({file,args})});assert.equal(calls.length,1);assert.equal(calls[0].file,'/usr/bin/say');
  let bells=0,notices=0;await signalSafari(null,{status},context,{playSound:async()=>{throw Error();},notify:async()=>notices++,bell:()=>bells++});assert.equal(bells,0);assert.equal(notices,1);
  await signalSafari(null,{status},context,{audioQueue:{submit:()=>({audio_queued:false})},notify:async()=>{},bell:()=>bells++});assert.equal(bells,0);
 }
});

test('one terabyte completion speech identifies the capacity and color',()=>{
 for(const [color,spoken] of [['Star White','一T白'],['Night Sky','一T黑']]){
  assert.equal(feedbackPlan({status:'pickup_unavailable'},{product:`iPhone Duo 1TB ${color}`,speech_enabled:false}).speech,spoken+'，没有库存');
 }
});
