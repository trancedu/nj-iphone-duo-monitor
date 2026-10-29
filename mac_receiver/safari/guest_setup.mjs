// Delivery/payment preparation only. No operation in this module submits an order.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {appleScript,waitFor,prepareSafari,withPreparationTimeout} from './shopping.mjs';
import {runGuestDOM,readGuestCard,cancelGuestSignIn,prepareGuestStandby} from './guest_checkout.mjs';
import {expectedProduct} from '../protocol.mjs';
import {safeErrorCode} from './diagnostics.mjs';

export async function attemptPreparationSignInCancel(window,stage=()=>{},options={}){
 const {cancel=cancelGuestSignIn,...settings}=options;
 try{const result=await cancel(window,stage,{timeoutMs:20000,...settings});return {confirmed:true,status:result.status};}
 catch(error){
  const reason=safeErrorCode(error,'native_cancel_failed');
  if(!['guest_target_window_not_visible','unknown_guest_sheet_requires_manual_review','guest_account_prompt_did_not_close','guest_account_cancel_unconfirmed','guest_account_prompt_reappeared','safari_apple_event_failed','safari_step_timeout','safari_accessibility_permission_required'].includes(reason))throw error;
  stage('setup_native_signin_cancel_unconfirmed',{kind:'guest_native_prompt',error_code:reason});
  return {confirmed:false,reason};
 }
}

