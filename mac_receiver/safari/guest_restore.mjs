// Manual readiness means selected Guest pickup + configured ZIP, not saved payment.
import {runGuestDOM} from './guest_checkout.mjs';
import {prepareGuestPaymentSession,validateSetupProfile} from './guest_setup.mjs';
import {waitFor} from './shopping.mjs';
export async function restoreGuestReady(window,url,config,{read=runGuestDOM,rebuild=prepareGuestPaymentSession,stage=()=>{}}={}){
 const product=validateSetupProfile(window,url),zip=config.pickup_zip||'07094';
 let state=await read(window,'state'),navigationChanged=false;
 if(state.path==='/shop/checkout'&&['PickupContact','PickupContact-init','Billing','Billing-init','Review','Review-init'].includes(state.step)){
  // This DOM operation refuses a pending submit marker or a wrong product.
  await read(window,'restoreGuestBeforeSubmit',{expected_product:product});navigationChanged=true;
  await waitFor(async()=>{state=await read(window,'state');return ['Fulfillment','Fulfillment-init'].includes(state.step);},config.step_timeout_ms||20000);
 }
 if(state.path==='/shop/checkout'&&['Fulfillment','Fulfillment-init'].includes(state.step)){
  let standby=await window.call('standbyState',{product});
  if(!standby.expired){
   let changed=navigationChanged;
   if(standby.session_warning){await window.call('continueShoppingSession');changed=true;await waitFor(async()=>{standby=await window.call('standbyState',{product});return !standby.session_warning;},3000);}
   if(!standby.pickup_selected){await window.call('pickup',{product});changed=true;await waitFor(async()=>(await window.call('pickupReady',{product})).ready,config.step_timeout_ms||20000);}
   let location=await window.call('locationState');
   if(location.displayed_zip!==zip){
    if(!location.editable)await window.call('openLocation');
    await waitFor(async()=>(await window.call('locationState')).editable,config.step_timeout_ms||20000);
    await window.call('zip',{zip});changed=true;
    await waitFor(async()=>{location=await window.call('locationState');return location.displayed_zip===zip;},config.step_timeout_ms||20000);
   }
   standby=await window.call('standbyState',{product});
   if(standby.pickup_selected&&!standby.expired&&!standby.session_warning&&location.displayed_zip===zip){stage(changed?'manual_restore_pickup_corrected_at':'manual_restore_already_ready_at');return {status:'standby_checkout',zip,mode:changed?'pickup_corrected':'already_ready',unchanged:!changed};}
  }
 }
 // Explicit manual restoration authorizes re-adding exactly one target only if
 // the Bag is empty. The setup function refuses extra/wrong items and never orders.
 stage('manual_restore_session_rebuild_started_at');
 await rebuild(window,url,{...config,pickup_zip:zip},{allowReplenish:true,stage});
 state=await read(window,'state');
 const standby=await window.call('standbyState',{product}),location=await window.call('locationState');
 if(state.path!=='/shop/checkout'||!['Fulfillment','Fulfillment-init'].includes(state.step)||!standby.pickup_selected||standby.expired||location.displayed_zip!==zip)throw Error('restored_pickup_not_verified');
 return {status:'standby_checkout',zip,mode:'session_rebuilt',unchanged:false};
}
