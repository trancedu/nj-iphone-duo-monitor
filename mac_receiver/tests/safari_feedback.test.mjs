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
test('foreground and sound failures do not suppress notification; bell is fallback',async()=>{
 let notified=0,bells=0;const r=await signalSafari({foreground:async()=>{throw Error();}},{status:'manual_review'},{},{playSound:()=>{throw Error();},notify:async()=>{notified++;},bell:()=>{bells++;}});
 assert.deepEqual(r,{foreground:false,sound_played:false,notification_submitted:true});assert.equal(notified,1);assert.equal(bells,1);
});
test('notification failure does not change successful checkout outcome or suppress sound',async()=>{
 const result={status:'awaiting_user'};let sounds=0;
 const r=await signalSafari(null,result,{},{playSound:async()=>{sounds++;},notify:async()=>{throw Error();}});
 assert.equal(result.status,'awaiting_user');assert.equal(sounds,1);assert.equal(r.notification_submitted,false);assert.equal(r.sound_played,true);
});
test('post-stock error notification says current page is preserved for manual continuation',()=>{
 const p=feedbackPlan({status:'manual_review',reason:'pickup_unavailable_after_selection_preserved'});assert.ok(p.message.includes('已保留页面'));assert.ok(p.message.includes('手动继续'));assert.ok(!p.message.includes('unknown'));
});

test('ready alert is fast speech only; unavailable uses two tones',()=>{
 const ready=feedbackPlan({status:'awaiting_user'},{product:'iPhone Duo 512GB Night Sky'}),sold=feedbackPlan({status:'pickup_unavailable'});
 assert.equal(ready.repetitions,0);assert.equal(ready.speech,'五一二黑');assert.equal(sold.repetitions,2);assert.equal(sold.speech,null);
});
test('ready playback speaks only four characters at the faster rate, without tone prefix',async()=>{
 const calls=[];const r=await playAttentionSound(feedbackPlan({status:'awaiting_user'},{product:'iPhone Duo 256GB Star White'}),{execute:async(file,args)=>{calls.push({file,args});},pause:async()=>{}});
 assert.equal(calls.length,1);assert.equal(calls[0].file,'/usr/bin/say');assert.deepEqual(calls[0].args,['-v','Tingting','-r','320','二五六白']);assert.equal(r.sound_repeats_played,0);assert.equal(r.speech_spoken,true);
});
test('speech failure is reported and ordinary tone playback still succeeds',async()=>{
 const ready=await playAttentionSound(feedbackPlan({status:'awaiting_user'},{product:'iPhone Duo 256GB Star White'}),{execute:async()=>{throw Error();},pause:async()=>{}});
 assert.equal(ready.sound_played,false);assert.equal(ready.speech_spoken,false);
 const normal=await playAttentionSound(feedbackPlan({status:'pickup_unavailable'}),{execute:async()=>{},pause:async()=>{}});assert.equal(normal.sound_played,true);
});
test('preview identifies itself and does not claim live inventory',()=>{
 const p=feedbackPlan({status:'awaiting_user'},{preview:true});assert.ok(p.title.includes('试听'));assert.ok(p.message.includes('试听'));assert.ok(!p.message.includes('已准备好'));assert.equal(p.repetitions,0);
});
