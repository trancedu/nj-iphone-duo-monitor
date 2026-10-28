import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {guestCheckoutDOM,sampleBilling,guestAdapter} from '../safari/guest_checkout.mjs';
const prefix='checkout.billing.billingOptions.selectedBillingOptions.creditCard.';
async function fixture(t,layout='combined'){
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 const input=(suffix,value='')=>`<input id="${prefix+suffix}" value="${value}">`;
 let html=['cardInputs.cardInput-0.cardNumber','cardInputs.cardInput-0.expiration','cardInputs.cardInput-0.securityCode','billingAddress.address.firstName','billingAddress.address.lastName','billingAddress.address.street','billingAddress.address.street2','billingAddress.address.zipLookup.postalCode'].map(s=>input(s)).join('');
 html+=input('billingAddress.address.countryCode','United States')+'<input id="checkout.billing.billingoptions.credit" type="radio"><button onclick="window.payClicks=(window.payClicks||0)+1">Continue</button>';
 html+=layout==='separate'?'<input name="city"><select name="state"><option value="">State</option><option value="NJ">New Jersey</option></select>':`<select id="${prefix}billingAddress.address.zipLookup.zipLookupCityState"></select>`;
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('https://secure7.store.apple.com/shop/checkout?_s=Billing-init');
 const call=(op)=>page.evaluate(guestCheckoutDOM,{op,billing:sampleBilling});return {page,call};
}
test('separate City/State are explicitly filled and verified without billing Continue',async t=>{
 const f=await fixture(t,'separate');await f.call('selectCredit');await f.call('fillBilling');
 assert.equal((await f.call('verifyBilling')).ready,false);
 assert.deepEqual(await f.call('settleCityState'),{ready:true,layout:'separate'});
 const r=await f.call('verifyBilling');assert.equal(r.ready,true);assert.equal(r.city_state_verified,true);
 assert.equal(await f.page.evaluate(()=>window.payClicks||0),0);
 assert.equal(await f.page.locator('input[name=city]').inputValue(),'Secaucus');
 assert.equal(await f.page.locator('select[name=state]').inputValue(),'NJ');
});
test('combined location waits for ZIP options, selects exact city, and rejects wrong city',async t=>{
 const f=await fixture(t);await f.call('fillBilling');
 assert.equal((await f.call('settleCityState')).ready,false);assert.equal((await f.call('verifyBilling')).ready,false);
 await f.page.locator('select').evaluate(e=>{e.innerHTML='<option value="wrong">Newark, NJ</option><option value="right">Secaucus, NJ</option>';});
 assert.equal((await f.call('verifyBilling')).ready,false);
 assert.deepEqual(await f.call('settleCityState'),{ready:true,layout:'combined'});
 assert.equal((await f.call('verifyBilling')).ready,true);
 assert.equal(await f.page.evaluate(()=>window.payClicks||0),0);
});
test('billing supports only dummy card and never rewrites an unchanged ZIP',async t=>{
 const f=await fixture(t,'separate');await f.page.locator('input[id$=".postalCode"]').evaluate(e=>e.addEventListener('change',()=>window.zipChanges=(window.zipChanges||0)+1));
 await f.page.evaluate(guestCheckoutDOM,{op:'fillBilling',billing:{...sampleBilling,card_number:'4111111111111111'}});
 await f.call('fillBilling');assert.equal(await f.page.evaluate(()=>window.zipChanges),1);
 assert.equal(await f.page.locator('input[id$=".cardNumber"]').inputValue(),'0000000000000000');
 await assert.rejects(()=>f.call('submitPayment'),/unsupported_guest_operation/);
 assert.equal(await f.page.evaluate(()=>window.payClicks||0),0);
});
test('guest adapter cannot call Apple Pay, add products, or silently rebuild checkout',async()=>{
 const w=guestAdapter({call:async()=>{throw Error('unexpected_call');}});
 for(const op of ['requestApplePay','add','checkout'])await assert.rejects(()=>w.call(op),/guest_forbidden_action/);
 assert.throws(()=>w.goto('https://www.apple.com/shop/bag'),/guest_unexpected_checkout_rebuild/);
});
test('guest fill refuses an Apple Pay checkout route',async t=>{
 const f=await fixture(t);await f.page.goto('https://secure7.store.apple.com/shop/apw/checkout?_s=Billing-init');
 await assert.rejects(()=>f.call('fillBilling'),/guest_checkout_path_required/);
});
test('visible credit radio waits for hydration before the runner may select it',async t=>{
 const f=await fixture(t);assert.equal((await f.call('creditReady')).ready,false);
 await f.page.locator('input[type=radio]').evaluate(e=>{e.__reactProps$test={onChange:()=>{}};});
 assert.equal((await f.call('creditReady')).ready,true);
});

