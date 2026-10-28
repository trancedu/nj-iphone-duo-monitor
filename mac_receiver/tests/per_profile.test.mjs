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
test('only a fresh same-configuration successor after a stall receives urgent retry mode',async t=>{
 const f=fixture(t);f.router.accept(f.event('old'));await turn();
 f.router.accept(f.event('next'));f.router.accept(f.event('other',1));await turn();
 f.slots[0].browser.stalledProfilePending=true;
 f.pending.get('old').bad(new Stop('pickup_stalled_yield'));await delay(140);await turn();
 assert.equal(f.slots[0].engine.state.events.next.same_configuration_stall_retry,true);
 assert.equal(f.slots[1].engine.state.events.other.same_configuration_stall_retry,undefined);
 assert.equal(f.slots[0].engine.state.active,'next');
});
test('fresh same-configuration candidate takes priority over standby maintenance',async t=>{
 const f=fixture(t);let maintained=0;
 f.slots[0].browser.refreshStandby=()=>{maintained++;return null;};
 f.router.accept(f.event('old'));await turn();f.router.accept(f.event('next'));
 f.slots[0].engine.state.active=null;f.slots[0].browser.stalledProfilePending=true;
 await f.router.maintainStandby();await turn();
 assert.equal(maintained,0);assert.equal(f.slots[0].engine.state.active,'next');
 assert.equal(f.slots[0].engine.state.events.next.same_configuration_stall_retry,true);
});
test('T+0 stalled loading hands to T+3 same SKU at T+10 while T+5 other SKU stays independent',async t=>{
 const f=fixture(t);const base=Date.now();let logical=0;
 const original=f.slots[0].browser.prepare;
 f.slots[0].browser.prepare=async event=>{
  if(event.event_id!=='loading-old')return original(event);
  try{await waitForPickupProgress(async()=>false,{startedAt:0,now:()=>logical,stallMs:10000,timeout:1000,shouldYield:()=>true,abandon:async()=>({abandoned:true})});}
  catch(e){f.slots[0].browser.stalledProfilePending=true;throw e;}
 };
 f.router.accept(f.event('loading-old'));await turn();
 logical=3000;f.router.accept(f.event('loading-new'));
 const next=f.slots[0].engine.state.events['loading-new'];next.detected_at=new Date(base+3000).toISOString();next.timestamps.received_at=next.detected_at;
 logical=5000;f.router.accept(f.event('other-SKU',1));await turn();
 logical=10000;f.router.expireWaiting(base+10000);assert.equal(next.status,'global_waiting');
 await delay(260);await turn();
 assert.equal(f.slots[0].engine.state.events['loading-old'].reason,'pickup_stalled_yield');
 assert.equal(f.slots[0].engine.state.active,'loading-new');assert.equal(next.same_configuration_stall_retry,true);
 assert.equal(f.slots[1].engine.state.active,'other-SKU');
});

