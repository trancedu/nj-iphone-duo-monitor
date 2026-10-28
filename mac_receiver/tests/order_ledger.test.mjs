import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrderLedger} from '../order_ledger.mjs';
import {Engine} from '../engine.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'order-ledger-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let clock=Date.parse('2026-10-28T23:00:00Z');const ledger=new OrderLedger(dir,{now:()=>clock});return {dir,ledger,setClock:n=>clock=n};}
const ev=(id,product=id)=>({event_id:id,product_url:product});
test('all profiles share four durable reservations, success consumes quota and explicit failure returns it',t=>{
 const {ledger,dir}=fixture(t);
 for(let i=0;i<4;i++)ledger.reserve(ev('id'+i));
 assert.throws(()=>ledger.reserve(ev('id4')),/daily_order_limit_reached/);
 ledger.settle('id0','success');assert.equal(ledger.health().remaining,0);
 ledger.settle('id1','failed');assert.equal(ledger.health().remaining,1);
 ledger.reserve(ev('id4'));assert.equal(new OrderLedger(dir).health().occupied,4);
});
test('unknown results survive restart and prevent duplicate submissions for the same configuration',t=>{
 const {ledger,dir}=fixture(t);ledger.reserve(ev('one','white'));ledger.settle('one','unknown');
 const restored=new OrderLedger(dir);assert.throws(()=>restored.reserve(ev('two','white')),/configuration_order_unresolved/);
 assert.throws(()=>restored.reserve(ev('one','white')),/order_already_reserved/);
 restored.settle('one','success');assert.equal(restored.settle('one','failed'),false);assert.equal(restored.health().confirmed,1);
});
test('quota resets at New York midnight, but old unresolved payments remain conservative reservations',t=>{
 const f=fixture(t);f.setClock(Date.parse('2026-10-29T03:59:59Z'));f.ledger.reserve(ev('known'));f.ledger.settle('known','success');f.ledger.reserve(ev('unknown'));
 f.setClock(Date.parse('2026-10-29T04:00:00Z'));assert.equal(f.ledger.health().day,'2026-10-29');assert.equal(f.ledger.health().occupied,1);assert.equal(f.ledger.health().confirmed,0);
});
test('simulations never reserve purchases',t=>{const {ledger}=fixture(t);assert.throws(()=>ledger.reserve({...ev('fake'),simulation_no_payment:true}),/invalid_order_reservation/);assert.equal(ledger.health().occupied,0);});
test('Guest success releases only its own lock, settles quota and re-prepares without resubmitting',async t=>{
 const {dir,ledger}=fixture(t);const item={...ev('one','white'),status:'awaiting_user',timestamps:{guest_order_requested_at:new Date().toISOString()}};ledger.reserve(item);
 let setups=0;const e=new Engine({state_dir:join(dir,'engine'),checkout_method:'guest_credit',guest_auto_rearm:true},{ready:()=>true,inspectPaymentFailure:async()=>({observed:true,outcome:'success'}),rearmAfterGuestSuccess:async()=>{setups++;assert.equal(e.state.active,null);assert.equal(e.releasing,true);}});
 e.onGuestOutcome=(item,outcome)=>ledger.settle(item.event_id,outcome);e.state.active='one';e.state.events.one=item;
 assert.equal(await e.watchPaymentFailure(),true);assert.equal(setups,1);assert.equal(item.status,'order_confirmed');assert.equal(item.rearm_pending,false);assert.equal(ledger.health().confirmed,1);assert.equal(e.state.active,null);
});
test('ten-second unknown Guest result never reloads or retries and can later become confirmed',async t=>{
 const {dir}=fixture(t);let success=false,restores=0;
 const e=new Engine({state_dir:dir,checkout_method:'guest_credit',guest_order_result_timeout_seconds:20},{ready:()=>true,inspectPaymentFailure:async()=>({outcome:success?'success':'unknown',observed:true}),recoverPaymentFailure:async()=>{restores++;}});
 const time=Date.now()-11000;e.state.active='one';e.state.events.one={...ev('one'),status:'awaiting_user',timestamps:{guest_order_requested_at:new Date(time).toISOString()}};
 await e.watchPaymentFailure();assert.equal(e.state.events.one.status,'order_result_unknown');assert.equal(e.state.active,'one');assert.equal(restores,0);
 success=true;assert.equal(await e.watchPaymentFailure(Date.now()+1100),true);assert.equal(e.state.active,null);assert.equal(restores,0);
});

test('submission history is imported conservatively without counting dry-run events',t=>{
 const {ledger}=fixture(t);const event={...ev('old'),status:'lock_timeout',timestamps:{guest_order_requested_at:'2026-10-28T23:00:00Z'}};
 ledger.importExisting(event);assert.equal(ledger.data.orders.old.outcome,'unknown');ledger.importExisting(event);assert.equal(Object.keys(ledger.data.orders).length,1);
 ledger.importExisting({...event,event_id:'sim',simulation_no_payment:true});assert.equal(Object.keys(ledger.data.orders).length,1);
});
test('old terminal history compacts but live or unresolved requests remain protected',t=>{
 const {dir}=fixture(t);const e=new Engine({state_dir:join(dir,'compact')},{ready:()=>true});
 for(const id of ['old-a','old-b','live'])e.state.events[id]={event_id:id,status:id==='live'?'order_result_unknown':'expired',timestamps:{received_at:new Date(Date.now()-700000).toISOString()}};
 e.pruneHistory(1);assert.deepEqual(Object.keys(e.state.events),['live']);
});