test('native account prompt must be cancelled and absent before Guest continuation',async()=>{
 const {cancelGuestSignIn}=await import('../safari/guest_checkout.mjs');let clock=0,open=true;const stages=[],calls=[];
 const result=await cancelGuestSignIn({},n=>stages.push(n),{now:()=>clock,pause:async ms=>{clock+=ms;},probe:async cancel=>{calls.push(cancel);if(cancel){open=false;return 'cancelled';}return open?'present':'absent';}});
 assert.equal(result.status,'cancelled_and_closed');assert.deepEqual(stages,['apple_account_cancel_clicked','apple_account_prompt_closed']);assert.deepEqual(calls,[false,true,false]);
});
test('missing native prompt gets a bounded appearance grace; unknown sheets are never cancelled',async()=>{
 const {cancelGuestSignIn,guestAccountPromptScript}=await import('../safari/guest_checkout.mjs');let clock=0;
 const result=await cancelGuestSignIn({},()=>{},{now:()=>clock,pause:async ms=>{clock+=ms;},probe:async()=> 'absent'});
 assert.equal(result.status,'not_present');assert.equal(clock,2000);
 let clicks=0;clock=0;await assert.rejects(()=>cancelGuestSignIn({},()=>{},{now:()=>clock,pause:async ms=>{clock+=ms;},probe:async cancel=>{if(cancel)clicks++;return 'unknown_sheet';}}),/unknown_guest_sheet/);assert.equal(clicks,0);
 assert.throws(()=>guestAccountPromptScript('UnrelatedWindow',{cancel:true}),/isolated_guest_profile/);
});
test('native cancellation failure stops the flow instead of falling through to Guest',async()=>{
 const {cancelGuestSignIn}=await import('../safari/guest_checkout.mjs');
 await assert.rejects(()=>cancelGuestSignIn({},()=>{},{probe:async cancel=>cancel?'absent':'present'}),/cancel_unconfirmed/);
});

test('native sheet may render before account text, then cancellation precedes Guest',async()=>{
 const {cancelGuestSignIn}=await import('../safari/guest_checkout.mjs');let clock=0,closed=false;const stages=[];
 const result=await cancelGuestSignIn({},n=>stages.push(n),{now:()=>clock,pause:async ms=>{clock+=ms;},probe:async cancel=>{if(cancel){closed=true;return 'cancelled';}return closed?'absent':clock<400?'unknown_sheet':'present';}});
 assert.equal(result.status,'cancelled_and_closed');assert.deepEqual(stages,['apple_account_cancel_clicked','apple_account_prompt_closed']);
});
test('batched location tick verifies City/State and fields without clicking Continue',async t=>{
 const f=await fixture(t,'separate');await f.call('fillBilling');const result=await f.call('billingTick');
 assert.equal(result.ready,true);assert.equal(result.city_state_verified,true);assert.equal(result.payment_submitted,false);
 assert.equal(await f.page.evaluate(()=>window.payClicks||0),0);
});
test('warm Guest reset refuses production profiles before touching a page',async()=>{
 const {resetGuestTestPickup}=await import('../safari/guest_checkout.mjs');
 await assert.rejects(()=>resetGuestTestPickup({profile:'Duo512Black'}),/isolated_test_profile/);
});

