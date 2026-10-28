import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../engine.mjs';
import {paymentLifecycleDOM} from '../safari/payment.mjs';
const product='iPhone 18 Pro 256GB Burgundy';
async function fixture(t){
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<h1>Now fill out your pickup information.</h1><p>${product}</p><div role="alert"></div>`}));
 await page.goto('https://secure7.store.apple.com/shop/apw/checkout?_s=PickupContact-init');
 await page.evaluate(()=>{window.ApplePaySession=class extends EventTarget{static STATUS_SUCCESS=0;static STATUS_FAILURE=1;begin(){return 'begun';}completePayment(value){window.originalResult=value;return 'completed';}};});
 const call=(op,event_id='one')=>page.evaluate(paymentLifecycleDOM,{op,args:{event_id,product}});
 await call('observePaymentAttempt');return {page,call};
}
test('failure completion is observed without altering original results or handlers',async t=>{
 const f=await fixture(t);await f.call('observePaymentAttempt');
 const result=await f.page.evaluate(()=>{window.session=new ApplePaySession();window.session.addEventListener('paymentauthorized',()=>window.originalHandler=true);const started=session.begin();session.dispatchEvent(new Event('paymentauthorized'));const ended=session.completePayment({status:ApplePaySession.STATUS_FAILURE});return {started,ended,originalHandler,forwarded:originalResult.status};});
 assert.deepEqual(result,{started:'begun',ended:'completed',originalHandler:true,forwarded:1});
 const state=await f.call('paymentFailureState');assert.equal(state.outcome,'failed');assert.equal(state.recoverable,true);
 assert.equal((await f.call('paymentFailureState','other')).recoverable,false);
 await f.call('recoverPaymentFailure');await f.page.waitForURL(/_s=Fulfillment-init/);
});
test('cancel alone and success do not become a confirmed failure; new attempts reset outcome',async t=>{
 const f=await fixture(t);await f.page.evaluate(()=>{window.session=new ApplePaySession();session.begin();session.dispatchEvent(new Event('cancel'));});
 assert.equal((await f.call('paymentFailureState')).recoverable,false);
 await f.page.evaluate(()=>{window.session=new ApplePaySession();session.begin();session.completePayment(ApplePaySession.STATUS_SUCCESS);});
 assert.equal((await f.call('paymentFailureState')).outcome,'success');
 assert.equal((await f.call('paymentFailureState')).recoverable,false);
 await f.call('observePaymentAttempt','two');await f.page.evaluate(()=>{window.session=new ApplePaySession();session.begin();});
 assert.equal((await f.call('paymentFailureState','two')).outcome,'unknown');
});
test('explicit ten-second return policy also navigates after success without inferring order status',async t=>{
 const f=await fixture(t);await f.page.evaluate(()=>{window.session=new ApplePaySession();session.begin();session.completePayment(0);});
 await f.call('expirePaymentWindow');await f.page.waitForURL(/_s=Fulfillment-init/);
 assert.equal(await f.page.evaluate(()=>JSON.parse(sessionStorage.duo_payment_attempt_v1).outcome),'success');
});
test('hard payment deadline unlocks at ten seconds, before recovery, and never waits for outcome',async t=>{
 const root=mkdtempSync(join(tmpdir(),'payment-deadline-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let inspected=0,recovered=0,release;
 const browser={ready:()=>true,inspectPaymentFailure:async()=>{inspected++;return {outcome:'unknown'};},expirePaymentWindow:async()=>{recovered++;assert.equal(e.state.active,null);await new Promise(r=>release=r);}};
 const e=new Engine({state_dir:root},browser),at=Date.now();
 e.state.active='one';e.state.events.one={event_id:'one',status:'awaiting_user',timestamps:{apple_pay_sheet_requested_at:new Date(at).toISOString()}};
 assert.equal(await e.watchPaymentDeadline(at+9999),false);
 const task=e.watchPaymentDeadline(at+10000);assert.equal(e.state.active,null);assert.equal(e.releasing,true);assert.equal(recovered,1);assert.equal(inspected,0);
 release();assert.equal(await task,true);assert.equal(e.releasing,false);assert.equal(e.state.events.one.release_reason,'payment_window_10_seconds');
 assert.equal(await e.watchPaymentDeadline(at+20000),false);assert.equal(recovered,1);
});
test('confirmed failure releases early; unreadable/unknown outcomes stay protected until deadline',async t=>{
 const root=mkdtempSync(join(tmpdir(),'payment-failure-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let state={outcome:'unknown',recoverable:false},restored=0;
 const e=new Engine({state_dir:root},{ready:()=>true,inspectPaymentFailure:async()=>state,recoverPaymentFailure:async()=>{restored++;}});
 e.state.active='one';e.state.events.one={event_id:'one',status:'awaiting_user',timestamps:{apple_pay_sheet_requested_at:new Date().toISOString()}};
 assert.equal(await e.watchPaymentFailure(1000),false);assert.equal(e.state.active,'one');
 state={outcome:'failed',recoverable:true};assert.equal(await e.watchPaymentFailure(2001),true);assert.equal(e.state.active,null);assert.equal(restored,1);
});
test('manual button clicks are tracked even if native lifecycle API is unavailable',async t=>{
 const f=await fixture(t);await f.page.evaluate(()=>{delete window.ApplePaySession;const b=document.createElement('button');b.id='co-options-applePay';b.textContent='Continue with Apple Pay';document.body.append(b);});
 assert.equal((await f.call('observePaymentAttempt')).installed,true);
 await f.page.getByRole('button',{name:'Continue with Apple Pay'}).click();
 const state=await f.call('paymentFailureState');assert.equal(state.observed,true);assert.equal(state.phase,'manual_button_clicked');assert.ok(Number.isFinite(Date.parse(state.requested_at)));
});
test('manual panel starts the same deadline from its actual observed opening time',async t=>{
 const root=mkdtempSync(join(tmpdir(),'manual-payment-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const at=new Date(Date.now()-3000).toISOString();let owner;
 const e=new Engine({state_dir:root},{ready:()=>true,expirePaymentWindow:async()=>{},inspectPaymentFailure:async()=>({observed:true,requested_at:at,phase:'sheet_displayed',outcome:'unknown',closed:false,recoverable:false})});
 t.after(()=>clearTimeout(e.paymentDeadlineTimer));e.onPaymentWindowObserved=(id,time)=>owner={id,time};
 e.state.active='manual';e.state.events.manual={event_id:'manual',status:'awaiting_user',timestamps:{payment_observer_armed_at:new Date().toISOString()}};
 await e.watchPaymentFailure();assert.equal(e.state.events.manual.timestamps.apple_pay_sheet_requested_at,at);assert.deepEqual(owner,{id:'manual',time:at});
 assert.equal(await e.watchPaymentDeadline(Date.parse(at)+9999),false);assert.equal(await e.watchPaymentDeadline(Date.parse(at)+10000),true);assert.equal(e.state.active,null);
});
test('contact page can recover a bound failed attempt even when order summary is not rendered',async t=>{
 const f=await fixture(t);await f.page.locator('p').evaluate(e=>e.remove());
 await f.page.evaluate(()=>{window.session=new ApplePaySession();session.begin();session.completePayment(ApplePaySession.STATUS_FAILURE);});
 assert.equal((await f.call('paymentFailureState')).recoverable,true);
 const wrong=await f.page.evaluate(paymentLifecycleDOM,{op:'paymentFailureState',args:{event_id:'one',product:'iPhone Duo 512GB Night Sky'}});
 assert.equal(wrong.recoverable,false);
});
test('confirmed failure releases SKU before slow page recovery instead of holding it twenty seconds',async t=>{
 const root=mkdtempSync(join(tmpdir(),'payment-fast-release-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let finish;
 const e=new Engine({state_dir:root},{ready:()=>true,inspectPaymentFailure:async()=>({observed:true,outcome:'failed',closed:true,recoverable:true}),recoverPaymentFailure:async()=>new Promise(r=>finish=r)});
 e.state.active='one';e.state.events.one={event_id:'one',status:'awaiting_user',timestamps:{apple_pay_sheet_requested_at:new Date().toISOString()}};
 const recovering=e.watchPaymentFailure();await new Promise(r=>setImmediate(r));
 assert.equal(e.state.active,null);assert.equal(e.releasing,true);assert.equal(e.state.events.one.status,'payment_failed_recovering');
 finish();assert.equal(await recovering,true);assert.equal(e.releasing,false);
});
test('manual recovery requires explicit intent and reuses an existing pickup page without reload',async t=>{
 const f=await fixture(t);await f.page.evaluate(()=>{history.replaceState(null,'','?_s=Fulfillment-init');window.__duoApplePayRequested=true;window.__duoPickupStoreSelected=true;});
 await assert.rejects(()=>f.call('manualRetryPickup'),/explicit_manual_retry_required/);
 const before=await f.page.evaluate(()=>performance.timeOrigin);
 const result=await f.page.evaluate(paymentLifecycleDOM,{op:'manualRetryPickup',args:{event_id:'manual-new',product,confirm_manual_retry:true}});
 assert.deepEqual(result,{returned:true,navigating:false});assert.equal(await f.page.evaluate(()=>performance.timeOrigin),before);assert.equal(await f.page.evaluate(()=>window.__duoApplePayRequested),false);
});
test('Guest order observation never starts an Apple Pay timer and only explicit failure restores pickup',async t=>{
 const root=mkdtempSync(join(tmpdir(),'guest-payment-watch-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let state={observed:true,requested_at:new Date().toISOString(),phase:'guest_order_pending',outcome:'unknown',recoverable:false},restored=0;
 const e=new Engine({state_dir:root},{ready:()=>true,inspectPaymentFailure:async()=>state,recoverPaymentFailure:async()=>{restored++;}});
 e.state.active='guest';e.state.events.guest={event_id:'guest',status:'awaiting_user',timestamps:{guest_order_requested_at:new Date().toISOString()}};
 assert.equal(await e.watchPaymentFailure(1000),false);assert.equal(e.state.events.guest.timestamps.apple_pay_sheet_requested_at,undefined);assert.equal(e.paymentDeadlineTimer,undefined);
 state={...state,phase:'guest_order_failed',outcome:'failed',closed:true,recoverable:true};
 assert.equal(await e.watchPaymentFailure(2001),true);assert.equal(restored,1);assert.equal(e.state.active,null);
});
