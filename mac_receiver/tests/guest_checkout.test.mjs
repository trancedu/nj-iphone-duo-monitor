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
 assert.throws(()=>guestAccountPromptScript('Duo512Black',{cancel:true}),/isolated_guest_profile/);
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
 return {...f,order:args=>f.page.evaluate(guestCheckoutDOM,{op:'placeOrder',expected_product:'iPhone 18 Pro 256GB Burgundy',max_total_usd:1300,...args})};
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
test('saved Review payment is reused only when card tail and full visible address match',async t=>{
 const f=await reviewFixture(t);await f.page.evaluate(()=>{const e=document.createElement('div');e.className='rs-review-billing';e.innerText='Visa ending in 1111 Test Example 1 Example Street Secaucus, NJ 07094';document.body.append(e);});
 const args={op:'verifySavedReview',billing:sampleBilling,card:{number:'4111111111111111',expiry:'1230',cvv:'000'}};
 const saved=await f.page.evaluate(guestCheckoutDOM,args);assert.equal(saved.ready,true);assert.equal(saved.payment_details_reused,true);
 const wrong=await f.page.evaluate(guestCheckoutDOM,{...args,card:{...args.card,number:'0000000000009999'}});assert.equal(wrong.ready,false);
 const wrongAddress=await f.page.evaluate(guestCheckoutDOM,{...args,billing:{...sampleBilling,street:'2 Different Street'}});assert.equal(wrongAddress.ready,false);
 const wrongUnit=await f.page.evaluate(guestCheckoutDOM,{...args,billing:{...sampleBilling,street2:'Apt 6M'}});assert.equal(wrongUnit.ready,false);
 assert.equal(await f.page.evaluate(()=>window.orders||0),0);
});