export function prewarmDOM({op,shipping={},card={}}){
 const visible=e=>!!e&&!!e.getClientRects().length;
 const norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const u=new URL(location.href),step=u.searchParams.get('_s');
 if(!/^secure\d*\.store\.apple\.com$/.test(u.hostname)||u.pathname!=='/shop/checkout')throw Error('guest_checkout_required');
 const click=(id,label)=>{const b=document.getElementById(id);if(!visible(b)||b.disabled||norm(b.innerText)!==label)throw Error('prewarm_control_not_ready');const key='__duoPrewarm_'+op;if(window[key])throw Error('prewarm_action_already_requested');window[key]=true;b.click();return {clicked:true};};
 const set=(e,v)=>{if(!visible(e)||e.disabled)throw Error('prewarm_field_not_ready');if(e.value===v)return;Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}));};
 if(op==='deliveryReady'){const b=[...document.querySelectorAll('button')].find(e=>visible(e)&&/^I[’']d like it delivered$/.test(norm(e.innerText)));return {ready:['Fulfillment','Fulfillment-init'].includes(step)&&document.readyState==='complete'&&!!b&&Object.keys(b).some(k=>k.startsWith('__reactProps$')&&typeof b[k]?.onClick==='function')};}
 if(op==='chooseDelivery'){
  if(!['Fulfillment','Fulfillment-init'].includes(step))throw Error('fulfillment_required');
  const choices=[...document.querySelectorAll('button')].filter(e=>visible(e)&&/^I[’']d like it delivered$/.test(norm(e.innerText)));
  if(choices.length!==1)throw Error('delivery_tab_not_verified');
  choices[0].click();return {clicked:true};
 }
 if(op==='shippingContinue'){
  if(!['Fulfillment','Fulfillment-init'].includes(step))throw Error('fulfillment_required');
  const selected=document.querySelector('input[type=radio][name^="deliveryOptions-"]:checked');if(!visible(selected))throw Error('delivery_option_required');
  return click('rs-checkout-continue-button-bottom','Continue to shipping and fulfillment');
 }
 if(op==='shippingReady'){const e=[...document.querySelectorAll('input[name=firstName]')].find(visible);const hydrated=!!e&&Object.keys(e).some(k=>k.startsWith('__reactProps$')&&typeof e[k]?.onChange==='function');return {ready:['Shipping','Shipping-init'].includes(step)&&document.readyState==='complete'&&hydrated};}
 if(op==='fillShipping'||op==='verifyShipping'||op==='continueShipping'){
  if(!['Shipping','Shipping-init'].includes(step))throw Error('shipping_required');
  const fields={firstName:shipping.first_name,lastName:shipping.last_name,street:shipping.street,street2:shipping.street2||'',postalCode:shipping.zip,emailAddress:shipping.email,fullDaytimePhone:shipping.phone};
  const input=n=>[...document.querySelectorAll('input')].find(e=>e.name===n&&visible(e));
  if(op==='fillShipping'){for(const [name,value] of Object.entries(fields))set(input(name),value);return {filled:true};}
  const combo=[...document.querySelectorAll('select[name="zipLookupCityState"]')].find(visible);
  const city=input('city'),state=[...document.querySelectorAll('select[name="state"],input[name="state"]')].find(visible);
  const target=shipping.city+', '+shipping.state;
  if(combo){const option=[...combo.options].find(o=>!o.disabled&&norm(o.text)===target);if(option)set(combo,option.value);}
  else if(city&&state){set(city,shipping.city);set(state,shipping.state);}
  const normalize=(n,v)=>n==='fullDaytimePhone'?v.replace(/\D/g,''):norm(v);
  const ready=Object.entries(fields).every(([n,v])=>normalize(n,input(n)?.value||'')===normalize(n,v))&&(combo?norm(combo.options[combo.selectedIndex]?.text)===target:city?.value===shipping.city&&state?.value===shipping.state);
  if(op==='verifyShipping')return {ready};
  if(!ready)throw Error('shipping_not_verified');return click('rs-checkout-continue-button-bottom','Continue to Payment');
 }
 if(op==='fillSavedShippingCard'||op==='verifySavedShippingCard'||op==='continueSavedShippingCard'){
  if(!['Billing','Billing-init'].includes(step))throw Error('billing_required');
  const same=[...document.querySelectorAll('input[type=checkbox]')].find(e=>visible(e)&&[...e.labels].some(l=>norm(l.innerText)==='Use my shipping address.'));
  if(!same?.checked)throw Error('use_shipping_address_required');
  const prefix='checkout.billing.billingOptions.selectedBillingOptions.creditCard.cardInputs.cardInput-0.';
  const fields={cardNumber:card.number,expiration:card.expiry,securityCode:card.cvv};
  if(op==='fillSavedShippingCard'){for(const [k,v]of Object.entries(fields))set(document.getElementById(prefix+k),v);return {filled:true};}
  const ready=Object.entries(fields).every(([k,v])=>(document.getElementById(prefix+k)?.value||'').replace(/[\s/]/g,'')===v);
  if(op==='verifySavedShippingCard')return {ready};
  if(!ready)throw Error('card_not_verified');return click('rs-checkout-continue-button-bottom','Continue');
 }
 if(op==='changeShipping'){
  if(!['Review','Review-init'].includes(step))throw Error('review_required');
  return click('checkout.review.fulfillmentReview.reviewGroup-1.edit','Change shipping method');
 }
 throw Error('unknown_prewarm_operation');
}

export async function setupDOM(window,op,args={}){
 const code='JSON.stringify(('+prewarmDOM.toString()+')('+JSON.stringify({op,...args})+'))';
 const raw=await appleScript(window.script('return do JavaScript '+JSON.stringify(code)+' in tab 1 of w'));
 if(!raw&&['shippingContinue','continueShipping','continueSavedShippingCard','changeShipping','chooseDelivery'].includes(op))return {response_unknown:true};
 if(!raw){const error=Error('safari_navigation_pending');error.code='safari_navigation_pending';throw error;}
 return JSON.parse(raw);
}
export function validateSetupProfile(window,url){
 const product=expectedProduct(url);
 if(window.profile==='PickupTest18Pro'){
  if(!new URL(url).pathname.includes('/iphone-18-pro/'))throw Error('setup_profile_product_mismatch');
 }else{
  const match=window.profile.match(/^Duo(256|512|1024)(White|Black)$/);
  if(!match)throw Error('setup_profile_not_allowed');
  const expected='iPhone Duo '+(match[1]==='1024'?'1TB':match[1]+'GB')+' '+(match[2]==='White'?'Star White':'Night Sky');
  if(expected!==product)throw Error('setup_profile_product_mismatch');
 }
 return product;
}
export function prepareGuestPaymentSession(window,url,config,options={}){
 return withPreparationTimeout(()=>prepareGuestPaymentSessionImpl(window,url,{...config,step_timeout_ms:20000},options));
}
async function prepareGuestPaymentSessionImpl(window,url,config,{allowReplenish=false,stage=()=>{},shipping}={}){
 const product=validateSetupProfile(window,url);
 shipping??=JSON.parse(readFileSync(config.guest_shipping_file||resolve(homedir(),'.config/iphone-duo/guest-shipping.json'),'utf8'));
 for(const k of ['first_name','last_name','street','zip','city','state','email','phone'])if(typeof shipping[k]!=='string'||!shipping[k].trim())throw Error('guest_shipping_configuration_incomplete');
 const card=readGuestCard(); // Read only for session preparation, never in the stock critical path.
 await window.goto('https://www.apple.com/shop/bag');
 await waitFor(async()=>{const s=await runGuestDOM(window,'state');return s.path==='/shop/bag'&&s.complete;});
 let bag=await window.call('snapshot');
 if(bag.empty&&!bag.bag.length){
  if(!allowReplenish)throw Error('bag_empty_without_confirmed_order');
  await prepareSafari(window,url,{...config,standby_page:undefined},{seedOnly:true,stage});
  stage('post_order_bag_replenished_at');bag=await window.call('snapshot');
 }
 if(bag.bag.length!==1||bag.bag[0].title!==product||bag.bag[0].quantity!=='1')throw Error('bag_not_exactly_one_target');
 await waitFor(async()=>(await runGuestDOM(window,'bagReady')).ready);
 await runGuestDOM(window,'bagCheckout',{expected_product:product});stage('setup_checkout_clicked_at');
 const entry=await waitFor(async()=>{const s=await runGuestDOM(window,'state');return s.guest||s.path==='/shop/checkout'?s:null;});
 if(entry.guest){await attemptPreparationSignInCancel(window,stage);await runGuestDOM(window,'guestContinue');}
 await waitFor(async()=>['Fulfillment','Fulfillment-init'].includes((await runGuestDOM(window,'state')).step));
 await waitFor(async()=>(await setupDOM(window,'deliveryReady')).ready);
 await setupDOM(window,'chooseDelivery');
 await waitFor(async()=>{try{return await setupDOM(window,'shippingContinue');}catch(e){if(!['prewarm_control_not_ready','delivery_option_required','safari_navigation_pending'].includes(e.message))throw e;return false;}});
 await waitFor(async()=>(await setupDOM(window,'shippingReady')).ready);
 await setupDOM(window,'fillShipping',{shipping});await waitFor(async()=>(await setupDOM(window,'verifyShipping',{shipping})).ready);
 await setupDOM(window,'continueShipping',{shipping});stage('setup_shipping_verified_at');
 await waitFor(async()=>(await runGuestDOM(window,'creditReady')).ready);await runGuestDOM(window,'selectCredit');
 await waitFor(async()=>{try{return (await setupDOM(window,'fillSavedShippingCard',{card})).filled;}catch(e){if(!['prewarm_field_not_ready','use_shipping_address_required'].includes(e.message))throw e;return false;}});
 await waitFor(async()=>(await setupDOM(window,'verifySavedShippingCard',{card})).ready);
 await setupDOM(window,'continueSavedShippingCard',{card});await waitFor(async()=>(await runGuestDOM(window,'reviewState')).ready);
 stage('setup_payment_review_verified_at');await setupDOM(window,'changeShipping');
 await waitFor(async()=>['Fulfillment','Fulfillment-init'].includes((await runGuestDOM(window,'state')).step));
 await waitFor(async()=>(await window.call('pickup',{product})).ready);await waitFor(async()=>(await window.call('pickupReady',{product})).ready);
 await window.call('armPickupStandby',{product,explicit_test_reset:true});
 await prepareGuestStandby(window,url,{...config,guest_payment_prepared:true,urgent_same_configuration_retry:false},{stage});
 if((await window.call('locationState')).displayed_zip!==config.pickup_zip)throw Error('setup_pickup_zip_not_verified');
 const native=await attemptPreparationSignInCancel(window,stage,{allowPickup:true});
 stage('setup_guest_pickup_verified_at');return {status:'standby_checkout',payment_submitted:false,native_prompt_verified:native.confirmed};
}
