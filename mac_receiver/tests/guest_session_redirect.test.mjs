import test from 'node:test';
import assert from 'node:assert/strict';
import {SafariPickupBrowser} from '../safari/browser.mjs';
const url='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-night-sky-unlocked';
async function fixture(path,{fail=false}={}){
 let calls=0;
 class Window{async call(){throw Error('generic_dom_must_not_inspect_signin');}}
 const b=new SafariPickupBrowser({safari_profile:'Duo256Black',preseeded_product_url:url,checkout_method:'guest_credit',guest_auto_rearm:true,standby_page:'pickup_checkout',checkout_session_check_interval_seconds:30,idle_checkout_refresh_interval_seconds:1200},{Window,listWindows:async()=>[{id:1,name:'Duo256Black — Sign In',tabs:1}],guestState:async()=>({path}),guestSetup:async()=>{calls++;if(fail)throw Error('guest_target_window_not_visible');return {status:'standby_checkout'};}});
 await b.start();b.lastIdleRefreshAt=0;return {b,calls:()=>calls};
}
for(const path of ['/shop/signIn','/shop/bag'])test('idle Guest redirect recovers instead of looping login_required: '+path,async()=>{
 const f=await fixture(path);assert.equal((await f.b.refreshStandby(30000)).status,'standby_checkout');assert.equal(f.calls(),1);assert.equal(f.b.lastStandbyReady,true);assert.equal(f.b.lastSessionCheck.status,'recovered');
});
test('failed Guest redirect recovery backs off and never claims ready',async()=>{
 const f=await fixture('/shop/signIn',{fail:true});assert.equal((await f.b.refreshStandby(30000)).status,'failed');assert.equal(f.b.lastStandbyReady,false);assert.equal((await f.b.refreshStandby(60000)).status,'backoff');assert.equal(f.calls(),1);
});
test('inventory reservation blocks Guest redirect recovery',async()=>{
 const f=await fixture('/shop/signIn');f.b.requestReservations=1;assert.equal(f.b.refreshStandby(30000),null);assert.equal(f.calls(),0);
});
