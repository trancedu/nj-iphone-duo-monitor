import test from 'node:test';
import assert from 'node:assert/strict';
import {feedbackPlan,signalSafari} from '../safari/feedback.mjs';
for(const [status,sound] of [['awaiting_user','Glass'],['pickup_unavailable','Pop'],['manual_review','Basso'],['stopped','Basso'],['seeded','Ping']])test('Safari feedback identifies '+status,()=>{
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