test('payment cooldown blocks all claims for 10 seconds, then allows a new request without replay',async t=>{
 const f=fixture(t);
 assert.equal(f.slots[0].browser.tryClaimApplePay('first'),true);
 const claimed=Date.parse(f.router.paymentClaimedAt);
 assert.equal(f.slots[0].browser.tryClaimApplePay('first'),false);
 f.router.expirePaymentLease(claimed+9999);
 assert.equal(f.slots[1].browser.tryClaimApplePay('second'),false);
 f.router.expirePaymentLease(claimed+10000);
 assert.equal(f.router.paymentOwner,null);
 assert.deepEqual(f.calls,[]);
 assert.equal(f.slots[1].browser.tryClaimApplePay('new'),true);
 assert.equal(f.router.paymentOwner,'new');
});
test('payment cooldown survives router restart even when request is no longer active',t=>{
 const f=fixture(t);f.slots[0].browser.tryClaimApplePay('first');
 const restored=new ProfileRouter(f.router.config,f.slots);
 assert.equal(restored.paymentOwner,'first');
 assert.equal(f.slots[1].browser.tryClaimApplePay('second'),false);
 restored.expirePaymentLease(Date.parse(restored.paymentClaimedAt)+10000);
 const expired=new ProfileRouter(f.router.config,f.slots);
 assert.equal(expired.paymentOwner,null);
});
test('payment deadline restores once, then dispatches newest fresh same-SKU candidate',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));await turn();f.pending.get('white').ok();await turn();await turn();
 const e=f.slots[0].engine;let restore=0,finish;
 f.slots[0].browser.expirePaymentWindow=async()=>{restore++;await new Promise(r=>finish=r);};
 e.stage(e.state.events.white,'apple_pay_sheet_requested_at');t.after(()=>clearTimeout(e.paymentDeadlineTimer));
 f.router.accept(f.event('older'));e.state.events.older.timestamps.received_at=new Date(Date.now()-100).toISOString();f.router.accept(f.event('latest'));
 const task=e.watchPaymentDeadline(Date.parse(e.state.events.white.timestamps.apple_pay_sheet_requested_at)+10000);
 assert.equal(e.state.active,null);await delay(140);assert.deepEqual(f.calls,['white']);
 finish();await task;await delay(140);assert.deepEqual(f.calls,['white','latest']);assert.equal(restore,1);
 assert.equal(e.state.events.older.status,'global_waiting');
});
test('confirmed failed payment actively rechecks once when no fresh signal exists',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));await turn();f.pending.get('white').ok();await turn();await turn();
 const e=f.slots[0].engine;e.state.events.white.timestamps.apple_pay_sheet_requested_at=new Date().toISOString();
 f.slots[0].browser.inspectPaymentFailure=async()=>({outcome:'failed',recoverable:true,observed:true,closed:true,phase:'payment_failed'});
 f.slots[0].browser.recoverPaymentFailure=async()=>{};
 f.slots[0].browser.tryClaimApplePay('white');
 assert.equal(await e.watchPaymentFailure(),true);assert.equal(f.router.paymentOwner,null);
 await delay(140);assert.equal(f.calls.length,2);const retry=e.state.events[e.state.active];
 assert.equal(retry.payment_failure_retry_of,'white');assert.equal(retry.payment_failure_retry_count,1);
 // A repeated failure in this local recheck does not create an infinite loop.
 f.pending.get(retry.event_id).ok();await turn();await turn();retry.timestamps.apple_pay_sheet_requested_at=new Date().toISOString();
 e.nextPaymentPoll=0;assert.equal(await e.watchPaymentFailure(),true);await delay(140);assert.equal(f.calls.length,2);assert.equal(e.state.active,null);
});
test('confirmed failure prefers a fresh signal, and a new signal cancels a queued local recheck',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));await turn();f.pending.get('white').ok();await turn();await turn();
 const e=f.slots[0].engine;e.state.events.white.timestamps.apple_pay_sheet_requested_at=new Date().toISOString();
 f.slots[0].browser.inspectPaymentFailure=async()=>({outcome:'failed',recoverable:true});f.slots[0].browser.recoverPaymentFailure=async()=>{};
 f.router.accept(f.event('fresh'));await e.watchPaymentFailure();await delay(140);assert.deepEqual(f.calls,['white','fresh']);
 assert.equal(Object.values(e.state.events).some(i=>i.payment_failure_retry_of),false);
 // Queue the local fallback after another failure, then supersede it before dispatch.
 f.pending.get('fresh').ok();await turn();await turn();e.state.events.fresh.timestamps.apple_pay_sheet_requested_at=new Date().toISOString();e.nextPaymentPoll=0;
 await e.watchPaymentFailure();const fallback=Object.values(e.state.events).find(i=>i.payment_failure_retry_of);
 f.router.accept(f.event('brand-new'));await delay(140);assert.deepEqual(f.calls,['white','fresh','brand-new']);assert.equal(fallback.status,'expired');
});
test('manual restore handles one profile only and preserves another profile payment owner',async t=>{
 const f=fixture(t);let restored=0;f.slots[0].browser.manualRetryToPickup=async()=>restored++;
 f.slots[1].browser.tryClaimApplePay('black-payment');
 const result=f.router.manualRetry({profile_label:'A',expected_event_id:null,restore_only:true});
 await turn();await turn();assert.equal(restored,1);assert.deepEqual(f.calls,[]);assert.equal(f.slots[0].engine.state.active,null);
 assert.equal(f.slots[0].engine.state.events[result.event_id].status,'manual_retry_ready');assert.equal(f.router.paymentOwner,'black-payment');
});
test('manual retry waits for old runner, deduplicates preparation, and does not interrupt another SKU',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));f.router.accept(f.event('black',1));await turn();let restores=0;
 f.slots[0].browser.manualRetryToPickup=async()=>{restores++;assert.notEqual(f.slots[0].engine.state.events.white.status,'running');};
 const a=f.router.manualRetry({profile_label:'A',expected_event_id:'white',restore_only:false});
 const b=f.router.manualRetry({profile_label:'A',expected_event_id:'white',restore_only:false});assert.equal(a.event_id,b.event_id);
 await turn();assert.equal(restores,0);assert.equal(f.slots[0].browser.abortEventId,'white');
 f.pending.get('white').bad(new Stop('pickup_task_deadline'));await delay(160);await turn();
 assert.equal(restores,1);assert.deepEqual(f.calls,['white','black',a.event_id]);assert.equal(f.slots[1].engine.state.active,'black');
});
test('manual retry refuses stale ownership and reports failed restore without starting checkout',async t=>{
 const f=fixture(t);f.router.accept(f.event('white'));await turn();
 assert.throws(()=>f.router.manualRetry({profile_label:'A',expected_event_id:null,restore_only:false}),e=>e.code==='retry_owner_changed');
 f.pending.get('white').ok();await turn();await turn();
 f.slots[0].browser.manualRetryToPickup=async()=>{throw new Stop('manual_retry_pickup_not_ready');};
 const retry=f.router.manualRetry({profile_label:'A',expected_event_id:'white',restore_only:false});await turn();await turn();
 assert.deepEqual(f.calls,['white']);assert.equal(f.slots[0].engine.state.active,null);assert.equal(f.slots[0].engine.state.events[retry.event_id].status,'manual_review');
});
test('Guest confirmed failure returns to standby without synthesizing an old-stock retry',async t=>{
 const f=fixture(t);f.slots[0].browser.config={checkout_method:'guest_credit'};f.router.accept(f.event('guest'));await turn();f.pending.get('guest').ok();await turn();await turn();
 const e=f.slots[0].engine;e.state.events.guest.timestamps.guest_order_requested_at=new Date().toISOString();
 f.slots[0].browser.inspectPaymentFailure=async()=>({outcome:'failed',recoverable:true,observed:true,closed:true,phase:'guest_order_failed'});f.slots[0].browser.recoverPaymentFailure=async()=>{};
 assert.equal(await e.watchPaymentFailure(),true);await delay(140);assert.equal(e.state.active,null);assert.deepEqual(f.calls,['guest']);
});

