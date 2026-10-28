import test from 'node:test';
import assert from 'node:assert/strict';
import {SafariPickupBrowser,pollSafariSlots} from '../safari/browser.mjs';
import {ProfileRouter} from '../profile_router.mjs';
import {Engine} from '../engine.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
const url='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-512gb-night-sky-unlocked';
function fixture(options={}){
 let windows=[{id:42,name:'Duo512Black — Bag - Apple',tabs:1}],calls=[];
 const config={safari_profile:'Duo512Black',preseeded_product_url:url,pickup_details:{store_name:'Apple West 14th Street'},...options};
 class Window{constructor(id,profile){this.id=id;}async call(){return {};}async foreground(){}}
 const b=new SafariPickupBrowser(config,{listWindows:async()=>windows,Window,prepare:async(w,u,c,o)=>{calls.push({u,c,o});return {status:'awaiting_user'};},signal:async()=>({sound_played:true})});
 return {b,calls,setWindows:w=>windows=w};
}
test('Safari production chooses first available store while retaining event store for diagnostics',async()=>{
 const f=fixture();await f.b.start();
 assert.equal(await f.b.prepare({product_url:url,store_name:'Grand Central'},()=>{}),'awaiting_user');
 assert.equal(f.calls[0].c.pickup_details.store_name,'Apple Grand Central');assert.equal(f.calls[0].c.test_any_available_store,false);assert.equal(f.calls[0].c.pickup_first_available_store,true);
 assert.equal(f.b.config.pickup_details.store_name,'Apple West 14th Street');
});
test('Safari production missing/ambiguous profile or extra tab refuses execution',async()=>{
 for(const windows of [[],[{id:42,name:'Duo512Black — Bag',tabs:1},{id:43,name:'Duo512Black — Bag',tabs:1}],[{id:42,name:'Duo512Black — Bag',tabs:2}]]){
  const f=fixture();f.setWindows(windows);await assert.rejects(()=>f.b.start());assert.equal(f.b.ready(),false);assert.equal(f.calls.length,0);
 }
});
test('Safari metadata poll preserves locks when all windows disappear',async()=>{
 const f=fixture();await f.b.start();let closed=0;
 await pollSafariSlots([{browser:f.b,engine:{state:{active:'x'},tabClosed:async()=>{closed++;}}}],[]);
 assert.equal(closed,0);assert.equal(f.b.ready(),false);
});
test('completed Safari window closure releases only after same profile reopens and reseeds',async t=>{
 const root=mkdtempSync(join(tmpdir(),'safari-adapter-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const f=fixture(),other=fixture();other.b.config.safari_profile='Other';other.setWindows([{id:99,name:'Other — Bag',tabs:1}]);await f.b.start();await other.b.start();
 const cfg={state_dir:root,dry_run:false,queue_while_busy:true,release_on_task_tab_close:true,preseed_on_release:true};const e=new Engine(cfg,f.b);
 const event=id=>({event_id:id,product_url:url,detected_at:new Date().toISOString()});
 e.accept(event('first'));await turn();await turn();e.accept(event('second'));
 const slots=[{browser:f.b,engine:e},{browser:other.b,engine:{state:{active:null}}}];
 f.setWindows([{id:99,name:'Other — Bag',tabs:1}]);await pollSafariSlots(slots,[{id:99}]);assert.equal(e.state.active,'first');
 f.setWindows([{id:43,name:'Duo512Black — Bag',tabs:1},{id:99,name:'Other — Bag',tabs:1}]);await pollSafariSlots(slots,[{id:43},{id:99}]);
 await turn();await turn();assert.equal(e.state.active,'second');assert.equal(f.calls.filter(c=>c.o.seedOnly).length,1);
});
test('Safari reset restores bag before releasing lock or dispatching held request',async t=>{
 const root=mkdtempSync(join(tmpdir(),'safari-reset-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const f=fixture();await f.b.start();
 const e=new Engine({state_dir:root,dry_run:false,queue_while_busy:true},f.b),slot={label:'D',product_url:url,browser:f.b,engine:e};const router=new ProfileRouter({browser_backend:'safari'},[slot]);
 const event=id=>({event_id:id,product_url:url,detected_at:new Date().toISOString()});e.accept(event('first'));await turn();await turn();e.accept(event('second'));
 let release;f.b.seedIdle=()=>new Promise(r=>{release=r;});const resetting=router.reset('first');assert.equal(e.state.active,'first');assert.equal(e.state.events.second.status,'held');release();assert.equal(await resetting,true);await turn();await turn();assert.equal(e.state.active,'second');
});
test('failed Safari standby restore keeps active request and queue locked',async t=>{
 const root=mkdtempSync(join(tmpdir(),'safari-reset-fail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const f=fixture();await f.b.start();const e=new Engine({state_dir:root,dry_run:false},f.b);e.state.active='first';e.state.events.first={event_id:'first',status:'awaiting_user'};
 f.b.seedIdle=async()=>{throw Error('restore failure');};const router=new ProfileRouter({browser_backend:'safari'},[{browser:f.b,engine:e}]);await assert.rejects(()=>router.reset('first'));assert.equal(e.state.active,'first');
});
test('Safari idle missing window holds event until window reopens, then dispatches once',async t=>{
 const root=mkdtempSync(join(tmpdir(),'safari-idle-hold-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const f=fixture();f.setWindows([]);
 const e=new Engine({state_dir:root,dry_run:false,queue_when_browser_not_ready:true},f.b);
 const event={event_id:'waiting-window',product_url:url,detected_at:new Date().toISOString()};assert.equal(e.accept(event).body.status,'held');assert.equal(f.calls.length,0);
 const windows=[{id:43,name:'Duo512Black — Bag',tabs:1}];f.setWindows(windows);await pollSafariSlots([{browser:f.b,engine:e}],windows);await turn();await turn();
 assert.equal(e.state.events[event.event_id].status,'awaiting_user');assert.equal(f.calls.length,1);
});
test('Safari adapter forwards event store identity with observations and handoff reason',async()=>{
 const f=fixture();const observations=[];await f.b.start();
 f.b.workflow=async(w,u,c,{stage})=>{stage('pickup_inventory_observed_at',{kind:'pickup_inventory',verdict:'target_store_not_listed',stores:[]});throw new (await import('../protocol.mjs')).Stop('target_store_not_listed');};
 await assert.rejects(()=>f.b.prepare({product_url:url,store_name:'Garden State Plaza',store_id:'R117'},(name,detail)=>observations.push(detail)),e=>e.code==='target_store_not_listed');
 assert.equal(observations[0].requested_store_id,'R117');assert.equal(observations[0].requested_store_name,'Apple Garden State Plaza');assert.equal(observations[1].error_code,'target_store_not_listed');
 f.b.signal=async(window,result)=>result;assert.equal((await f.b.handoff('manual_review','target_store_not_listed')).reason,'target_store_not_listed');
});
test('configuration is announced on signal start and final handoff skips duplicate audio',async()=>{
 const f=fixture();await f.b.start();const calls=[];f.b.signal=async(w,r,c)=>{calls.push({r,c});return {audio_queued:true};};const e={event_id:'signal-test',product_url:url};f.b.activeTaskId=e.event_id;await f.b.onEventStarted(e);await f.b.handoff('awaiting_user');assert.equal(calls[0].r.status,'inventory_signal');assert.equal(calls[1].c.mute_audio,true);
});

test('timeout becomes expired only with confirmed unavailable fulfillment and correct ZIP',async()=>{
 const {Stop}=await import('../protocol.mjs');
 for(const invalid of [null,'unconfirmed','contact','zip','other-error']){
  const f=fixture({pickup_zip:'07094'});await f.b.start();f.b.ensurePage=async()=>{};
  f.b.window.call=async()=>({pickup_expiry_confirmed:invalid!=='unconfirmed',page:{state:invalid==='contact'?'PickupContact-init':'Fulfillment-init'},displayed_zip:invalid==='zip'?'00000':'07094'});
  f.b.workflow=async()=>{throw new Stop(invalid==='other-error'?'pickup_time_not_selected':'safari_step_timeout');};
  if(invalid)await assert.rejects(()=>f.b.prepare({product_url:url},()=>{}));
  else assert.equal(await f.b.prepare({product_url:url},()=>{}),'pickup_expired');
 }
});
test('expired pickup restore rechecks inventory before touching page',async()=>{
 const f=fixture({pickup_zip:'07094'});await f.b.start();let navigated=0;
 f.b.window.call=async()=>({pickup_expiry_confirmed:false});f.b.window.goto=async()=>navigated++;
 await assert.rejects(()=>f.b.restoreExpiredPickup(),e=>e.code==='pickup_expiry_no_longer_confirmed');assert.equal(navigated,0);
});

test('confirmed expired stock reuses pickup page without reload, navigation or reseeding',async()=>{
 const f=fixture({pickup_zip:'07094'});await f.b.start();const calls=[];
 f.b.window.call=async(op,args)=>{calls.push({op,args});return {rearmed:true,ready:true,protected:false,expired:false,pickup_selected:true};};
 f.b.window.goto=async()=>{throw Error('must not navigate');};f.b.seedIdle=async()=>{throw Error('must not seed');};
 assert.equal((await f.b.restoreExpiredPickup()).status,'standby_checkout');
 assert.deepEqual(calls.map(c=>c.op),['rearmExpiredPickupStandby']);assert.equal(calls[0].args.zip,'07094');
});

test('per-profile cancellation prevents later workflow actions after an awaited operation returns',async()=>{
 const f=fixture({per_profile_requests:true,global_lock_timeout_seconds:60});await f.b.start();f.b.ensurePage=async()=>{};let later=0;
 f.b.window.call=async()=>{f.b.abortEventId='cancel-me';return {};};
 f.b.workflow=async w=>{await w.call('test-slow-step');later++;return {status:'awaiting_user'};};
 await assert.rejects(()=>f.b.prepare({event_id:'cancel-me',product_url:url,detected_at:new Date().toISOString()},()=>{}),e=>e.code==='pickup_task_deadline');
 assert.equal(later,0);assert.equal(f.b.stalledProfilePending,true);
});
