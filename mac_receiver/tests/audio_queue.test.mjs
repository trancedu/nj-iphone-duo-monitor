import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {AudioQueue} from '../safari/audio_queue.mjs';
import {feedbackPlan,signalSafari} from '../safari/feedback.mjs';
test('audio submission returns before playback finishes; two messages never overlap',async()=>{
 const started=[],finished=[];let first;
 const queue=new AudioQueue({play:async plan=>{started.push(plan.id);if(plan.id===1)await new Promise(r=>{first=r;});finished.push(plan.id);return {sound_played:true};}});
 const a=queue.submit({id:1}),b=queue.submit({id:2});assert.equal(a.audio_queued,true);assert.notEqual(a.audio_job_id,b.audio_job_id);assert.deepEqual(started,[]);await turn();assert.deepEqual(started,[1]);assert.deepEqual(finished,[]);
 first();await queue.idle();assert.deepEqual(started,[1,2]);assert.deepEqual(finished,[1,2]);
});
test('one failed audio job cannot stall later alerts',async()=>{
 const completed=[];const queue=new AudioQueue({play:async p=>{if(p.id===1)throw Error();return {sound_played:true};},onComplete:(j,r)=>completed.push(r)});queue.submit({id:1});queue.submit({id:2});await queue.idle();assert.equal(completed.length,2);assert.equal(completed[0].sound_played,false);assert.equal(completed[1].sound_played,true);
});
test('queue is bounded and a full queue refuses rather than blocking the caller',()=>{
 const q=new AudioQueue({play:async()=>{},maxPending:1});assert.equal(q.submit({}).audio_queued,true);assert.equal(q.submit({}).audio_queued,false);
});
test('production handoff returns while voice is still pending',async()=>{
 let finish;const queue=new AudioQueue({play:async()=>new Promise(r=>{finish=r;})});
 const r=await signalSafari(null,{status:'awaiting_user'},{product:'iPhone Duo 256GB Star White'},{audioQueue:queue,notify:async()=>{}});
 assert.equal(r.audio_queued,true);assert.equal(r.notification_submitted,true);assert.equal(r.sound_played,undefined);await turn();finish({sound_played:true});await queue.idle();
});
test('unavailable feedback and checkout outcome are independent of queue failure',async()=>{
 let bells=0;const result={status:'pickup_unavailable'};const r=await signalSafari(null,result,{},{audioQueue:{submit:()=>({audio_queued:false})},notify:async()=>{},bell:()=>{bells++;}});assert.equal(r.audio_queued,false);assert.equal(bells,1);assert.equal(result.status,'pickup_unavailable');
});
test('speech is only capacity and color for each production Duo configuration',()=>{
 for(const [capacity,color,expected] of [['256GB','Star White','二五六白'],['256GB','Night Sky','二五六黑'],['512GB','Star White','五一二白'],['512GB','Night Sky','五一二黑']])assert.equal(feedbackPlan({status:'awaiting_user'},{product:`iPhone Duo ${capacity} ${color}`}).speech,expected);
});
test('inventory signal speaks configuration before checkout is ready; final notice can skip audio',async()=>{
 const p=feedbackPlan({status:'inventory_signal'},{product:'iPhone Duo 512GB Star White'});assert.equal(p.speech,'五一二白');assert.equal(p.repetitions,0);assert.ok(p.message.includes('正在核验'));
 const r=await signalSafari(null,{status:'awaiting_user'},{mute_audio:true},{audioQueue:{submit:()=>{throw Error('must not submit duplicate');}},notify:async()=>{}});assert.equal(r.audio_skipped,'already_announced');assert.equal(r.notification_submitted,true);
});