test('card environment normalizes spaces and expiry; partial or malformed data fails without echoing values',async()=>{
 const {readGuestCard}=await import('../safari/guest_checkout.mjs');
 assert.deepEqual(readGuestCard({APPLE_GUEST_CARD_NUMBER:'0000 0000 0000 0000',APPLE_GUEST_CARD_EXPIRY:'12/30',APPLE_GUEST_CARD_CVV:'000'}),{number:'0000000000000000',expiry:'1230',cvv:'000'});
 assert.throws(()=>readGuestCard({APPLE_GUEST_CARD_NUMBER:'do-not-log-me'}),/incomplete_guest_card_environment/);
 assert.throws(()=>readGuestCard({APPLE_GUEST_CARD_NUMBER:'invalid',APPLE_GUEST_CARD_EXPIRY:'13/30',APPLE_GUEST_CARD_CVV:'000'}),/invalid_guest_card_environment/);
});
test('provided card is used in fill and verification, never returned in diagnostic values',async t=>{
 const f=await fixture(t,'separate'),card={number:'4111111111111111',expiry:'1230',cvv:'000'};
 await f.page.evaluate(guestCheckoutDOM,{op:'fillBilling',billing:sampleBilling,card});
 const result=await f.page.evaluate(guestCheckoutDOM,{op:'billingTick',billing:sampleBilling,card});
 assert.equal(result.ready,true);assert.equal(await f.page.locator('input[id$=".cardNumber"]').inputValue(),card.number);
 assert.equal(JSON.stringify(result).includes(card.number),false);
});
test('Billing Continue validates fields and runs once; test still never places an order',async t=>{
 const f=await fixture(t,'separate');await f.page.locator('button').evaluate(e=>{e.id='rs-checkout-continue-button-bottom';});
 await assert.rejects(()=>f.call('continueBilling'),/billing_not_verified/);
 await f.call('fillBilling');await f.call('billingTick');
 assert.equal((await f.call('continueBilling')).continue_requested,true);
 assert.equal(await f.page.evaluate(()=>window.payClicks),1);
 await assert.rejects(()=>f.call('continueBilling'),/billing_continue_already_requested/);
 assert.equal(await f.page.evaluate(()=>window.payClicks),1);
});
async function reviewFixture(t,{quantity=1,total='$1,278.43'}={}){
 const f=await fixture(t);await f.page.goto('https://secure7.store.apple.com/shop/checkout?_s=Review');
 await f.page.setContent(`<h1>Ready to place your order?</h1><div data-autom="bag-item-1"><h2>iPhone 18 Pro 256GB Burgundy</h2><div class="rs-quantity-text"><span class="visuallyhidden">Quantity</span><span>${quantity}</span></div></div><div data-autom="bagtotalvalue">${total}</div><button id="rs-checkout-continue-button-bottom" data-autom="continue-button-placeOrder" onclick="window.orders=(window.orders||0)+1">Place Your Order</button>`);
 return {...f,order:args=>f.page.evaluate(guestCheckoutDOM,{op:'placeOrder',event_id:'test-order',expected_product:'iPhone 18 Pro 256GB Burgundy',max_total_usd:1300,...args})};
}
test('test review always stops before Place Your Order',async t=>{
 const f=await reviewFixture(t);assert.equal((await f.call('reviewState')).ready,true);
 await assert.rejects(()=>f.order({mode:'test'}),/place_order_forbidden_in_test/);
 assert.equal(await f.page.evaluate(()=>window.orders||0),0);
 const {completeGuestPayment}=await import('../safari/guest_checkout.mjs');
 await assert.rejects(()=>completeGuestPayment({profile:'PickupTest18Pro'},{mode:'production'}),/test_profile_cannot_place_order/);
});
test('production final click is bounded by amount and persisted against repeats',async t=>{
 const f=await reviewFixture(t);await assert.rejects(()=>f.order({mode:'production',max_total_usd:1200}),/amount_or_quantity/);
 const result=await f.order({mode:'production'});assert.equal(result.order_requested,true);assert.equal(result.order_confirmed,false);
 await assert.rejects(()=>f.order({mode:'production'}),/already_requested/);
 assert.equal(await f.page.evaluate(()=>window.orders),1);
});
test('production refuses quantity two, wrong product, or missing budget',async t=>{
 const f=await reviewFixture(t,{quantity:2});await assert.rejects(()=>f.order({mode:'production'}),/amount_or_quantity/);
 await assert.rejects(()=>f.order({mode:'production',expected_product:'iPhone Duo'}),/product_not_verified/);
 assert.equal(await f.page.evaluate(()=>window.orders||0),0);
});
test('production signal requires an explicit budget and refuses a test profile before browser actions',async()=>{
 const {runGuestSignal}=await import('../safari/guest_checkout.mjs');
 await assert.rejects(()=>runGuestSignal({profile:'Duo256Black'},'',{},sampleBilling,()=>{},{mode:'production'}),/budget_and_profile/);
 await assert.rejects(()=>runGuestSignal({profile:'PickupTest18Pro'},'',{},sampleBilling,()=>{},{mode:'production',max_total_usd:1400}),/budget_and_profile/);
});
test('Guest contact accepts shortened Continue only on the verified contact page',async t=>{
 const f=await fixture(t);await f.page.goto('https://secure7.store.apple.com/shop/checkout?_s=PickupContact-init');
 await f.page.setContent('<h1>Now fill out your pickup information.</h1>'+['firstName','lastName','emailAddress','fullDaytimePhone'].map(name=>`<input name="${name}">`).join('')+'<button id="rs-checkout-continue-button-bottom" onclick="window.continued=true">Continue</button>');
 assert.equal((await f.call('contactReady')).ready,true);
 await f.page.locator('h1').evaluate(e=>e.textContent='Different step');assert.equal((await f.call('contactReady')).ready,false);
});

