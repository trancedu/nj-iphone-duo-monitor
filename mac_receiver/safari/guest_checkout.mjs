// Guest credit checkout experiment. CLI is test-only: Continue to review is
// allowed, but Place Your Order is available only to the explicit production API.
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SafariWindow,listSafariWindows,appleScript,prepareSafariStandby,prepareSafari,waitFor} from './shopping.mjs';
import {testConfig} from './regression.mjs';
import {expectedProduct} from '../protocol.mjs';
import {safariDOM} from './dom.mjs';
import {pickupDetailsFromEnv} from '../pickup_details.mjs';
export const testURL='https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked';
export const sampleBilling={first_name:'Test',last_name:'Example',street:'1 Example Street',street2:'',zip:'07094',city:'Secaucus',state:'NJ'};
export function decodeGuestCVV(value,encoding){
 if(!encoding||encoding==='plain')return value;
 const bases={mixed:989,subtract_1003:1003,subtract_989:989};
 if(!Object.hasOwn(bases,encoding))throw Error('unknown_guest_cvv_encoding');
 if(typeof value!=='string'||! /^-?\d{1,4}$/.test(value))throw Error('invalid_guest_cvv_encoding');
 const decoded=bases[encoding]-Number(value);
 if(!Number.isInteger(decoded)||decoded<0||decoded>999)throw Error('invalid_guest_cvv_encoding');
 return String(decoded).padStart(3,'0');
}
export function readGuestCard(env=process.env){
 if(env.APPLE_GUEST_CARD_SOURCE==='keychain'){
  const helper=env.APPLE_GUEST_KEYCHAIN_HELPER||resolve(homedir(),'.config/iphone-duo/card-keychain');
  const result=spawnSync(helper,['read'],{encoding:'utf8',timeout:5000,maxBuffer:4096});
  if(result.error||result.status!==0)throw Error('guest_card_keychain_unavailable');
  let card;try{card=JSON.parse(result.stdout);}catch{throw Error('guest_card_keychain_invalid');}
  return readGuestCard({APPLE_GUEST_CARD_NUMBER:card.number,APPLE_GUEST_CARD_EXPIRY:card.expiry,APPLE_GUEST_CARD_CVV:card.cvv,APPLE_GUEST_CVV_MODE:env.APPLE_GUEST_CVV_MODE});
 }
 if(env.APPLE_GUEST_CARD_SOURCE&&env.APPLE_GUEST_CARD_SOURCE!=='environment')throw Error('unknown_guest_card_source');
 const supplied=['APPLE_GUEST_CARD_NUMBER','APPLE_GUEST_CARD_EXPIRY','APPLE_GUEST_CARD_CVV'].map(k=>env[k]);
 if(supplied.every(v=>v===undefined))return {number:'0000000000000000',expiry:'1230',cvv:'000'};
 if(supplied.some(v=>typeof v!=='string'||!v.trim()))throw Error('incomplete_guest_card_environment');
 const [number,expiry,cvv]=[supplied[0].replace(/[ -]/g,''),supplied[1].replace('/',''),decodeGuestCVV(supplied[2],env.APPLE_GUEST_CVV_MODE)];
 if(!/^\d{13,19}$/.test(number)||!/^\d{4}$/.test(expiry)||+expiry.slice(0,2)<1||+expiry.slice(0,2)>12||!/^\d{3,4}$/.test(cvv))throw Error('invalid_guest_card_environment');
 return {number,expiry,cvv};
}
export function guestCheckoutDOM({op,billing={},card={number:'0000000000000000',expiry:'1230',cvv:'000'},mode='test',expected_product='',expected_store='',max_total_usd=0,contact=null,event_id='',submission_expected=false}){
 const visible=e=>!!e&&!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const u=new URL(location.href),step=u.searchParams.get('_s');
 if(u.protocol!=='https:'||!(u.hostname==='www.apple.com'||/^secure\d*\.store\.apple\.com$/.test(u.hostname)))throw Error('unexpected_guest_host');
 const button=(id,text)=>{const e=document.getElementById(id);if(!visible(e)||e.disabled||norm(e.innerText)!==text)throw Error('guest_control_not_ready');return e;};
 if(op==='state')return {path:u.pathname,step,document_time_origin:performance.timeOrigin,complete:document.readyState==='complete',guest:visible(document.getElementById('signIn.guestLogin.guestLogin'))&&typeof document.getElementById('signIn.guestLogin.guestLogin').onclick==='function'};
 if(op==='bagReady'){
  const b=document.getElementById('shoppingCart.actions.checkoutOtherPayments');
  return {ready:u.pathname==='/shop/bag'&&document.readyState==='complete'&&visible(b)&&!b.disabled&&typeof b.onclick==='function'&&performance.now()>=750,origin:performance.timeOrigin};
 }
 if(op==='bagCheckout'){
  if(u.hostname!=='www.apple.com'||u.pathname!=='/shop/bag')throw Error('test_bag_required');
  const items=[...document.querySelectorAll('[role=listitem][data-autom^="bag-item-"]')];
  if(items.length!==1||!expected_product||norm(items[0].querySelector('h2,h3')?.textContent)!==expected_product||items[0].querySelector('select')?.value!=='1')throw Error('one_test_iphone_required');
  const b=button('shoppingCart.actions.checkoutOtherPayments','Check Out');
  if(window.__duoGuestCheckoutRequested)throw Error('guest_checkout_already_requested');
  window.__duoGuestCheckoutRequested=true;b.click();return {clicked:true};
 }
 if(op==='guestContinue'){
  if(u.pathname!=='/shop/signIn')throw Error('guest_signin_page_required');
  const b=button('signIn.guestLogin.guestLogin','Continue as Guest');
  if(window.__duoGuestContinueRequested)throw Error('guest_continue_already_requested');
  window.__duoGuestContinueRequested=true;b.click();return {clicked:true};
 }
 if(op==='guestOrderState'||op==='recoverGuestOrderFailure'||op==='retireGuestOrderSuccess'){
  const key='duo_guest_order_requested_v1';let record=null;try{record=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
  const owned=!!record&&record.event_id===event_id&&record.product===expected_product;
  const headers=[...document.querySelectorAll('h1,h2')].filter(visible).map(e=>norm(e.textContent)).join(' ');
  const success=/thank you for your order|order confirmation|your order (?:has been|is) (?:placed|confirmed)/i.test(headers)&&!!expected_product&&norm(document.body.innerText).includes(expected_product)&&(owned||submission_expected);
  const errors=[...document.querySelectorAll('[role="alert"],.rs-error,.form-message-wrapper,.form-message')].filter(visible).map(e=>norm(e.textContent)).join(' ');
  const failed=u.pathname==='/shop/checkout'&&(owned||submission_expected)&&!success&&/payment (?:was |has been )?(?:declined|failed|not authorized)|unable to (?:process|complete|authorize) (?:your |the )?payment|(?:item|product|pickup|pick.up time).{0,80}(?:no longer available|unavailable)|(?:could not|couldn[’']t|unable to) place (?:your |the )?order/i.test(errors);
  const recoverable=failed&&u.pathname==='/shop/checkout'&&['Review','Review-init','Billing','Billing-init','PickupContact','PickupContact-init','Fulfillment','Fulfillment-init'].includes(step);
  const observation={observed:owned||submission_expected,requested_at:owned?record.at:null,phase:success?'guest_order_confirmed':failed?'guest_order_failed':'guest_order_pending',outcome:success?'success':failed?'failed':'unknown',closed:failed||success,recoverable};
  if(op==='guestOrderState')return observation;
  if(op==='retireGuestOrderSuccess'){if(!success)throw Error('order_success_not_confirmed');sessionStorage.removeItem(key);return {retired:true};}
  if(!recoverable)return {recovered:false,...observation};
  const retiredKey='duo_guest_failed_events_v1';let retired=[];try{retired=JSON.parse(sessionStorage.getItem(retiredKey)||'[]');}catch{}
  retired.push(event_id);sessionStorage.setItem(retiredKey,JSON.stringify(retired.slice(-100)));
  sessionStorage.removeItem(key);
  u.searchParams.set('_s','Fulfillment-init');location.assign(u.href);return {recovered:true};
 }
 if(u.pathname!=='/shop/checkout'||!/^secure\d*\.store\.apple\.com$/.test(u.hostname))throw Error('guest_checkout_path_required');
 if(op==='contactReady'||op==='continuePayment'){
  if(!['PickupContact','PickupContact-init'].includes(step))return {ready:false};
  const e=document.getElementById('rs-checkout-continue-button-bottom');
  const ready=visible(e)&&!e.disabled&&['Continue to Payment','Continue'].includes(norm(e.innerText))&&[...document.querySelectorAll('h1,h2')].some(h=>norm(h.textContent)==='Now fill out your pickup information.')&&['firstName','lastName','emailAddress','fullDaytimePhone'].every(name=>[...document.querySelectorAll('input')].some(i=>i.name===name&&visible(i)));
  if(op==='contactReady')return {ready};
  if(!ready)throw Error('guest_contact_not_ready');
  if(window.__duoGuestPaymentContinue)throw Error('guest_payment_continue_already_requested');
  window.__duoGuestPaymentContinue=true;e.click();return {clicked:true};
 }
 if(op==='restoreGuestBeforeSubmit'){
  if(!expected_product||!norm(document.body.innerText).includes(expected_product))throw Error('guest_restore_product_not_verified');
  if(sessionStorage.getItem('duo_guest_order_requested_v1'))throw Error('guest_submission_must_be_reconciled');
  if(!['Fulfillment','Fulfillment-init','PickupContact','PickupContact-init','Billing','Billing-init','Review','Review-init'].includes(step))throw Error('guest_restore_step_unknown');
  if(['Fulfillment','Fulfillment-init'].includes(step)){window.__duoPickupStoreSelected=false;window.__duoPickupContinueRequested=false;window.__duoPickupAttemptAbandoned=false;return {restored:true,navigating:false};}
  u.searchParams.set('_s','Fulfillment-init');location.assign(u.href);return {restored:true,navigating:true};
 }
 const orderButtons=()=>[...document.querySelectorAll('button,input[type="submit"]')].filter(e=>visible(e)&&e.id==='rs-checkout-continue-button-bottom'&&e.getAttribute('data-autom')==='continue-button-placeOrder'&&/^Place (?:Your )?Order$/i.test(norm(e.innerText||e.value)));
 if(op==='reviewState'||op==='preparedReviewState'||op==='editPickupContact'||op==='editSavedBilling'||op==='placeOrder'){
  const buttons=orderButtons();
  const review=['Review','Review-init'].includes(step)&&[...document.querySelectorAll('h1,h2')].some(e=>visible(e)&&/review|ready to (?:place your )?order/i.test(norm(e.textContent)));
  const ready=review&&buttons.length===1&&!buttons[0].disabled;
  if(op==='reviewState')return {ready,step,place_order_button_visible:buttons.length===1,payment_submitted:false};
  if(op==='preparedReviewState'){
   const items=[...document.querySelectorAll('[data-autom]')].filter(e=>/^bag-item-\d+$/.test(e.getAttribute('data-autom'))&&visible(e));
   const item=items.length===1?items[0]:null;
   const quantities=item?[...item.querySelectorAll('.rs-quantity-text > span:not(.visuallyhidden)')].filter(visible):[];
   const payment=document.querySelector('.rs-review-billing-details')||document.querySelector('.rs-review-billing');
   const paymentText=norm(payment?.innerText);
   const store=norm(expected_store).split(/Available (?:Today|Tomorrow)|Available for pickup|Currently unavailable|Unavailable for pickup|Not available|In-Store Pickup/i)[0].replace(/\s*\d+(?:\.\d+)?\s*(?:mi|km)\s*$/i,'').trim();
   const checks={review_ready:ready,product_matches:!!expected_product&&norm(item?.querySelector('h2,h3')?.textContent)===expected_product,quantity_one:quantities.length===1&&norm(quantities[0].innerText)==='1',pickup_store_matches:!!store&&norm(document.body.innerText).includes(store),payment_summary_present:visible(payment)&&/ending|[•●*]{2,}|visa|mastercard|amex|american express|discover|unionpay|apple card/i.test(paymentText)};
   if(contact){
    const change=document.querySelector('[data-autom="pickup-changeLink"]');
    const summary=norm(change?.closest('.row.rs-review-details')?.innerText);
    checks.pickup_contact_name_matches=!!summary&&summary.includes(contact.first_name)&&summary.includes(contact.last_name);
   }
   return {ready:Object.values(checks).every(Boolean),step,checks,payment_submitted:false};
  }
  if(op==='editPickupContact'){
   if(!ready)throw Error('order_review_not_verified');
   const e=button('checkout.review.pickupContactReview.edit','Change');
   if(window.__duoGuestEditContactRequested)throw Error('pickup_contact_edit_already_requested');
   window.__duoGuestEditContactRequested=true;e.click();return {clicked:true};
  }
  if(op==='editSavedBilling'){
   if(!ready)throw Error('order_review_not_verified');
   const e=button('checkout.review.billingReview.edit','Change');
   if(window.__duoGuestEditBillingRequested)throw Error('saved_billing_edit_already_requested');
   window.__duoGuestEditBillingRequested=true;e.click();return {clicked:true};
  }
  if(mode!=='production')throw Error('place_order_forbidden_in_test');
  if(!ready)throw Error('order_review_not_verified');
  if(!expected_product||!norm(document.body.innerText).includes(expected_product))throw Error('review_product_not_verified');
  // Exact total/quantity evidence is required; do not infer these from a price
  // elsewhere on the page. Selectors must be verified for the deployed layout.
  const totals=[...document.querySelectorAll('[data-autom="bagtotalvalue"]')].filter(visible);
  const items=[...document.querySelectorAll('[data-autom]')].filter(e=>/^bag-item-\d+$/.test(e.getAttribute('data-autom'))&&visible(e));
  if(items.length!==1||norm(items[0].querySelector('h2,h3')?.textContent)!==expected_product)throw Error('review_product_not_verified');
  const quantities=items.length===1?[...items[0].querySelectorAll('.rs-quantity-text > span:not(.visuallyhidden)')].filter(visible):[];
  const total=totals.length===1?Number(norm(totals[0].innerText).replace(/[$,]/g,'')):NaN;
  if(!Number.isFinite(max_total_usd)||max_total_usd<=0||!Number.isFinite(total)||total<=0||total>max_total_usd||quantities.length!==1||!/^1$/.test(norm(quantities[0].innerText)))throw Error('order_amount_or_quantity_not_verified');
  const key='duo_guest_order_requested_v1';
  if(!event_id)throw Error('guest_order_event_required');
  let retired=[];try{retired=JSON.parse(sessionStorage.getItem('duo_guest_failed_events_v1')||'[]');}catch{}
  if(retired.includes(event_id))throw Error('guest_order_event_retired');
  if(sessionStorage.getItem(key))throw Error('guest_order_already_requested');
  // Mark before invoking: an uncertain reply is never permission to retry.
  sessionStorage.setItem(key,JSON.stringify({at:new Date().toISOString(),product:expected_product,event_id}));
  buttons[0].click();return {order_requested:true,order_confirmed:false};
 }
 if(op==='billingOutcome'){
  if(!['Billing','Billing-init'].includes(step))return {status:'navigating',step};
  const errors=[...document.querySelectorAll('[role="alert"],.form-message-wrapper,.form-message')].filter(visible).map(e=>norm(e.textContent)).filter(Boolean);
  return {status:errors.length?'validation_error':'waiting',step,validation_error_count:errors.length};
 }
 if(!['Billing','Billing-init'].includes(step))throw Error('guest_billing_page_required');
 if(op==='creditReady'){
  const e=document.getElementById('checkout.billing.billingoptions.credit');
  // Apple renders SSR controls before React attaches their handlers. Clicking
  // then can briefly check a radio which hydration silently resets.
  const hydrated=!!e&&Object.keys(e).some(k=>k.startsWith('__reactProps$')&&typeof e[k]?.onChange==='function');
  return {ready:visible(e)&&!e.disabled&&hydrated};
 }
 if(op==='selectCredit'){
  const e=document.getElementById('checkout.billing.billingoptions.credit');
  if(!visible(e)||e.disabled)throw Error('credit_option_not_ready');
  if(!e.checked)e.click();return {selected:e.checked};
 }
 const prefix='checkout.billing.billingOptions.selectedBillingOptions.creditCard.';
 const field=s=>document.getElementById(prefix+s);
 const set=(e,value)=>{
  if(!visible(e)||e.disabled)throw Error('billing_field_not_ready');
  if(e.value===value&&!/cardInputs\.cardInput-0\.(?:cardNumber|expiration|securityCode)$/.test(e.id))return;
  const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
  e.focus();
  if(/cardInputs\.cardInput-0\.(?:cardNumber|expiration|securityCode)$/.test(e.id)){
   Object.getOwnPropertyDescriptor(proto,'value').set.call(e,'');
   e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);
  e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();
 };
 const fields=[['cardInputs.cardInput-0.cardNumber',card.number],['cardInputs.cardInput-0.expiration',card.expiry],['cardInputs.cardInput-0.securityCode',card.cvv],['billingAddress.address.firstName',billing.first_name],['billingAddress.address.lastName',billing.last_name],['billingAddress.address.street',billing.street],['billingAddress.address.street2',billing.street2||''],['billingAddress.address.zipLookup.postalCode',billing.zip]];
 const normalize=s=>(s||'').replace(/[\s/]/g,'');
 const separate=()=>({city:[...document.querySelectorAll('input[name="city"],input[id$=".city"]')].find(visible),state:[...document.querySelectorAll('input[name="state"],select[name="state"],input[id$=".state"],select[id$=".state"]')].find(visible)});
 const combined=()=>field('billingAddress.address.zipLookup.zipLookupCityState');
 const matchingOption=e=>[...e.options].find(o=>!o.disabled&&norm(o.label).toLowerCase()===`${billing.city}, ${billing.state}`.toLowerCase());
 if(op==='billingTick'){
  const settled=guestCheckoutDOM({op:'settleCityState',billing,card});
  const verified=guestCheckoutDOM({op:'verifyBilling',billing,card});
  return {...verified,ready:settled.ready&&verified.ready};
 }
 if(op==='billingReady')return {ready:fields.every(([s])=>visible(field(s)))};
 if(op==='fillBilling'){
  const start=performance.now();
  if(fields.some(([s,v])=>typeof v!=='string'||!visible(field(s))))throw Error('billing_fields_missing');
  for(const [s,v] of fields)set(field(s),v);
  return {filled:true,dom_ms:performance.now()-start};
 }
 if(op==='settleCityState'){
  const {city,state}=separate();
  if(city&&state){
   set(city,billing.city);
   if(state.tagName==='SELECT'){
    const o=[...state.options].find(o=>!o.disabled&&(o.value===billing.state||norm(o.label)===billing.state||(billing.state==='NJ'&&norm(o.label)==='New Jersey')));
    if(!o)return {ready:false,layout:'separate'};set(state,o.value);
   }else set(state,billing.state);
   return {ready:city.value===billing.city&&state.value===billing.state,layout:'separate'};
  }
  const combo=combined();
  if(!visible(combo)||combo.tagName!=='SELECT')return {ready:false,layout:'loading'};
  const option=matchingOption(combo);if(!option)return {ready:false,layout:'combined_pending'};
  set(combo,option.value);return {ready:combo.value===option.value,layout:'combined'};
 }
 if(op==='verifyBilling'||op==='continueBilling'){
  const checks=fields.map(([s,v])=>({field:s,matched:normalize(field(s)?.value)===normalize(v)}));
  const {city,state}=separate(),combo=combined();
  const locationReady=city&&state?city.value===billing.city&&state.value===billing.state:visible(combo)&&combo.tagName==='SELECT'&&!!matchingOption(combo)&&combo.value===matchingOption(combo).value;
  const country=field('billingAddress.address.countryCode');
  const countryReady=!!country&&/^(United States|US)$/.test(norm(country.value));
  const verification={ready:checks.every(c=>c.matched)&&!!locationReady&&countryReady,checks,city_state_verified:!!locationReady,country_verified:countryReady,layout:city&&state?'separate':'combined',payment_submitted:false};
  if(op==='verifyBilling')return verification;
  if(!verification.ready)throw Error('billing_not_verified_before_continue');
  const b=button('rs-checkout-continue-button-bottom','Continue');
  if(window.__duoGuestBillingContinue)throw Error('billing_continue_already_requested');
  window.__duoGuestBillingContinue=true;b.click();return {continue_requested:true,payment_submitted:false};
 }
 throw Error('unsupported_guest_operation');
}
export async function runGuestDOM(window,op,args={}){
 const code='JSON.stringify(('+guestCheckoutDOM.toString()+')('+JSON.stringify({op,...args})+'))';
 const metricStart=performance.now();
 let raw;
 try{raw=await appleScript(window.script('return do JavaScript '+JSON.stringify(code)+' in tab 1 of w'));}
 finally{window.onMetric?.({op:'guest_'+op,bridge_ms:performance.now()-metricStart});}
 // Navigation may destroy the script reply after a successful click. Do not
 // repeat mutations; reconcile the destination instead. Read-only polls retry.
 if(!raw){
  if(['bagCheckout','guestContinue','continuePayment','selectCredit','continueBilling','editPickupContact','editSavedBilling','placeOrder','recoverGuestOrderFailure','restoreGuestBeforeSubmit'].includes(op))return {response_unknown:true};
  const error=Error('safari_script_response_unrecognized');error.code='safari_script_response_unrecognized';throw error;
 }
 const result=JSON.parse(raw);
 if(op==='state')window.onGuestState?.({path:result.path,state:result.step});
 return result;
}
// Native prompts can be hidden in another full-screen Space. Select the exact
// Safari Window-menu entry before inspecting attached sheets or root dialogs.
export function guestAccountPromptScript(profile,{cancel=false,selectWindow=false}={}){
 if(profile!=='PickupTest18Pro'&&!/^Duo(?:256|512|1024)(?:White|Black)$/.test(profile))throw Error('isolated_guest_profile_required');
 const quoted=JSON.stringify(profile+' — ');
 return `${selectWindow?'tell application "Safari" to activate\n':''}tell application "System Events"
 tell process "Safari"
  ${selectWindow?`click menu bar item "Window" of menu bar 1
  set targets to menu items of menu 1 of menu bar item "Window" of menu bar 1 whose name starts with ${quoted}
  if (count of targets) is not 1 then return "target_window_not_visible"
  click item 1 of targets
  delay 0.15`:''}
  set candidates to {}
  set targetVisible to false
  repeat with w in windows
   try
    if name of w starts with ${quoted} then
     set targetVisible to true
     repeat with s in sheets of w
      set end of candidates to contents of s
     end repeat
    end if
    if (subrole of w as text) is "AXDialog" or (role of w as text) is "AXSheet" then
     set sharingControl to false
     repeat with b in buttons of w
      try
       if name of b is "WindowSharingSessionButton" then set sharingControl to true
      end try
     end repeat
     if not sharingControl then set end of candidates to contents of w
    end if
   end try
  end repeat
  set matchedControls to {}
  set unknownDialog to false
  repeat with s in candidates
   set isAccountPrompt to false
   set hasDifferentAccount to false
   set cancelControl to missing value
   set elementsToInspect to entire contents of s
   repeat with e in elementsToInspect
    try
     set elementRole to role of e as text
     if elementRole is "AXStaticText" then
      set v to value of e as text
      if v contains "store.apple.com" and v contains "Account" and v contains "Sign in" then set isAccountPrompt to true
     end if
     if elementRole is "AXButton" then
      if name of e is "Cancel" then set cancelControl to e
      if name of e contains "different" and name of e contains "Account" then set hasDifferentAccount to true
     end if
    end try
   end repeat
   if isAccountPrompt and hasDifferentAccount and cancelControl is not missing value then
    set end of matchedControls to contents of cancelControl
   else
    set unknownDialog to true
   end if
  end repeat
  if (count of matchedControls) is 1 then
   ${cancel?'click item 1 of matchedControls\n   return "cancelled"':'return "present"'}
  end if
  if (count of matchedControls) > 1 or unknownDialog then return "unknown_sheet"
  if not targetVisible then return "target_window_not_visible"
  return "absent"
 end tell
end tell`;
}
export async function cancelGuestSignIn(window,stage=()=>{},options={}){
 const now=options.now||Date.now,pause=options.pause||(ms=>new Promise(r=>setTimeout(r,ms)));
 let needsWindowSelection=true;
 const probe=options.probe||(async cancel=>{
  // Validate the bound Safari window and route before touching native UI.
  const state=await runGuestDOM(window,'state');
  if(state.path!=='/shop/signIn'&&!(options.allowPickup&&state.path==='/shop/checkout'&&['Fulfillment','Fulfillment-init'].includes(state.step)))throw Error('native_cancel_requires_guest_signin');
  const selectWindow=!cancel&&needsWindowSelection;
  const status=await appleScript(guestAccountPromptScript(window.profile,{cancel,selectWindow}));
  if(selectWindow)needsWindowSelection=false;
  if(cancel&&status==='cancelled')needsWindowSelection=true;
  return status;
 });
 const started=now();let cancelled=false;
 while(now()-started<6000){
  const status=await probe(false);
  if(status==='unknown_sheet'||status==='target_window_not_visible'){
   // A new native sheet may precede its text/buttons. Wait without clicking.
   if(now()-started>=(status==='target_window_not_visible'?4000:2000))throw Error(status==='target_window_not_visible'?'guest_target_window_not_visible':'unknown_guest_sheet_requires_manual_review');
   await pause(200);continue;
  }
  if(status==='present'){
   if(cancelled)throw Error('guest_account_prompt_reappeared');
   if(await probe(true)!=='cancelled')throw Error('guest_account_cancel_unconfirmed');
   cancelled=true;stage('apple_account_cancel_clicked');
  }else if(status==='absent'){
   if(cancelled){stage('apple_account_prompt_closed');return {status:'cancelled_and_closed'};}
   // Allow the optional native prompt to appear after the guest page renders.
   if(now()-started>=2000){stage('apple_account_prompt_not_present');return {status:'not_present'};}
  }else throw Error('guest_account_prompt_state_unknown');
  await pause(200);
 }
 throw Error('guest_account_prompt_did_not_close');
}
export function guestAdapter(window,{preparedPayment=false}={}){
 return new Proxy(window,{get(target,key){
  if(key==='call')return async(op,args)=>{
   if(['checkout','add','requestApplePay'].includes(op))throw Error('guest_forbidden_action_'+op);
   if(op==='prepareContact'){
    if(preparedPayment){const s=await runGuestDOM(target,'state');if(['Review','Review-init'].includes(s.step))return {ready:true,filled:false,contact_reused:true};}
    // One Apple Event: wait for contact controls, fill through the shared DOM
    // implementation, and verify Guest's own final button in the same document.
    const code=`JSON.stringify((()=>{const guest=${guestCheckoutDOM.toString()};const shared=${safariDOM.toString()};if(!guest({op:'contactReady'}).ready)return {ready:false};const filled=shared(${JSON.stringify({op:'fillContact',args})});return {...filled,ready:filled.filled&&guest({op:'contactReady'}).ready};})())`;
    const raw=await appleScript(target.script('return do JavaScript '+JSON.stringify(code)+' in tab 1 of w'));
    if(!raw)return {ready:false};
    return JSON.parse(raw);
   }
   return target.call(op,op==='continuePickup'?{...args,guest_checkout:true}:args);
  };
  if(key==='goto')return ()=>{throw Error('guest_unexpected_checkout_rebuild');};
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }});
}
export async function prepareGuest(window,url,config,stage=()=>{}){
 const product=expectedProduct(url),start=performance.now();
 const before=await waitFor(()=>runGuestDOM(window,'state'));
 const alreadyBag=before.path==='/shop/bag'&&before.complete;
 if(!alreadyBag)await window.goto('https://www.apple.com/shop/bag');
 await waitFor(async()=>{const s=await runGuestDOM(window,'state');return s.path==='/shop/bag'&&s.complete&&(alreadyBag||s.document_time_origin!==before.document_time_origin);});
 let stableOrigin=null,stableReads=0;
 await waitFor(async()=>{const state=await runGuestDOM(window,'bagReady');if(!state.ready){stableReads=0;return false;}if(stableOrigin!==state.origin){stableOrigin=state.origin;stableReads=0;}return ++stableReads>=2;},20000,200);
 const clicked=await runGuestDOM(window,'bagCheckout',{expected_product:product});stage('ordinary_checkout_clicked',clicked);
 const next=await waitFor(async()=>{const s=await runGuestDOM(window,'state');return s.guest||s.path==='/shop/checkout'?s:null;});
 if(next.guest){await cancelGuestSignIn(window,stage);await runGuestDOM(window,'guestContinue');stage('guest_continue_clicked');}
 await waitFor(async()=>{const s=await runGuestDOM(window,'state');return s.path==='/shop/checkout'&&s.step==='Fulfillment-init';});
 await waitFor(async()=>(await window.call('pickup',{product})).ready);
 await waitFor(async()=>(await window.call('pickupReady',{product})).ready);
 await window.call('armPickupStandby',{product,explicit_test_reset:true});
 await prepareSafariStandby(guestAdapter(window),url,config);
 const location=await window.call('locationState');if(location.displayed_zip!=='07094')throw Error('guest_standby_zip_not_verified');
 stage('guest_pickup_standby_ready');return {elapsed_ms:performance.now()-start,zip:'07094',checkout:'guest'};
}
export async function prepareGuestStandby(window,url,config,options={}){
 const state=await runGuestDOM(window,'state');
 if(config.guest_payment_prepared===true){
  if(state.path!=='/shop/checkout'||!['Fulfillment','Fulfillment-init'].includes(state.step))throw Error('prepared_guest_session_requires_manual_setup');
  const standby=await window.call('standbyState',{product:expectedProduct(url)});
  if(standby.expired)throw Error('prepared_guest_session_expired_manual_setup');
 }
 if(state.path==='/shop/checkout'&&['Fulfillment','Fulfillment-init'].includes(state.step))return prepareSafariStandby(guestAdapter(window),url,config,options);
 if(state.path==='/shop/checkout'&&['PickupContact','PickupContact-init','Billing','Billing-init','Review','Review-init'].includes(state.step))throw Error('guest_checkout_protected');
 if(options.activeRequest||options.refresh)throw Error('guest_standby_not_ready');
 const result=await prepareGuest(window,url,config,options.stage);
 return {status:'standby_checkout',product:expectedProduct(url),zip:result.zip,checkout:'guest_credit'};
}
export async function runGuestSignal(window,url,config,billing,stage=()=>{},{mode='test',max_total_usd=0,shouldYieldToRecent,mayForeground}={}){
 if(!['test','production'].includes(mode))throw Error('invalid_guest_payment_mode');
 if(mode==='production'&&(/^PickupTest/.test(window.profile)||!Number.isFinite(max_total_usd)||max_total_usd<=0))throw Error('production_guest_budget_and_profile_required');
 config={...config,pickup_details:pickupDetailsFromEnv(config.pickup_details)};
 const start=performance.now(),card=config.guest_payment_prepared===true?null:readGuestCard();
 const s=await waitFor(()=>runGuestDOM(window,'state'));if(s.path!=='/shop/checkout'||!['Fulfillment','Fulfillment-init'].includes(s.step))throw Error('guest_pickup_start_required');
 const timings={};
 const mark=(n,detail)=>{timings[n]=Math.round(performance.now()-start);stage(n,detail);};
 const result=await prepareSafari(guestAdapter(window,{preparedPayment:config.guest_payment_prepared===true}),url,{...config,open_apple_pay_sheet:false},{stage:mark,shouldYieldToRecent,mayForeground});
 if(result.status!=='awaiting_user')return {status:result.status,timings,payment_submitted:false};
 const alreadyReview=config.guest_payment_prepared===true&&['Review','Review-init'].includes((await runGuestDOM(window,'state')).step);
 if(alreadyReview){
  // Review exposes the pickup name but may hide email/phone. Re-open contacts
  // to verify all four fields without touching the saved payment details.
  await waitFor(async()=>(await runGuestDOM(window,'reviewState')).ready,config.step_timeout_ms);
  await runGuestDOM(window,'editPickupContact');mark('pickup_contact_edit_requested');
  await waitFor(async()=>(await runGuestDOM(window,'contactReady')).ready,config.step_timeout_ms);
 }
 await window.call('fillContact',{product:expectedProduct(url),contact:config.pickup_details});
 mark('pickup_contact_final_verified');
 await runGuestDOM(window,'continuePayment');mark('continue_to_payment_clicked');
 const destination=await waitFor(async()=>{const state=await runGuestDOM(window,'state');return state.path==='/shop/checkout'&&['Billing','Billing-init','Review','Review-init'].includes(state.step)?state:null;},Math.min(config.step_timeout_ms||20000,10000));
 if(config.guest_payment_prepared===true){
  if(['Billing','Billing-init'].includes(destination.step))throw Error('prepared_payment_missing_manual_review');
  let lastVerification,verification;
  let lastCheckSignature='';
  try{verification=await waitFor(async()=>{const state=await runGuestDOM(window,'preparedReviewState',{expected_product:expectedProduct(url),expected_store:result.store,contact:config.pickup_details});lastVerification=state;if(['Fulfillment','Fulfillment-init'].includes(state.step))throw Error('guest_returned_to_pickup_before_submit');const signature=JSON.stringify(state.checks);if(signature!==lastCheckSignature){lastCheckSignature=signature;mark('prepared_payment_review_check_at',{kind:'guest_review',ready:state.ready,checks:state.checks});}return state.ready?state:false;},Math.min(config.step_timeout_ms||20000,10000));}
  catch(error){mark('prepared_payment_review_failed_at',{kind:'guest_review',checks:lastVerification?.checks});throw error;}
  mark('prepared_payment_review_verified',{kind:'guest_review',payment_prepared:true,card_fields_written:false,ready:verification.ready});
  const completion=await finishGuestReview(window,{mode,product:expectedProduct(url),max_total_usd,event_id:config.handoff_event_id,stage:mark});
  return {status:completion.status,elapsed_ms:Math.round(performance.now()-start),to_review_from_refresh_ms:timings.prepared_payment_review_verified-timings.standby_refresh_requested_at,timings,completion,verification,payment_prepared:true,card_fields_written:false,payment_submitted:completion.order_requested===true};
 }

 if(['Review','Review-init'].includes(destination.step)){
  await waitFor(async()=>(await runGuestDOM(window,'reviewState')).ready,config.step_timeout_ms);
  // Always return to Billing, even if Apple retained the current payment.
  await runGuestDOM(window,'editSavedBilling');mark('payment_details_edit_requested');
  await waitFor(async()=>['Billing','Billing-init'].includes((await runGuestDOM(window,'state')).step),config.step_timeout_ms);
 }
 mark('billing_page_ready');
 await waitFor(async()=>(await runGuestDOM(window,'creditReady')).ready,config.step_timeout_ms);
 await runGuestDOM(window,'selectCredit');mark('credit_selected');
 await waitFor(async()=>(await runGuestDOM(window,'billingReady',{billing,card})).ready,config.step_timeout_ms);
 const fill=await runGuestDOM(window,'fillBilling',{billing,card});mark('billing_fields_filled');
 let stable=0;
 const verification=await waitFor(async()=>{
  const check=await runGuestDOM(window,'billingTick',{billing,card});
  if(!check.ready){stable=0;return false;}
  return ++stable>=2?check:false;
 },config.step_timeout_ms,150);
 mark('billing_verified');
 const completion=await completeGuestPayment(window,{mode,billing,card,timeout:config.step_timeout_ms,product:expectedProduct(url),max_total_usd,event_id:config.handoff_event_id,stage:mark});
 mark('billing_continue_finished');
 return {status:completion.status,elapsed_ms:Math.round(performance.now()-start),from_refresh_ms:timings.billing_verified-timings.standby_refresh_requested_at,to_review_from_refresh_ms:timings.billing_continue_finished-timings.standby_refresh_requested_at,timings,completion,fill_dom_ms:fill.dom_ms,verification,payment_submitted:completion.order_requested===true,order_confirmed:false};
}
export async function finishGuestReview(window,{mode='test',product='',max_total_usd=0,event_id='',stage=()=>{}}={}){
 if(!['test','production'].includes(mode))throw Error('invalid_guest_payment_mode');
 if(mode==='production'&&/^PickupTest/.test(window.profile))throw Error('test_profile_cannot_place_order');
 const review=await runGuestDOM(window,'reviewState');if(!review.ready)throw Error('order_review_not_verified');
 if(mode==='test')return {status:'review_ready_test_stopped',payment_submitted:false};
 stage('guest_order_requested_at');
 const order=await runGuestDOM(window,'placeOrder',{mode,expected_product:product,max_total_usd,event_id});
 stage('guest_order_click_returned_at',{kind:'guest_submission',order_requested:order.order_requested===true,order_confirmed:false,response_unknown:order.response_unknown===true});
 return {status:order.response_unknown?'order_request_uncertain':'order_requested',order_confirmed:false,...order};
}
export async function completeGuestPayment(window,{mode='test',billing,card=readGuestCard(),timeout=20000,product='',max_total_usd=0,event_id='',stage=()=>{}}={}){
 if(!['test','production'].includes(mode))throw Error('invalid_guest_payment_mode');
 if(mode==='production'&&/^PickupTest/.test(window.profile))throw Error('test_profile_cannot_place_order');
 await runGuestDOM(window,'continueBilling',{billing,card});
 const outcome=await waitFor(async()=>{
  const review=await runGuestDOM(window,'reviewState');
  if(review.ready)return {status:'review_ready',review};
  const billingState=await runGuestDOM(window,'billingOutcome');
  return billingState.status==='validation_error'?{status:'billing_validation_failed',...billingState}:false;
 },timeout);
 if(outcome.status!=='review_ready')return {...outcome,payment_submitted:false};
 return finishGuestReview(window,{mode,product,max_total_usd,event_id,stage});
}
export async function resetGuestTestPickup(window,url,config){
 if(window.profile!=='PickupTest18Pro')throw Error('isolated_test_profile_required');
 const before=await runGuestDOM(window,'state');
 if(before.path!=='/shop/checkout'||!['Review','Review-init','Billing','Billing-init','PickupContact','PickupContact-init','Fulfillment','Fulfillment-init'].includes(before.step))throw Error('guest_reset_checkout_required');
 if(!['Fulfillment','Fulfillment-init'].includes(before.step)){
  const current=new URL(await appleScript(window.script('return URL of tab 1 of w')));
  current.searchParams.set('_s','Fulfillment-init');
  await appleScript(window.script('set URL of tab 1 of w to '+JSON.stringify(current.href)));
  await waitFor(async()=>{const s=await runGuestDOM(window,'state');return s.path==='/shop/checkout'&&s.step==='Fulfillment-init'&&s.document_time_origin!==before.document_time_origin;});
 }
 const product=expectedProduct(url);
 await waitFor(async()=>(await window.call('pickup',{product})).ready);
 await waitFor(async()=>(await window.call('pickupReady',{product})).ready);
 await window.call('armPickupStandby',{product,explicit_test_reset:true});
 await prepareSafariStandby(guestAdapter(window),url,config);
}
async function main(){
 const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
 if(!args.includes('--config'))throw Error('usage_--config_FILE_[--billing_FILE]_[--prepare-only|--run-only]');
 if(args.includes('--prepare-only')&&args.includes('--run-only'))throw Error('choose_one_mode');
 const rounds=args.includes('--rounds')?Number(arg('--rounds')):1;
 if(!Number.isInteger(rounds)||rounds<1||rounds>3)throw Error('rounds_must_be_1_to_3');
 const profile='PickupTest18Pro',config=testConfig(JSON.parse(readFileSync(resolve(arg('--config')))),profile,testURL);
 if(args.includes('--prepared-payment'))config.guest_payment_prepared=true;
 const billing=args.includes('--billing')?JSON.parse(readFileSync(resolve(arg('--billing')))):sampleBilling;
 if(!['first_name','last_name','street','zip','city','state'].every(k=>typeof billing[k]==='string'&&billing[k].trim())||!/^\d{5}$/.test(billing.zip)||!/^[A-Z]{2}$/.test(billing.state))throw Error('invalid_test_billing_address');
 const windows=(await listSafariWindows()).filter(w=>w.name.startsWith(profile+' — ')&&w.tabs>0);if(windows.length!==1||windows[0].tabs!==1)throw Error('one_isolated_test_window_required');
 const dir=resolve('runtime/safari-regression');mkdirSync(dir,{recursive:true,mode:0o700});
 const lock=resolve(dir,profile+'.lock'),fd=openSync(lock,'wx',0o600);closeSync(fd);
 const window=new SafariWindow(windows[0].id,profile),report={at:new Date().toISOString(),payment_submitted:false,preparation_stages:[]};
 const reportFile=resolve(dir,Date.now()+'-guest.json');
 try{
  if(!args.includes('--run-only'))report.preparation=await prepareGuest(window,testURL,config,n=>report.preparation_stages.push({name:n,at:new Date().toISOString()}));
  if(!args.includes('--prepare-only')){
   report.rounds=[];
   for(let i=0;i<rounds;i++){
    if(i>0)await resetGuestTestPickup(window,testURL,config);
    report.signal_stages=[];
    report.signal=await runGuestSignal(window,testURL,config,billing,n=>report.signal_stages.push({name:n,at:new Date().toISOString()}));
    report.rounds.push(report.signal);
    writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600});
    console.log(JSON.stringify({round:i+1,status:report.signal.status,from_refresh_ms:report.signal.from_refresh_ms,to_review_from_refresh_ms:report.signal.to_review_from_refresh_ms,payment_details_reused:report.signal.payment_details_reused===true}));
    if(!['review_ready_test_stopped','filled_not_submitted'].includes(report.signal.status))break;
   }
  }
  report.status=report.signal&&!['review_ready_test_stopped','filled_not_submitted'].includes(report.signal.status)?report.signal.status:'passed';
 }catch(e){report.status='failed';report.error=e.code||e.message;process.exitCode=1;}
 finally{writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600});unlinkSync(lock);}
 console.log(JSON.stringify({status:report.status,report:reportFile,preparation_ms:report.preparation?.elapsed_ms,signal_ms:report.signal?.elapsed_ms,error:report.error}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
