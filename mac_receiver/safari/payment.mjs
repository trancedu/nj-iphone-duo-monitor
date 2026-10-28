// Observes lifecycle status only. Never reads a payment token, card or address,
// changes authorization results, or invokes authentication/payment APIs itself.
export function paymentLifecycleDOM({op,args={}}){
 const key='duo_payment_attempt_v1',norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const u=new URL(location.href);
 const allowed=/^secure\d*\.store\.apple\.com$/.test(u.hostname)&&(['expirePaymentWindow','manualRetryPickup'].includes(op)?u.pathname.startsWith('/shop/'):u.pathname==='/shop/apw/checkout');
 if(!allowed){if(op==='observePaymentAttempt')return {installed:false};throw Error('payment_observer_checkout_required');}
 const read=()=>{try{return window.__duoPaymentAttempt||JSON.parse(sessionStorage.getItem(key)||'null');}catch{return null;}};
 const save=state=>{window.__duoPaymentAttempt=state;try{sessionStorage.setItem(key,JSON.stringify(state));}catch{}};
 if(op==='observePaymentAttempt'){
  if(!args.event_id||typeof args.event_id!=='string')return {installed:false};
  window.__duoPaymentPendingEvent=args.event_id;window.__duoPaymentPendingProduct=args.product;
  if(!window.__duoPaymentClickTracking){
   document.addEventListener('click',event=>{
    const button=event.target instanceof Element?event.target.closest('button'):null;
    if(event.isTrusted&&button?.id==='co-options-applePay'&&!button.disabled){
     save({event_id:window.__duoPaymentPendingEvent,product:window.__duoPaymentPendingProduct,phase:'manual_button_clicked',at:new Date().toISOString(),authorized:false,closed:false,outcome:'unknown'});
    }
   },true);
   window.__duoPaymentClickTracking=true;
  }
  if(window.__duoPaymentObserverInstalled)return {installed:true};
  const proto=window.ApplePaySession?.prototype;
  if(!proto?.begin||!proto.completePayment)return {installed:true,lifecycle:false};
  const begin=proto.begin,complete=proto.completePayment,attempts=new WeakMap();
  const wrappedBegin=function(...values){
   if(attempts.has(this))return Reflect.apply(begin,this,values);
   const state={event_id:window.__duoPaymentPendingEvent,product:window.__duoPaymentPendingProduct,phase:'begin_requested',at:new Date().toISOString(),authorized:false,closed:false,outcome:'unknown'};
   attempts.set(this,state);save(state);
   this.addEventListener('validatemerchant',()=>{state.phase='sheet_displayed';save(state);});
   this.addEventListener('paymentauthorized',()=>{state.authorized=true;state.phase='authorization_seen';save(state);});
   this.addEventListener('cancel',()=>{state.closed=true;state.phase='cancelled';save(state);});
   try{return Reflect.apply(begin,this,values);}catch(error){state.phase='begin_failed';state.closed=true;state.outcome='failed';save(state);throw error;}
  };
  const wrappedComplete=function(result,...values){
   const output=Reflect.apply(complete,this,[result,...values]);
   const state=attempts.get(this);
   if(state){
    const status=typeof result==='number'?result:result?.status;
    if(typeof status==='number'&&status===window.ApplePaySession.STATUS_FAILURE){state.outcome='failed';state.closed=true;state.phase='payment_failed';}
    else if(typeof status==='number'&&status===window.ApplePaySession.STATUS_SUCCESS){state.outcome='success';state.closed=true;state.phase='payment_completed';}
    state.result_at=new Date().toISOString();save(state);
   }
   return output;
  };
  proto.begin=wrappedBegin;proto.completePayment=wrappedComplete;
  const installed=proto.begin===wrappedBegin&&proto.completePayment===wrappedComplete;
  if(!installed){if(proto.begin===wrappedBegin)proto.begin=begin;if(proto.completePayment===wrappedComplete)proto.completePayment=complete;}
  window.__duoPaymentObserverInstalled=installed;return {installed:true,lifecycle:installed};
 }
 if(op==='expirePaymentWindow'||op==='manualRetryPickup'){
  const manual=op==='manualRetryPickup';
  if(manual&&args.confirm_manual_retry!==true)throw Error('explicit_manual_retry_required');
  // Explicit user policy: ten seconds after requesting Apple Pay, return even
  // when the result is unknown or successful. This does not infer order status.
  const current=read();
  if(!manual&&current&&current.event_id!==args.event_id)return {returned:false};
  if(current){current.phase=manual?'manual_retry_returned':'window_timeout_returned';save(current);}
  window.__duoApplePayRequested=false;window.__duoPickupStoreSelected=false;window.__duoPickupContinueRequested=false;window.__duoPickupAttemptAbandoned=false;
  const navigating=!manual||u.pathname!=='/shop/apw/checkout'||u.searchParams.get('_s')!=='Fulfillment-init';
  u.pathname='/shop/apw/checkout';u.searchParams.set('_s','Fulfillment-init');
  if(navigating)location.assign(u.href);return {returned:true,navigating};
 }
 const state=read(),owned=!!state&&state.event_id===args.event_id;
 const visible=e=>!!e&&!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const confirmation=[...document.querySelectorAll('h1,h2,[data-autom*="order-confirmation"]')].some(e=>visible(e)&&/order confirmation|thank you for your order|your order (?:has been|is) (?:placed|confirmed)/i.test(norm(e.textContent)));
 const matching=typeof args.product==='string'&&(owned&&state.product===args.product||norm(document.body.textContent).includes(args.product));
 const errorText=[...document.querySelectorAll('[role="alert"],.rs-error,.form-message-wrapper')].filter(visible).map(e=>norm(e.textContent)).join(' ');
 const explicitFailure=/payment (?:was |has been )?(?:declined|failed|not authorized)|unable to (?:process|complete|authorize) (?:your |the )?payment|payment (?:could not|couldn[’']t) be (?:processed|completed)/i.test(errorText);
 const success=confirmation||(owned&&state.outcome==='success');
 const failed=owned&&state.outcome==='failed'||explicitFailure&&owned&&state.closed&&state.outcome!=='success';
 const recoverable=!!failed&&!success&&matching&&['Fulfillment-init','PickupContact-init'].includes(u.searchParams.get('_s'))&&(owned&&state.closed);
 const observation={event_id:args.event_id,observed:owned,requested_at:owned?state.at:null,phase:owned?state.phase:'unknown',outcome:success?'success':failed?'failed':'unknown',closed:owned&&state.closed===true,recoverable};
 if(op==='paymentFailureState')return observation;
 if(op==='recoverPaymentFailure'){
  if(!recoverable)return {recovered:false,...observation};
  // Atomic recheck above prevents generic errors, cancellation, successful or
  // ambiguous payments from navigating the user's page.
  state.phase='failure_recovered';state.outcome='recovered';save(state);
  window.__duoApplePayRequested=false;window.__duoPickupStoreSelected=false;window.__duoPickupContinueRequested=false;window.__duoPickupAttemptAbandoned=false;
  const navigating=u.searchParams.get('_s')!=='Fulfillment-init';
  if(navigating){u.searchParams.set('_s','Fulfillment-init');location.assign(u.href);}
  return {recovered:true,navigating};
 }
 throw Error('unsupported_payment_observer_operation');
}