test('card fields are re-entered on every fill, while unchanged ZIP does not retrigger lookup',async t=>{
 const f=await fixture(t,'separate');
 await f.page.locator('input[id$=".cardNumber"]').evaluate(e=>e.addEventListener('input',()=>window.cardWrites=(window.cardWrites||0)+1));
 await f.page.locator('input[id$=".postalCode"]').evaluate(e=>e.addEventListener('input',()=>window.zipWrites=(window.zipWrites||0)+1));
 await f.call('fillBilling');await f.call('fillBilling');
 assert.equal(await f.page.evaluate(()=>window.cardWrites),4);assert.equal(await f.page.evaluate(()=>window.zipWrites),1);
});
test('editing retained payment returns Billing without init suffix; fill and Continue remain valid',async t=>{
 const f=await fixture(t,'separate');await f.page.goto('https://secure7.store.apple.com/shop/checkout?_s=Billing');
 await f.page.locator('button').evaluate(e=>e.id='rs-checkout-continue-button-bottom');
 await f.call('fillBilling');assert.equal((await f.call('billingTick')).ready,true);
 assert.equal((await f.call('continueBilling')).continue_requested,true);
});
test('pre-prepared Review verifies target, quantity, store and payment without filling card',async t=>{
 const f=await reviewFixture(t);
 await f.page.evaluate(()=>{const e=document.createElement('div');e.className='rs-review-billing-details';e.innerText='Visa ending in 2349';document.body.append(e);const s=document.createElement('div');s.innerText='Pick up at Apple American Dream';document.body.append(s);});
 const args={op:'preparedReviewState',expected_product:'iPhone 18 Pro 256GB Burgundy',expected_store:'Apple American DreamAvailable TodayIn-Store Pickup'};
 assert.equal((await f.page.evaluate(guestCheckoutDOM,args)).ready,true);
 assert.equal((await f.page.evaluate(guestCheckoutDOM,{...args,expected_store:'Apple Queens Center'})).ready,false);
 await f.page.locator('.rs-review-billing-details').evaluate(e=>e.remove());
 assert.equal((await f.page.evaluate(guestCheckoutDOM,args)).ready,false);
 assert.equal(await f.page.evaluate(()=>window.orders||0),0);
});

