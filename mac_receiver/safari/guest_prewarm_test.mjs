// Isolated delivery -> saved payment -> pickup rehearsal. Never submits an order.
import {readFileSync,mkdirSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SafariWindow,listSafariWindows,appleScript,waitFor} from './shopping.mjs';
import {runGuestDOM,readGuestCard,cancelGuestSignIn,prepareGuestStandby,runGuestSignal,testURL} from './guest_checkout.mjs';
import {expectedProduct} from '../protocol.mjs';
import {testConfig} from './regression.mjs';
export function prewarmDOM({op,shipping={},card={}}){
 const visible=e=>!!e&&!!e.getClientRects().length;
 const norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const u=new URL(location.href),step=u.searchParams.get('_s');
 if(!/^secure\d*\.store\.apple\.com$/.test(u.hostname)||u.pathname!=='/shop/checkout')throw Error('guest_checkout_required');
 const click=(id,label)=>{const b=document.getElementById(id);if(!visible(b)||b.disabled||norm(b.innerText)!==label)throw Error('prewarm_control_not_ready');const key='__duoPrewarm_'+op;if(window[key])throw Error('prewarm_action_already_requested');window[key]=true;b.click();return {clicked:true};};
 const set=(e,v)=>{if(!visible(e)||e.disabled)throw Error('prewarm_field_not_ready');if(e.value===v)return;Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}));};
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
export async function runPrewarmDOM(window,op,args={}){
 if(window.profile!=='PickupTest18Pro')throw Error('isolated_test_profile_required');
 const code='JSON.stringify(('+prewarmDOM.toString()+')('+JSON.stringify({op,...args})+'))';
 const raw=await appleScript(window.script('return do JavaScript '+JSON.stringify(code)+' in tab 1 of w'));
 // Mutation responses can be lost during navigation. Never repeat a click.
 if(!raw&&['shippingContinue','continueShipping','continueSavedShippingCard','changeShipping'].includes(op))return {response_unknown:true};
 if(!raw){const e=Error('safari_navigation_pending');e.code='safari_navigation_pending';throw e;}return JSON.parse(raw);
}
export async function prewarmTest(window,config,shipping,stage=()=>{}){
 if(window.profile!=='PickupTest18Pro')throw Error('isolated_test_profile_required');
 const product=expectedProduct(testURL),card=readGuestCard();
 await waitFor(async()=>(await runGuestDOM(window,'state')).path==='/shop/bag');
 await waitFor(async()=>(await runGuestDOM(window,'bagReady')).ready);
 await runGuestDOM(window,'bagCheckout',{expected_product:product});stage('bag_checkout_clicked');
 await waitFor(async()=>(await runGuestDOM(window,'state')).guest);await cancelGuestSignIn(window,stage);
 await runGuestDOM(window,'guestContinue');stage('guest_clicked');
 await waitFor(async()=>['Fulfillment','Fulfillment-init'].includes((await runGuestDOM(window,'state')).step));
 await runPrewarmDOM(window,'shippingContinue');
 await waitFor(async()=>['Shipping','Shipping-init'].includes((await runGuestDOM(window,'state')).step));
 await waitFor(async()=>(await runPrewarmDOM(window,'shippingReady')).ready);
 await runPrewarmDOM(window,'fillShipping',{shipping});
 await waitFor(async()=>(await runPrewarmDOM(window,'verifyShipping',{shipping})).ready);
 await runPrewarmDOM(window,'continueShipping',{shipping});stage('shipping_verified_and_continued');
 await waitFor(async()=>(await runGuestDOM(window,'creditReady')).ready);await runGuestDOM(window,'selectCredit');
 await waitFor(async()=>{try{return (await runPrewarmDOM(window,'fillSavedShippingCard',{card})).filled;}catch(e){if(!e.message.includes('prewarm_field_not_ready')&&!e.message.includes('use_shipping_address_required'))throw e;return false;}});
 await waitFor(async()=>(await runPrewarmDOM(window,'verifySavedShippingCard',{card})).ready);
 await runPrewarmDOM(window,'continueSavedShippingCard',{card});
 await waitFor(async()=>(await runGuestDOM(window,'reviewState')).ready);stage('delivery_review_ready_no_order');
 await runPrewarmDOM(window,'changeShipping');
 await waitFor(async()=>['Fulfillment','Fulfillment-init'].includes((await runGuestDOM(window,'state')).step));
 await waitFor(async()=>(await window.call('pickup',{product})).ready);await waitFor(async()=>(await window.call('pickupReady',{product})).ready);
 await window.call('armPickupStandby',{product,explicit_test_reset:true});
 await prepareGuestStandby(window,testURL,{...config,guest_payment_prepared:true});
 const location=await window.call('locationState');if(location.displayed_zip!=='07094')throw Error('prewarm_pickup_zip_not_verified');
 stage('prepared_guest_pickup_07094');
 return runGuestSignal(window,testURL,{...config,guest_payment_prepared:true},shipping,stage,{mode:'test'});
}
async function main(){
 const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
 if(!args.includes('--config')||!args.includes('--shipping'))throw Error('usage_--config_FILE_--shipping_PRIVATE_FILE');
 const shipping=JSON.parse(readFileSync(resolve(arg('--shipping'))));
 for(const k of ['first_name','last_name','street','zip','city','state','email','phone'])if(typeof shipping[k]!=='string'||!shipping[k].trim())throw Error('shipping_configuration_incomplete');
 const windows=(await listSafariWindows()).filter(w=>w.name.startsWith('PickupTest18Pro — '));
 if(windows.length!==1||windows[0].tabs!==1)throw Error('one_isolated_test_window_required');
 const config=testConfig(JSON.parse(readFileSync(resolve(arg('--config')))),'PickupTest18Pro',testURL);
 const dir=resolve('runtime/safari-regression');mkdirSync(dir,{recursive:true,mode:0o700});
 const lock=resolve(dir,'PickupTest18Pro.lock');closeSync(openSync(lock,'wx',0o600));
 const report={at:new Date().toISOString(),payment_submitted:false,stages:[]},file=resolve(dir,Date.now()+'-prewarm.json');
 try{report.result=await prewarmTest(new SafariWindow(windows[0].id,'PickupTest18Pro'),config,shipping,name=>{report.stages.push({name,at:new Date().toISOString()});console.log(name);});report.status=report.result.status;}
 catch(e){report.status='failed';report.error=e.code||/^[a-z_]+$/.test(e.message)&&e.message||'prewarm_error';process.exitCode=1;}
 finally{writeFileSync(file,JSON.stringify(report,null,2),{mode:0o600});unlinkSync(lock);}
 console.log(JSON.stringify({status:report.status,report:file,to_review_from_refresh_ms:report.result?.to_review_from_refresh_ms,payment_submitted:false,error:report.error}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