test('latest-only coalescing keeps one fresh candidate and never replays superseded stock',async t=>{
 const f=fixture(t);f.router.config.latest_candidate_only=true;f.router.accept(f.event('working'));await turn();
 for(const id of ['old','middle','latest'])f.router.accept(f.event(id));
 assert.deepEqual(f.router.waiting().map(x=>x.item.event_id),['latest']);
 assert.equal(f.slots[0].engine.state.events.old.reason,'superseded_by_newer_same_configuration');
 f.pending.get('working').bad(new Stop('pickup_stalled_yield'));await delay(140);await turn();
 assert.deepEqual(f.calls,['working','latest']);
});
test('Guest submitted results cannot be unlocked by the generic 60-second deadline',async t=>{
 const f=fixture(t);const e=f.slots[0].engine;
 e.state.active='pending';e.state.events.pending={...f.event('pending'),status:'order_result_unknown',timestamps:{received_at:new Date(Date.now()-120000).toISOString(),guest_order_requested_at:new Date(Date.now()-60000).toISOString()}};
 f.router.watchProfileTimeouts();assert.equal(e.state.active,'pending');assert.equal(f.slots[0].browser.abortEventId,undefined);
});

test('a held response after preflight never leaks a reservation and blocks future maintenance',async t=>{
 const f=fixture(t),slot=f.slots[0],event=f.event('arrived-during-release');
 await f.router.beforeAccept(event);assert.equal(slot.reservedEvent,event.event_id);
 slot.engine.releasing=true;assert.equal(f.router.accept(event).body.status,'held');assert.equal(slot.reservedEvent,null);
 slot.engine.releasing=false;f.router.dispatchProfile(slot);await turn();assert.deepEqual(f.calls,[event.event_id]);
});

test('startup preparation holds only setup slots while the router still accepts fresh notifications',async t=>{
 const f=fixture(t);f.router.config.standby_page='pickup_checkout';let finish;
 f.slots[0].browser.seedIdle=async()=>new Promise(r=>finish=()=>r({status:'standby_checkout',zip:'07094'}));
 const preparing=f.router.startStandbyInitialization();
 assert.equal(f.slots[0].engine.releasing,true);assert.equal(f.router.accept(f.event('during-startup')).body.status,'held');assert.equal(f.router.waiting().length,1);
 finish();await preparing;assert.equal(f.slots[0].engine.releasing,false);
 await delay(140);await turn();assert.deepEqual(f.calls,['during-startup']);
});

test('expired startup session preparation does not delay ready configurations',async t=>{
 const f=fixture(t);f.router.config.standby_page='pickup_checkout';let finish;
 f.slots[0].browser.seedIdle=async({allowRebuild=true}={})=>!allowRebuild?{status:'needs_session_setup'}:new Promise(r=>finish=()=>r({status:'standby_checkout'}));
 f.slots[1].browser.seedIdle=async()=>({status:'standby_checkout'});
 const task=f.router.startStandbyInitialization();await turn();
 assert.equal(f.slots[0].engine.releasing,true);assert.equal(f.slots[1].engine.releasing,false);
 assert.equal(f.router.accept(f.event('other-ready',1)).body.status,'queued');await turn();assert.deepEqual(f.calls,['other-ready']);
 finish();await task;
});
