import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {ProfileRouter} from '../profile_router.mjs';
import {Engine} from '../engine.mjs';
import {Stop} from '../protocol.mjs';
import {waitForPickupProgress} from '../safari/shopping.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'per-profile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const calls=[],pending=new Map(),config={browser_backend:'safari',per_profile_requests:true,single_active_request:false,stall_handoff_seconds:10,recent_request_ttl_seconds:10,drop_busy_events:false,global_lock_timeout_seconds:60,state_dir:root};
 const slots=['star-white','night-sky'].map((color,i)=>{
  const browser={ready:()=>true,prepare:async event=>{calls.push(event.event_id);await new Promise((ok,bad)=>pending.set(event.event_id,{ok,bad}));return 'awaiting_user';},handoff:async()=>{},seedIdle:async()=>{}};
  return {label:'AB'[i],product_url:`https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-${color}-unlocked`,browser,engine:new Engine({state_dir:join(root,'AB'[i]),dry_run:false,queue_while_busy:false},browser)};
 });
 const router=new ProfileRouter(config,slots),event=(id,i=0)=>({event_id:id,product_url:slots[i].product_url,detected_at:new Date().toISOString()});
 return {router,slots,calls,pending,event};
}
test('different configurations run concurrently; same configuration and duplicates never overlap',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));f.router.accept(f.event('black',1));await turn();
 assert.deepEqual(f.calls,['white','black']);
 const next=f.event('next-white');assert.equal(f.router.accept(next).body.status,'held');assert.equal(f.router.accept(next).code,200);await turn();
 assert.deepEqual(f.calls,['white','black']);
 assert.equal(f.slots[0].browser.hasRecentCandidate('white'),true);
 assert.equal(f.slots[1].browser.hasRecentCandidate('black'),false);
});
test('stalled configuration releases only itself and dispatches its newest candidate',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));f.router.accept(f.event('black',1));await turn();
 f.router.accept(f.event('older'));f.slots[0].engine.state.events.older.timestamps.received_at=new Date(Date.now()-50).toISOString();f.router.accept(f.event('latest'));
 f.pending.get('white').bad(new Stop('pickup_stalled_yield'));await delay(140);await turn();
 assert.deepEqual(f.calls,['white','black','latest']);
 assert.equal(f.slots[0].engine.state.events.white.status,'superseded');assert.equal(f.slots[1].engine.state.active,'black');
});
test('expired candidates do not trigger handoff',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));await turn();
 f.router.accept({...f.event('old'),detected_at:new Date(Date.now()-11000).toISOString()});
 assert.equal(f.slots[0].browser.hasRecentCandidate('white'),false);
});
test('ten-second threshold yields only on a stalled poll and ends the old workflow',async()=>{
 let laterClicks=0,abandoned=0;
 await assert.rejects(async()=>{await waitForPickupProgress(async()=>false,{startedAt:0,now:()=>10000,shouldYield:()=>true,abandon:async()=>{abandoned++;return {abandoned:true};},timeout:100});laterClicks++;},e=>e.code==='pickup_stalled_yield');
 assert.equal(abandoned,1);assert.equal(laterClicks,0);
 const ready=await waitForPickupProgress(async()=>true,{startedAt:0,now:()=>11000,shouldYield:()=>true,abandon:async()=>{throw Error('ready page must continue');}});assert.equal(ready,true);
});
test('below threshold or protected page is never abandoned',async()=>{
 let abandoned=0;
 await assert.rejects(()=>waitForPickupProgress(async()=>false,{startedAt:0,now:()=>9999,shouldYield:()=>true,abandon:async()=>{abandoned++;return {abandoned:true};},timeout:1}),e=>e.code==='safari_step_timeout');assert.equal(abandoned,0);
 await assert.rejects(()=>waitForPickupProgress(async()=>false,{startedAt:0,now:()=>10000,shouldYield:()=>true,abandon:async()=>({abandoned:false}),timeout:1}),e=>e.code==='safari_step_timeout');
});
test('one payment panel owner does not block another configuration from preparing',async t=>{
 const f=fixture(t);assert.equal(f.slots[0].browser.tryClaimApplePay('white'),true);assert.equal(f.slots[1].browser.tryClaimApplePay('black'),false);
 assert.equal(f.slots[1].browser.mayForeground('black'),false);
 f.router.accept(f.event('black',1));await turn();assert.deepEqual(f.calls,['black']);
});
test('per-profile deadline cancels only its old runner and waits for it to unwind',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));f.router.accept(f.event('black',1));await turn();
 f.slots[0].engine.state.events.white.timestamps.received_at=new Date(Date.now()-61000).toISOString();
 f.router.watchGlobalTimeout();assert.equal(f.slots[0].browser.abortEventId,'white');assert.equal(f.slots[1].browser.abortEventId,undefined);assert.equal(f.slots[0].engine.state.active,'white');
 f.pending.get('white').bad(new Stop('pickup_task_deadline'));await turn();await turn();
 assert.equal(f.slots[0].engine.state.active,null);assert.equal(f.slots[1].engine.state.active,'black');
});

test('a fresh incoming request wins before an older held candidate is dispatched',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));await turn();f.router.accept(f.event('older'));
 f.pending.get('white').bad(new Stop('pickup_stalled_yield'));await turn();await turn();
 f.router.accept(f.event('brand-new'));await delay(140);await turn();
 assert.deepEqual(f.calls,['white','brand-new']);assert.equal(f.slots[0].engine.state.events.older.status,'global_waiting');
});
test('simultaneous HTTP preflight reservations serialize only the same configuration',async t=>{
 const f=fixture(t);let finish;f.slots[0].browser.ensurePage=()=>new Promise(r=>finish=r);
 const first=f.event('one'),second=f.event('two'),other=f.event('black',1);
 const pre=f.router.beforeAccept(first);await f.router.beforeAccept(second);assert.equal(f.router.accept(second).body.status,'held');
 await f.router.beforeAccept(other);assert.equal(f.router.accept(other).body.status,'queued');
 finish();await pre;assert.equal(f.router.accept(first).body.status,'queued');await turn();assert.deepEqual(new Set(f.calls),new Set(['one','black']));
});

test('a stalled configuration can release without a candidate and wait for fresh stock',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));await turn();
 assert.equal(f.slots[0].browser.hasRecentCandidate('white'),false);assert.equal(f.slots[0].browser.shouldAbandonStall('white'),true);
 f.pending.get('white').bad(new Stop('pickup_stalled_yield'));await delay(140);
 assert.equal(f.slots[0].engine.state.active,null);assert.deepEqual(f.calls,['white']);
 f.router.accept(f.event('new-white'));await turn();assert.deepEqual(f.calls,['white','new-white']);
});

test('per-configuration deadlines do not require or launch the process-wide unlock helper',async()=>{
 const {validateTimeoutPolicy}=await import('../profile_router.mjs');
 assert.doesNotThrow(()=>validateTimeoutPolicy({per_profile_requests:true,single_active_request:false,global_lock_timeout_seconds:60}));
 assert.throws(()=>validateTimeoutPolicy({single_active_request:false,global_lock_timeout_seconds:60}),e=>e.code==='global_timeout_helper_required');
});
