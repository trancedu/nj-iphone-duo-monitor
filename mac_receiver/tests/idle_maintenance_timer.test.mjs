import test from 'node:test';
import assert from 'node:assert/strict';
import {SafariPickupBrowser} from '../safari/browser.mjs';
const url='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-512gb-star-white-unlocked';
async function fixture(){
 let warning=false,protectedPage=false,refreshes=0;
 class Window{async call(op){if(op==='continueShoppingSession'){warning=false;return {clicked:true};}return {ready:true,pickup_selected:true,protected:protectedPage,expired:false,session_warning:warning};}}
 const b=new SafariPickupBrowser({safari_profile:'Test',preseeded_product_url:url,standby_page:'pickup_checkout',idle_checkout_refresh_interval_seconds:600,checkout_session_check_interval_seconds:30},{Window,listWindows:async()=>[{id:1,name:'Test — Checkout',tabs:1}],standby:async(w,u,c,o)=>{assert.equal(o.refresh,true);refreshes++;return {status:'standby_checkout'};}});
 await b.start();b.lastIdleRefreshAt=0;b.lastStandbyCheckAt=0;
 return {b,setWarning:v=>warning=v,setProtected:v=>protectedPage=v,refreshes:()=>refreshes};
}
test('shopping warning does not postpone the ten-minute actual refresh',async()=>{
 const f=await fixture();f.setWarning(true);
 assert.equal((await f.b.refreshStandby(590000)).status,'session_continued');assert.equal(f.b.lastIdleRefreshAt,0);assert.equal(f.b.lastSessionContinuedAt,590000);
 assert.equal((await f.b.refreshStandby(600000)).status,'standby_checkout');assert.equal(f.refreshes(),1);assert.equal(f.b.lastIdleRefreshAt,600000);
});
test('protected due page retains its original maintenance deadline until idle',async()=>{
 const f=await fixture();f.setProtected(true);assert.equal((await f.b.refreshStandby(600000)).status,'protected');assert.equal(f.b.lastIdleRefreshAt,0);assert.equal(f.refreshes(),0);
 f.setProtected(false);assert.equal((await f.b.refreshStandby(602000)).status,'standby_checkout');assert.equal(f.refreshes(),1);
});
test('ten-minute maintenance waits for the boundary and skips inventory reservations',async()=>{
 const f=await fixture();assert.equal((await f.b.refreshStandby(599999)).status,'checked');assert.equal(f.refreshes(),0);
 f.b.requestReservations=1;assert.equal(f.b.refreshStandby(600000),null);assert.equal(f.b.lastIdleRefreshAt,0);
 f.b.requestReservations=0;assert.equal((await f.b.refreshStandby(600001)).status,'standby_checkout');assert.equal(f.refreshes(),1);
});
