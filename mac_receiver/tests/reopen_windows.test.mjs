import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRecyclable,openProfileScript} from '../reopen_windows.mjs';
const page={path:'/shop/checkout',step:'Fulfillment'};
const standby={ready:true,pickup_selected:true,matching_product:true,protected:false,expired:false,session_warning:false};
test('window recycling accepts only an idle matching pickup page',()=>{
 assert.doesNotThrow(()=>assertRecyclable({},page,standby));
 for(const k of ['active_event_id','request_reserved','maintenance_in_progress','recovery_pending'])assert.throws(()=>assertRecyclable({[k]:true},page,standby),/profile_busy/);
 for(const step of ['Review','Billing','PickupContact'])assert.throws(()=>assertRecyclable({},{...page,step},standby),/idle_pickup_required/);
 for(const k of ['protected','expired','session_warning'])assert.throws(()=>assertRecyclable({},page,{...standby,[k]:true}),/idle_pickup_required/);
 for(const k of ['ready','pickup_selected','matching_product'])assert.throws(()=>assertRecyclable({},page,{...standby,[k]:false}),/idle_pickup_required/);
 assert.throws(()=>assertRecyclable({},page,{...standby,protection:{payment_requested:true}}),/idle_pickup_required/);
});
test('native reopen targets an exact existing Duo profile, never personal or test',()=>{
 for(const profile of ['Duo256White','Duo256Black','Duo512White','Duo512Black','Duo1024White','Duo1024Black'])assert.ok(openProfileScript(profile).includes('New '+profile+' Window'));
 for(const p of ['Personal','PickupTest18Pro','Duo1024White"'])assert.throws(()=>openProfileScript(p),/unsupported_profile/);
});
test('explicit window recycling also accepts an idle Guest sign-in entry but never a busy one',()=>{
 assert.doesNotThrow(()=>assertRecyclable({},{path:'/shop/signIn',guest:true},{}));
 assert.throws(()=>assertRecyclable({active_event_id:'live'},{path:'/shop/signIn',guest:true},{}),/profile_busy/);
 assert.throws(()=>assertRecyclable({},{path:'/shop/signIn',guest:false},{}),/idle_pickup_required/);
});