test('pre-submit restore failure schedules bounded background preparation without permanently pausing configuration',async t=>{
 const {dir}=fixture(t);let restores=0;
 const browser={ready:()=>true,prepare:async()=>{throw Error('safari_step_timeout');},restoreBeforeGuestSubmit:async()=>{restores++;if(restores===1)throw Error('standby_checkout_protected');}};
 const e=new Engine({state_dir:dir,checkout_method:'guest_credit'},browser),item={...ev('recover'),timestamps:{received_at:new Date().toISOString()},status:'queued'};
 e.state.active=item.event_id;e.state.events[item.event_id]=item;await e.execute(item);
 assert.equal(e.state.active,null);assert.equal(item.status,'recovery_pending');assert.equal(browser.automationBlocked,undefined);assert.equal(e.state.recovery_pending,item.event_id);
 const before=e.state.recovery_retry_at;assert.equal(await e.retryPendingRecovery(before-1),false);assert.equal(restores,1);
 assert.equal(await e.retryPendingRecovery(before),true);assert.equal(restores,2);assert.equal(e.state.recovery_pending,undefined);assert.equal(item.status,'recovered_waiting_for_signal');
});
test('repeated restoration failures back off and never replay a purchase',async t=>{
 const {dir}=fixture(t);let attempts=0;
 const e=new Engine({state_dir:dir,checkout_method:'guest_credit'},{ready:()=>true,restoreBeforeGuestSubmit:async()=>{attempts++;throw Error('safari_apple_event_failed');}});
 e.state.events.one={...ev('one'),status:'recovery_pending',timestamps:{}};e.state.recovery_pending='one';
 await e.retryPendingRecovery(1000);assert.equal(e.state.recovery_retry_at,21000);await e.retryPendingRecovery(21000);assert.equal(e.state.recovery_retry_at,61000);assert.equal(attempts,2);assert.equal(e.state.active,null);
});

test('successful order re-preparation failure retains success and retries setup without another order',async t=>{
 const {dir}=fixture(t);let setups=0;
 const e=new Engine({state_dir:dir,checkout_method:'guest_credit',guest_auto_rearm:true},{ready:()=>true,inspectPaymentFailure:async()=>({outcome:'success',observed:true}),rearmAfterGuestSuccess:async(item,stage,options)=>{setups++;if(setups===1)throw Error('safari_step_timeout');assert.equal(options.confirmedRecovery,true);}});
 const item={...ev('one'),status:'awaiting_user',timestamps:{guest_order_requested_at:new Date().toISOString()}};e.state.events.one=item;e.state.active='one';
 await e.watchPaymentFailure();assert.equal(e.state.active,null);assert.equal(item.status,'order_confirmed_rearm_waiting');assert.equal(e.state.recovery_pending,'one');assert.equal(e.browser.automationBlocked,undefined);
 await e.retryPendingRecovery(e.state.recovery_retry_at);assert.equal(item.status,'order_confirmed');assert.equal(item.rearm_pending,false);assert.equal(setups,2);
});

test('explicit duplicate-risk policy permits new same-SKU events but unknown submissions still consume four slots',t=>{
 const {dir}=fixture(t);const ledger=new OrderLedger(dir,{allowUnknownRetry:true});
 for(let i=0;i<4;i++){ledger.reserve(ev('id'+i,'same-sku'));ledger.settle('id'+i,'unknown');}
 assert.equal(ledger.health().occupied,4);assert.equal(ledger.health().confirmed,0);assert.equal(ledger.unresolved('same-sku'),undefined);
 assert.throws(()=>ledger.reserve(ev('id4','same-sku')),/daily_order_limit_reached/);assert.throws(()=>ledger.reserve(ev('id0','same-sku')),/order_already_reserved/);
});
test('accepted duplicate risk releases unknown order after ten seconds, restores readiness and keeps budget occupied',async t=>{
 const {dir}=fixture(t);const ledger=new OrderLedger(dir,{allowUnknownRetry:true});let rearmed=0;
 const item={...ev('one','sku'),status:'awaiting_user',timestamps:{guest_order_requested_at:new Date(Date.now()-11000).toISOString()}};ledger.reserve(item);
 const e=new Engine({state_dir:join(dir,'engine'),checkout_method:'guest_credit',guest_retry_unknown_orders:true},{ready:()=>true,inspectPaymentFailure:async()=>({outcome:'unknown',observed:true}),rearmAfterUnknownOrder:async()=>{rearmed++;assert.equal(e.state.active,null);return {status:'standby_checkout'};}});
 e.onGuestOutcome=(item,outcome)=>ledger.settle(item.event_id,outcome);e.state.active='one';e.state.events.one=item;
 assert.equal(await e.watchPaymentFailure(),true);assert.equal(rearmed,1);assert.equal(e.state.active,null);assert.equal(item.status,'order_result_unknown_released');assert.equal(ledger.health().occupied,1);assert.equal(ledger.data.orders.one.outcome,'unknown');
 ledger.reserve(ev('two','sku'));assert.equal(ledger.health().occupied,2);
});
