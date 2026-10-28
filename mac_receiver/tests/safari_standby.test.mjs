import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safariDOM} from '../safari/dom.mjs';
import {pickupLocationDOM} from '../pickup_location.mjs';
import {prepareSafari,prepareSafariStandby} from '../safari/shopping.mjs';
import {ProfileRouter} from '../profile_router.mjs';
import {SafariPickupBrowser} from '../safari/browser.mjs';
import {Engine} from '../engine.mjs';
const url='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-512gb-star-white-unlocked';
const product='iPhone Duo 512GB Star White';
const cfg={standby_page:'pickup_checkout',pickup_zip:'07094',step_timeout_ms:1000,pickup_unavailable_retries:0,pickup_details:{store_name:'Apple Queens Center',first_name:'Test',last_name:'User',email:'test@example.com',phone:'2025550123',preferred_slot:2,min_lead_minutes:0}};
async function fixture(t,{hiddenExtras=false,noAvailability=false}={}){
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();let bagLoads=0,checkoutLoads=0,expire=false;
 await page.route('**/*',async r=>{
  if(new URL(r.request().url()).pathname==='/shop/bag'){
   bagLoads++;return r.fulfill({contentType:'text/html',body:`<div role="listitem" data-autom="bag-item-1"><h2>${product}</h2><select><option>1</option></select></div><button id="shoppingCart.actions.navApwCheckout" onclick="location.href='/checkout'">Check out with Apple Pay</button>`});
  }
  if(new URL(r.request().url()).pathname!=='/checkout')return r.fulfill({status:204});
  if(expire){expire=false;return r.fulfill({status:302,headers:{location:'https://www.apple.com/shop/bag'}});}
  checkoutLoads++;return r.fulfill({contentType:'text/html; charset=utf-8',body:`<p>${product}</p><button aria-label="Edit Zip Code or City, State, 07094">07094</button><label><input type="radio" checked>I’ll pick it up</label>${noAvailability?`<div role="alert">There's no availability within your location. Please try another search.</div>`:''}<fieldset><legend>Select your pickup store:</legend><label><input type="radio" disabled>Apple Queens Center Currently unavailable</label>${hiddenExtras?`<div id="extra" hidden><label><input type="radio" disabled>Apple Other Currently unavailable</label></div><a href="#" onclick="event.preventDefault();document.getElementById('extra').hidden=false;this.remove()">Show more stores</a>`:''}</fieldset>`});
 });
 await page.goto('https://www.apple.com/shop/bag');
 const window={call:async(op,args={})=>{try{return await page.evaluate(['locationState','openLocation'].includes(op)?pickupLocationDOM:safariDOM,['locationState','openLocation'].includes(op)?{open:op==='openLocation'}:{op,args});}catch(e){if(e.message.includes('Execution context was destroyed'))e.code='safari_navigation_pending';throw e;}},goto:u=>page.goto(u),reload:()=>page.reload()};
 return {page,window,counts:()=>({bagLoads,checkoutLoads}),expire:()=>expire=true};
}
test('standby starts from exact Bag and verifies pickup ZIP without selection',async t=>{
 const f=await fixture(t);assert.equal((await prepareSafariStandby(f.window,url,cfg)).status,'standby_checkout');
 assert.deepEqual(f.counts(),{bagLoads:2,checkoutLoads:1});
 assert.equal((await f.window.call('locationState')).displayed_zip,'07094');
 assert.equal(await f.page.getByRole('radio',{name:/Apple Queens/}).isChecked(),false);
});
test('incoming warm event reloads once and skips Bag and checkout navigation',async t=>{
 const f=await fixture(t);await prepareSafariStandby(f.window,url,cfg);const stages=[];
 const r=await prepareSafari(f.window,url,cfg,{stage:s=>stages.push(s)});
 assert.equal(r.status,'pickup_unavailable');assert.deepEqual(f.counts(),{bagLoads:2,checkoutLoads:2});
 assert.ok(stages.includes('standby_refresh_at'));assert.ok(!stages.includes('checkout_clicked_at'));
});
test('standby and every inventory retry expand the full store list',async t=>{
 const f=await fixture(t,{hiddenExtras:true});await prepareSafariStandby(f.window,url,cfg);
 assert.ok((await f.window.call('stores')).stores.every(s=>s.visible));
 assert.equal((await prepareSafari(f.window,url,{...cfg,pickup_unavailable_retries:2})).status,'pickup_unavailable');
 assert.equal(f.counts().checkoutLoads,4);assert.equal(f.counts().bagLoads,2);
 assert.ok((await f.window.call('stores')).stores.every(s=>s.visible));
 assert.equal(await f.page.getByRole('link',{name:'Show more stores'}).count(),0);
});
test('visible area-unavailable banner skips expansion and uses bounded retries even when target missing',async t=>{
 const f=await fixture(t,{hiddenExtras:true,noAvailability:true});await prepareSafariStandby(f.window,url,cfg);
 assert.equal((await f.window.call('stores')).no_availability,true);
 assert.equal(await f.page.locator('#extra').isVisible(),false);
 const stages=[];
 const r=await prepareSafari(f.window,url,{...cfg,pickup_unavailable_retries:2,pickup_details:{...cfg.pickup_details,store_name:'Apple Missing'}},{stage:s=>stages.push(s)});
 assert.equal(r.status,'pickup_unavailable');assert.equal(f.counts().checkoutLoads,4);
 assert.equal(await f.page.locator('#extra').isVisible(),false);assert.ok(stages.includes('standby_expansion_skipped_no_availability_at'));
 // A removed or hidden warning no longer suppresses expansion.
 await f.page.getByRole('alert').evaluate(e=>e.hidden=true);
 assert.equal((await f.window.call('stores')).no_availability,false);
 await prepareSafariStandby(f.window,url,cfg);
 assert.equal(await f.page.locator('#extra').isVisible(),true);
});
test('selected store and pickup details are protected from maintenance reload',async t=>{
 const f=await fixture(t);await prepareSafariStandby(f.window,url,cfg);
 await f.page.getByRole('radio',{name:/Apple Queens/}).evaluate(e=>{e.disabled=false;e.checked=true;});
 await assert.rejects(()=>prepareSafariStandby(f.window,url,cfg,{refresh:true}),e=>e.code==='standby_checkout_protected');
 assert.equal(f.counts().checkoutLoads,1);
 await f.page.setContent('<h1>Now fill out your pickup information.</h1><button id="co-options-applePay">Continue with Apple Pay</button>');
 await assert.rejects(()=>prepareSafariStandby(f.window,url,cfg,{refresh:true}),e=>e.code==='standby_checkout_protected');
 assert.equal(f.counts().checkoutLoads,1);
});
test('expired checkout returning to Bag rebuilds once from verified quantity one',async t=>{
 const f=await fixture(t);await prepareSafariStandby(f.window,url,cfg);f.expire();
 assert.equal((await prepareSafariStandby(f.window,url,cfg,{refresh:true})).status,'standby_checkout');
 assert.deepEqual(f.counts(),{bagLoads:3,checkoutLoads:2});
});
test('global idle maintenance serializes profiles and yields to reserved arrival',async t=>{
 const root=mkdtempSync(join(tmpdir(),'standby-router-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let finish,calls=0;const slots=['A','B'].map(label=>({label,product_url:label==='A'?url:url+'?b',engine:{state:{active:null,events:{}}},browser:{ready:()=>true,ensurePage:async()=>{},refreshStandby:()=>{calls++;return new Promise(r=>finish=r);}}}));
 const router=new ProfileRouter({single_active_request:true,state_dir:root,browser_backend:'safari'},slots);
 const maintenance=router.maintainStandby();assert.equal(calls,1);assert.equal(await router.maintainStandby(),false);
 const incoming=router.beforeAccept({event_id:'new',product_url:url});assert.equal(router.globalLock.event_id,'new');
 finish();await maintenance;await incoming;assert.equal(await router.maintainStandby(),false);assert.equal(calls,1);
});
test('twenty-minute timer is bounded and an incoming reservation suppresses refresh',async()=>{
 let refreshed=0;
 class Window{async call(){return {protected:false};}}
 const b=new SafariPickupBrowser({...cfg,safari_profile:'Test',preseeded_product_url:url,idle_checkout_refresh_interval_seconds:1200},{Window,listWindows:async()=>[{id:1,name:'Test — Checkout',tabs:1}],standby:async()=>{refreshed++;return {status:'standby_checkout'};}});
 await b.start();b.lastIdleRefreshAt=0;
 assert.equal((await b.refreshStandby(1199999)).status,'checked');assert.equal(refreshed,0);
 b.requestReservations=1;assert.equal(b.refreshStandby(1200000),null);
 b.requestReservations=0;assert.equal((await b.refreshStandby(1200000)).status,'standby_checkout');
 assert.equal(refreshed,1);assert.equal(b.refreshStandby(1200001),null);
});
test('expired session heading plus Return to Bag link is recognized and rebuilt on minute check',async t=>{
 const f=await fixture(t);await prepareSafariStandby(f.window,url,cfg);
 await f.page.setContent('<h1>Your session has expired.</h1><a href="https://www.apple.com/shop/bag">Return to Bag</a>');
 assert.equal((await f.window.call('standbyState',{product})).expired,true);
 let calls=0;class Window{constructor(){return f.window;}}
 const b=new SafariPickupBrowser({...cfg,safari_profile:'Test',preseeded_product_url:url,idle_checkout_refresh_interval_seconds:1200},{Window,listWindows:async()=>[{id:1,name:'Test — Sorry',tabs:1}],standby:async(w,u,c,o)=>{calls++;assert.equal(o.refresh,false);return prepareSafariStandby(w,u,c,o);}});
 await b.start();b.lastIdleRefreshAt=0;
 assert.equal((await b.refreshStandby(60000)).status,'standby_checkout');assert.equal(calls,1);
 assert.equal((await f.window.call('standbyState',{product})).ready,true);
});
test('healthy minute check does not navigate or extend twenty-minute refresh deadline',async()=>{
 let calls=0;class Window{async call(){return {ready:true,protected:false,expired:false};}}
 const b=new SafariPickupBrowser({...cfg,safari_profile:'Test',preseeded_product_url:url,idle_checkout_refresh_interval_seconds:1200},{Window,listWindows:async()=>[{id:1,name:'Test — Checkout',tabs:1}],standby:async()=>{calls++;}});
 await b.start();b.lastIdleRefreshAt=0;
 assert.equal(b.refreshStandby(59999),null);assert.equal((await b.refreshStandby(60000)).status,'checked');
 assert.equal(calls,0);assert.equal(b.lastIdleRefreshAt,0);assert.equal(b.refreshStandby(60001),null);
});
test('failed session recovery backs off three minutes rather than looping',async()=>{
 let calls=0,expired=true;class Window{async call(){return {expired,protected:false};}}
 const b=new SafariPickupBrowser({...cfg,safari_profile:'Test',preseeded_product_url:url,idle_checkout_refresh_interval_seconds:1200},{Window,listWindows:async()=>[{id:1,name:'Test — Sorry',tabs:1}],standby:async()=>{calls++;expired=false;throw Error('network_down');}});
 await b.start();b.lastIdleRefreshAt=0;
 assert.equal((await b.refreshStandby(60000)).status,'failed');
 assert.equal((await b.refreshStandby(120000)).status,'backoff');assert.equal(calls,1);
 assert.equal((await b.refreshStandby(240000)).status,'failed');assert.equal(calls,2);
});
test('protected page is never passed to the maintenance workflow',async()=>{
 let refreshed=0;
 class Window{async call(){return {protected:true};}}
 const b=new SafariPickupBrowser({...cfg,safari_profile:'Test',preseeded_product_url:url,idle_checkout_refresh_interval_seconds:1200},{Window,listWindows:async()=>[{id:1,name:'Test — Checkout',tabs:1}],standby:async()=>{refreshed++;}});
 await b.start();b.lastIdleRefreshAt=0;
 assert.equal((await b.refreshStandby(1200000)).status,'protected');assert.equal(refreshed,0);
});
function lockedFixture(t,refreshStandby){
 const root=mkdtempSync(join(tmpdir(),'expired-owner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const browser={ready:()=>true,refreshStandby};const engine=new Engine({state_dir:join(root,'owner'),dry_run:false},browser);
 const item={event_id:'owner',product_url:url,status:'manual_review',timestamps:{pickup_stock_found_at:new Date().toISOString()}};
 engine.state.active=item.event_id;engine.state.events.owner=item;engine.save();
 const owner={label:'B',product_url:url,browser,engine};
 const router=new ProfileRouter({single_active_request:true,state_dir:join(root,'gate'),browser_backend:'safari'},[owner]);
 return {root,router,engine,item,owner};
}
test('completed protected task allows passive checks of idle slots, never proactive refresh',async t=>{
 let ownerChecks=0,idleChecks=0;
 const f=lockedFixture(t,(now,o)=>{assert.equal(o.expiredOnly,true);return ownerChecks++===0?Promise.resolve({status:'checked'}):null;});
 f.router.slots.push({label:'C',engine:{state:{active:null,events:{}}},browser:{refreshStandby:(now,o)=>{idleChecks++;assert.equal(o.expiredOnly,true);return Promise.resolve({status:'checked'});}}});
 await f.router.maintainStandby();await f.router.maintainStandby();
 assert.equal(idleChecks,1);assert.equal(f.engine.state.active,'owner');assert.equal(f.router.globalLock.event_id,'owner');assert.equal(f.item.status,'manual_review');
});
test('definite expired owner releases only after restored pickup checkout, with durable expiry proof',async t=>{
 let finish;
 const f=lockedFixture(t,async(now,o)=>{await o.onExpired();return new Promise(r=>finish=r);});
 const p=f.router.maintainStandby();await new Promise(r=>setImmediate(r));
 assert.equal(f.item.status,'session_expired_recovering');assert.ok(f.item.timestamps.checkout_session_expired_at);
 assert.equal(f.engine.state.active,'owner');assert.equal(f.router.globalLock.event_id,'owner');
 finish({status:'standby_checkout'});await p;
 assert.equal(f.item.status,'session_expired_returned');assert.ok(f.item.timestamps.session_recovered_at);
 assert.equal(f.engine.state.active,null);assert.equal(f.router.globalLock.event_id,null);
});
test('failed expired-owner restore retains lock and resumes durable recovery after restart',async t=>{
 const f=lockedFixture(t,async(now,o)=>{await o.onExpired();return {status:'failed'};});
 await f.router.maintainStandby();assert.equal(f.engine.state.active,'owner');assert.equal(f.router.globalLock.event_id,'owner');
 const browser={ready:()=>true,refreshStandby:async(now,o)=>{assert.equal(o.recovering,true);return {status:'standby_checkout'};}};
 const engine=new Engine(f.engine.config,browser);
 const router=new ProfileRouter(f.router.config,[{...f.owner,browser,engine}]);
 await router.maintainStandby();assert.equal(engine.state.active,null);assert.equal(router.globalLock.event_id,null);
});
test('running inventory work blocks all session maintenance',async t=>{
 let calls=0;const f=lockedFixture(t,()=>{calls++;return Promise.resolve({status:'checked'});});
 f.item.status='running';assert.equal(await f.router.maintainStandby(),false);assert.equal(calls,0);
});

test('session warning click dismisses only exact shopping modal without navigation',async t=>{
 const f=await fixture(t);await prepareSafariStandby(f.window,url,cfg);
 await f.page.evaluate(()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<h2>Are you still shopping?</h2><p>We will sign you out in 60 seconds.</p><button onclick="this.parentNode.remove()">I’m still shopping</button>';document.body.appendChild(d);});
 assert.equal((await f.window.call('standbyState',{product})).session_warning,true);
 let calls=0;class Window{constructor(){return f.window;}}
 const b=new SafariPickupBrowser({...cfg,safari_profile:'Test',preseeded_product_url:url,checkout_session_check_interval_seconds:30,idle_checkout_refresh_interval_seconds:1200},{Window,listWindows:async()=>[{id:1,name:'Test — Checkout',tabs:1}],standby:async()=>{calls++;throw Error('must not rebuild');}});
 await b.start();b.lastIdleRefreshAt=0;
 assert.equal((await b.refreshStandby(30000)).status,'session_continued');
 assert.equal(calls,0);assert.equal((await f.window.call('standbyState',{product})).session_warning,false);
 assert.deepEqual(f.counts(),{bagLoads:2,checkoutLoads:1});
});
test('unrelated or ambiguous shopping buttons never get clicked',async t=>{
 const f=await fixture(t);await prepareSafariStandby(f.window,url,cfg);
 await f.page.setContent('<button onclick="window.clicked=true">I’m still shopping</button>');
 assert.equal((await f.window.call('standbyState',{product})).session_warning,false);
 await assert.rejects(()=>f.window.call('continueShoppingSession'),/missing_or_ambiguous/);
 await f.page.setContent('<div role="dialog"><h2>Are you still shopping?</h2><button>I’m still shopping</button><button>I’m still shopping</button></div>');
 await assert.rejects(()=>f.window.call('continueShoppingSession'),/missing_or_ambiguous/);
});