test('Guest order failure observer is event-bound and never treats generic errors or success as retryable',async t=>{
 const f=await reviewFixture(t);await f.order({mode:'production'});
 const args={op:'guestOrderState',event_id:'test-order',expected_product:'iPhone 18 Pro 256GB Burgundy'};
 assert.equal((await f.page.evaluate(guestCheckoutDOM,args)).outcome,'unknown');
 await f.page.evaluate(()=>{const e=document.createElement('div');e.setAttribute('role','alert');e.innerText='Something went wrong';document.body.append(e);});
 assert.equal((await f.page.evaluate(guestCheckoutDOM,args)).recoverable,false);
 await f.page.locator('[role=alert]').evaluate(e=>e.innerText='Your payment was declined');
 assert.equal((await f.page.evaluate(guestCheckoutDOM,args)).recoverable,true);
 assert.equal((await f.page.evaluate(guestCheckoutDOM,{...args,event_id:'other-event'})).recoverable,false);
 await f.page.locator('h1').evaluate(e=>e.textContent='Thank you for your order');
 const confirmed=await f.page.evaluate(guestCheckoutDOM,args);assert.equal(confirmed.outcome,'success');assert.equal(confirmed.recoverable,false);
});
test('confirmed Guest failure returns to pickup and retires the old event',async t=>{
 const f=await reviewFixture(t);await f.order({mode:'production'});
 await f.page.evaluate(()=>{const e=document.createElement('div');e.setAttribute('role','alert');e.innerText='Your payment was declined';document.body.append(e);});
 const result=await f.page.evaluate(guestCheckoutDOM,{op:'recoverGuestOrderFailure',event_id:'test-order',expected_product:'iPhone 18 Pro 256GB Burgundy'});
 assert.equal(result.recovered,true);await f.page.waitForURL(/_s=Fulfillment-init/);
 assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('duo_guest_order_requested_v1')),null);
 assert.deepEqual(await f.page.evaluate(()=>JSON.parse(sessionStorage.getItem('duo_guest_failed_events_v1'))),['test-order']);
});

test('Keychain source fails closed without falling back to card environment values',async()=>{
 const {readGuestCard}=await import('../safari/guest_checkout.mjs');
 assert.throws(()=>readGuestCard({APPLE_GUEST_CARD_SOURCE:'keychain',APPLE_GUEST_KEYCHAIN_HELPER:'/nonexistent/iphone-duo-helper',APPLE_GUEST_CARD_NUMBER:'sensitive-marker',APPLE_GUEST_CARD_CVV:'sensitive-marker'}),e=>e.message==='guest_card_keychain_unavailable'&&!e.message.includes('sensitive-marker'));
 assert.throws(()=>readGuestCard({APPLE_GUEST_CARD_SOURCE:'unknown'}),/unknown_guest_card_source/);
});

test('CVV subtraction restores three digits including leading zeroes and rejects invalid encodings',async()=>{
 const {decodeGuestCVV,readGuestCard}=await import('../safari/guest_checkout.mjs');
 for(const original of ['000','007','123','999'])assert.equal(decodeGuestCVV(String(1003-Number(original)),'subtract_1003'),original);
 assert.equal(decodeGuestCVV('123','plain'),'123');
 for(const value of ['0','3','1004','-1','bad',''])assert.throws(()=>decodeGuestCVV(value,'subtract_1003'),/invalid_guest_cvv_encoding/);
 assert.throws(()=>decodeGuestCVV('880','unknown'),/unknown_guest_cvv_encoding/);
 assert.equal(readGuestCard({APPLE_GUEST_CARD_NUMBER:'0000000000000000',APPLE_GUEST_CARD_EXPIRY:'12/30',APPLE_GUEST_CARD_CVV:'880',APPLE_GUEST_CVV_MODE:'subtract_1003'}).cvv,'123');
});

test('989 CVV encoding restores leading zeroes and supports negative stored values',async()=>{
 const {decodeGuestCVV}=await import('../safari/guest_checkout.mjs');
 for(const cvv of ['000','007','123','989','990','999'])assert.equal(decodeGuestCVV(String(989-Number(cvv)),'subtract_989'),cvv);
 for(const value of ['990','-11','NaN','1.5'])assert.throws(()=>decodeGuestCVV(value,'subtract_989'),/invalid_guest_cvv_encoding/);
});

test('a hidden full-screen target never counts as absence of an account dialog',async()=>{
 const {cancelGuestSignIn}=await import('../safari/guest_checkout.mjs');let clock=0,cancels=0;
 await assert.rejects(()=>cancelGuestSignIn({},()=>{},{now:()=>clock,pause:async ms=>clock+=ms,probe:async cancel=>{if(cancel)cancels++;return 'target_window_not_visible';}}),/guest_target_window_not_visible/);
 assert.equal(cancels,0);assert.ok(clock>=4000);
});
