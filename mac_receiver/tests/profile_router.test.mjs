import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Engine} from '../engine.mjs';
import {ProfileRouter} from '../profile_router.mjs';
import {createReceiver} from '../server.mjs';
import {DUO_VARIANTS} from '../variant_bag.mjs';

const aliases=['256gb-burgundy','256gb-glacier','256gb-glacier','512gb-glacier'].map(s=>'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-'+s+'-unlocked');
function harness(t,exclusive=false){
  const root=mkdtempSync(join(tmpdir(),'profile-router-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const calls=[];
  const slots=DUO_VARIANTS.map((url,i)=>{const label='ABCD'[i],browser={ready:()=>true,prepare:async e=>{calls.push({label,url:e.product_url});return 'awaiting_user';},handoff:async()=>{}};const engine=new Engine({state_dir:join(root,label),dry_run:false,queue_while_busy:true},browser);return {label,product_url:url,aliases:[aliases[i]],browser,engine};});
  const config={dry_run:false,single_active_request:exclusive,state_dir:join(root,'router')};
  return {router:new ProfileRouter(config,slots),slots,calls,config};
}
const event=(id,url)=>({event_id:id,product_url:url,detected_at:new Date().toISOString()});
test('recent fallback chooses latest within ten seconds; a new arrival wins the dispatch grace period',async t=>{
  const h=harness(t,true);Object.assign(h.config,{drop_busy_events:false,recent_request_ttl_seconds:10,release_global_on_unavailable:true});
  h.router.accept(event('first',DUO_VARIANTS[0]));await nextTurn();await nextTurn();
  assert.equal(h.router.accept(event('older',DUO_VARIANTS[1])).body.status,'held');
  assert.equal(h.router.accept(event('latest',DUO_VARIANTS[2])).body.status,'held');
  const older=h.slots[1].engine.state.events.older,latest=h.slots[2].engine.state.events.latest;
  older.timestamps.received_at=new Date(Date.now()-2000).toISOString();latest.timestamps.received_at=new Date(Date.now()-1000).toISOString();
  h.slots[0].engine.reset('first');h.slots[0].engine.onUnavailableReleased('first');
  assert.equal(h.router.dispatchWaiting(),false);
  assert.equal(h.router.accept(event('brand-new',DUO_VARIANTS[3])).code,202);
  assert.equal(h.router.dispatchWaiting(Date.now()+1000),false);
  await nextTurn();await nextTurn();assert.deepEqual(h.calls.map(c=>c.label),['A','D']);
  h.slots[3].engine.reset('brand-new');h.slots[3].engine.onUnavailableReleased('brand-new');
  assert.equal(h.router.dispatchWaiting(Date.now()+600),true);await nextTurn();await nextTurn();
  assert.deepEqual(h.calls.map(c=>c.label),['A','D','C']);assert.equal(older.status,'global_waiting');
});
test('stale fallback expires and duplicate held ID never extends its lifetime',async t=>{
  const h=harness(t,true);h.config.drop_busy_events=false;h.config.recent_request_ttl_seconds=10;
  h.router.accept(event('owner',DUO_VARIANTS[0]));await nextTurn();await nextTurn();
  const pending=event('waiting',DUO_VARIANTS[1]);h.router.accept(pending);
  const item=h.slots[1].engine.state.events.waiting,at=item.timestamps.received_at;
  assert.equal(h.router.accept(pending).code,200);assert.equal(item.timestamps.received_at,at);
  assert.equal(h.router.accept({...pending,product_url:DUO_VARIANTS[2]}).code,409);
  h.router.expireWaiting(Date.parse(at)+10001);assert.equal(item.status,'expired');
  h.slots[0].engine.reset('owner');await h.router.reset('owner');assert.equal(h.router.dispatchWaiting(),false);
  assert.deepEqual(h.calls.map(c=>c.label),['A']);
});
for(const status of ['running','manual_review','awaiting_user'])test(`available stock protects ${status} from sixty-second expiry`,async t=>{
  const h=harness(t,true);h.config.global_lock_timeout_seconds=60;
  h.router.accept(event('available',DUO_VARIANTS[0]));await nextTurn();await nextTurn();
  const item=h.slots[0].engine.state.events.available;item.status=status;item.timestamps.pickup_stock_found_at=new Date().toISOString();
  let count=0;h.router.onGlobalTimeout=async()=>count++;
  assert.equal(await h.router.watchGlobalTimeout(Date.parse(h.router.globalLock.claimed_at)+900000),false);
  assert.equal(count,0);assert.equal(h.router.health().stock_page_protected,true);
});
for(const status of ['running','manual_review','awaiting_user'])test(`hard deadline expires ${status} at sixty seconds even after stock found`,async t=>{
  const h=harness(t,true);Object.assign(h.config,{global_lock_timeout_seconds:60,protect_stock_from_timeout:false});
  h.router.accept(event('available',DUO_VARIANTS[0]));await nextTurn();await nextTurn();
  const item=h.slots[0].engine.state.events.available;item.status=status;item.timestamps.pickup_stock_found_at=new Date().toISOString();
  let count=0;h.router.onGlobalTimeout=async()=>count++;
  const at=Date.parse(h.router.globalLock.claimed_at);
  assert.equal(await h.router.watchGlobalTimeout(at+59999),false);
  assert.equal(await h.router.watchGlobalTimeout(at+60000),true);
  assert.equal(count,1);assert.equal(h.router.health().stock_page_protected,false);
});
for(const fails of [false,true])test(`unavailable releases global only after successful bag restore (restore fails=${fails})`,async t=>{
  const h=harness(t,true);h.config.release_global_on_unavailable=true;
  const slot=h.slots[0];slot.engine.config.auto_release_unavailable=true;
  slot.browser.prepare=async()=>{throw new (await import('../protocol.mjs')).Stop('pickup_unavailable');};
  let restored;slot.browser.seedIdle=()=>new Promise((resolve,reject)=>{restored=()=>fails?reject(Error('failed')):resolve();});
  h.router.accept(event('sold-out',DUO_VARIANTS[0]));await nextTurn();await nextTurn();
  assert.equal(h.router.health().global_locked,true);
  assert.equal(h.router.accept(event('blocked',DUO_VARIANTS[1])).code,409);
  restored();await nextTurn();await nextTurn();
  assert.equal(h.router.health().global_locked,fails);
  assert.equal(slot.engine.state.active,fails?'sold-out':null);
  assert.equal(h.slots[1].engine.state.events.blocked.status,'busy');
  if(!fails){assert.equal(h.router.accept(event('fresh',DUO_VARIANTS[1])).code,202);await nextTurn();await nextTurn();}
});
test('exact URL routing keeps duplicate aliases on first matching profile',async t=>{
  const h=harness(t);
  assert.equal(h.router.slotForURL(aliases[0]).label,'A');assert.equal(h.router.slotForURL(aliases[1]).label,'B');assert.equal(h.router.slotForURL(aliases[3]).label,'D');
  for(let i=0;i<4;i++)assert.equal(h.router.slotForURL(DUO_VARIANTS[i]).label,'ABCD'[i]);
  const r=h.router.accept(event('alias-test',aliases[1]));assert.equal(r.body.profile_label,'B');
  await nextTurn();await nextTurn();assert.deepEqual(h.calls,[{label:'B',url:aliases[1]}]);
});
test('one profile lock holds its next event while other profile can execute independently',async t=>{
  const h=harness(t);
  h.router.accept(event('A-first',aliases[0]));h.router.accept(event('B-first',aliases[1]));await nextTurn();await nextTurn();
  assert.equal(h.router.accept(event('A-second',aliases[0])).body.status,'held');
  assert.equal(h.calls.length,2);assert.equal(h.slots[0].engine.state.active,'A-first');assert.equal(h.slots[1].engine.state.active,'B-first');
  h.router.reset('A-first');await nextTurn();await nextTurn();assert.equal(h.calls.length,3);assert.equal(h.slots[0].engine.state.active,'A-second');
});
test('same event ID cannot jump profiles by changing URL, and unknown URL is rejected',async t=>{
  const h=harness(t);const e=event('fixed-id',aliases[0]);h.router.accept(e);await nextTurn();await nextTurn();
  assert.equal(h.router.accept(e).code,200);assert.equal(h.router.accept({...e,product_url:aliases[3]}).body.status,'event_id_conflict');
  assert.throws(()=>h.router.accept(event('unknown','https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-1tb-silver-unlocked')),e=>e.code==='unsupported_product_url');
  assert.equal(h.calls.length,1);assert.equal(h.router.public(h.router.state.events['fixed-id']).profile_label,'A');
});
test('global first-arrival lock blocks other profiles without preparing or queuing them',async t=>{
  const h=harness(t,true),first=event('global-first',DUO_VARIANTS[0]);
  await h.router.beforeAccept(first);assert.equal(h.router.accept(first).code,202);
  for(let i=1;i<4;i++){
    const later=event('later-'+i,DUO_VARIANTS[i]);let inspected=0;
    h.slots[i].browser.ensurePage=async()=>inspected++;
    await h.router.beforeAccept(later);const result=h.router.accept(later);
    assert.equal(result.code,409);assert.equal(result.body.status,'busy');assert.equal(inspected,0);
    assert.equal(h.slots[i].engine.state.events['later-'+i].status,'busy');
  }
  await nextTurn();await nextTurn();assert.equal(h.calls.length,1);
  assert.equal(h.router.accept(first).code,200);assert.equal(h.calls.length,1);
});
test('global reservation wins before asynchronous browser readiness completes',async t=>{
  const h=harness(t,true);let finish,ready=false;
  h.slots[0].browser.ready=()=>ready;
  h.slots[0].browser.ensurePage=()=>new Promise(resolve=>{finish=()=>{ready=true;resolve();};});
  const first=event('slow-first',DUO_VARIANTS[0]),later=event('fast-later',DUO_VARIANTS[1]);
  const checking=h.router.beforeAccept(first);
  await h.router.beforeAccept(later);assert.equal(h.router.accept(later).code,409);
  finish();await checking;assert.equal(h.router.accept(first).code,202);
  await nextTurn();await nextTurn();assert.deepEqual(h.calls.map(c=>c.label),['A']);
});
test('global lock survives engine completion and router restart until explicit reset',async t=>{
  const h=harness(t,true),first=event('sticky-first',DUO_VARIANTS[0]);
  h.router.accept(first);await nextTurn();await nextTurn();
  h.slots[0].engine.reset(first.event_id); // Even a per-profile automatic release cannot admit another.
  const restarted=new ProfileRouter(h.config,h.slots);
  assert.equal(restarted.health().global_locked,true);
  assert.equal(restarted.accept(event('later',DUO_VARIANTS[1])).code,409);
  assert.equal(await restarted.reset(first.event_id),true);
  assert.equal(restarted.health().global_locked,false);
  assert.equal(restarted.accept(event('new-after-unlock',DUO_VARIANTS[1])).code,202);
  await nextTurn();await nextTurn();assert.equal(h.calls.length,2);
});
test('global admission releases reservation when the first new request is rejected',async t=>{
  const h=harness(t,true);h.slots[0].browser.ready=()=>false;
  h.slots[0].engine.config.queue_when_browser_not_ready=false;
  assert.equal(h.router.accept(event('not-ready',DUO_VARIANTS[0])).code,503);
  assert.equal(h.router.health().global_locked,false);
  assert.equal(h.router.accept(event('ready-next',DUO_VARIANTS[1])).code,202);
  await nextTurn();await nextTurn();assert.deepEqual(h.calls.map(c=>c.label),['B']);
});
test('four simultaneous HTTP requests execute only the first; later polls never release it',async t=>{
  const h=harness(t,true),secret='test-global-lock-secret-at-least-32-characters';
  const {server}=createReceiver({allowed_sources:['127.0.0.1'],dry_run:false},{ready:()=>true},secret,h.router);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const responses=await Promise.all(DUO_VARIANTS.map(async(url,i)=>{
    const response=await fetch(base+'/prepare',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(event('http-'+i,url))});
    return {code:response.status,body:await response.json()};
  }));
  assert.equal(responses.filter(r=>r.code===202).length,1);
  assert.equal(responses.filter(r=>r.code===409&&r.body.reason==='busy_event_dropped').length,3);
  await nextTurn();await nextTurn();assert.equal(h.calls.length,1);
  h.router.expireHeld();assert.equal(h.router.health().global_locked,true);
  assert.equal(h.slots.reduce((n,s)=>n+Object.values(s.engine.state.events).filter(e=>e.status==='held').length,0),0);
});
test('global timeout starts at first claim, waits sixty seconds, and launches only one unlock',async t=>{
  const h=harness(t,true);h.config.global_lock_timeout_seconds=60;
  const first=event('timed-first',DUO_VARIANTS[0]);h.router.accept(first);
  await nextTurn();await nextTurn();const start=Date.parse(h.router.globalLock.claimed_at);
  h.slots[0].engine.state.events[first.event_id].status='pickup_unavailable';
  let calls=0,finish;h.router.onGlobalTimeout=id=>{assert.equal(id,first.event_id);calls++;return new Promise(resolve=>{finish=resolve;});};
  assert.equal(await h.router.watchGlobalTimeout(start+59999),false);assert.equal(calls,0);
  const running=h.router.watchGlobalTimeout(start+60000);
  assert.equal(calls,1);assert.equal(await h.router.watchGlobalTimeout(start+61000),false);
  h.router.globalLock={event_id:null};h.router.saveGlobal();finish();assert.equal(await running,true);
  assert.equal(await h.router.watchGlobalTimeout(start+120000),false);assert.equal(calls,1);
  assert.equal(h.calls.length,1); // No additional browser task is dispatched.
});
test('restart retains the original timeout deadline, including manual-review locks',async t=>{
  const h=harness(t,true);h.config.global_lock_timeout_seconds=60;
  h.router.accept(event('old-error',DUO_VARIANTS[0]));await nextTurn();await nextTurn();
  const start=Date.parse(h.router.globalLock.claimed_at);let expired;
  h.slots[0].engine.state.events['old-error'].status='manual_review';
  const restarted=new ProfileRouter(h.config,h.slots,{onGlobalTimeout:async id=>{expired=id;}});
  assert.equal(await restarted.watchGlobalTimeout(start+60000),true);assert.equal(expired,'old-error');
  assert.equal(restarted.health().global_lock_timeout_seconds,60);
});
test('an unlock helper failure backs off rather than launching a process every second',async t=>{
  const h=harness(t,true);h.config.global_lock_timeout_seconds=60;h.router.accept(event('helper-failed',DUO_VARIANTS[0]));
  await nextTurn();await nextTurn();const due=Date.parse(h.router.globalLock.claimed_at)+60000;let calls=0;
  h.slots[0].engine.state.events['helper-failed'].status='manual_review';
  h.router.onGlobalTimeout=async()=>{calls++;throw Error('helper unavailable');};
  assert.equal(await h.router.watchGlobalTimeout(due),false);
  assert.equal(await h.router.watchGlobalTimeout(due+1000),false);assert.equal(calls,1);
  assert.equal(await h.router.watchGlobalTimeout(due+30000),false);assert.equal(calls,2);
});
for(const backend of ['chrome','safari'])test(`${backend} applies the same first-arrival exclusion and sixty-second deadline`,async t=>{
  const h=harness(t,true);Object.assign(h.config,{browser_backend:backend,global_lock_timeout_seconds:60});
  const first=event('shared-'+backend,DUO_VARIANTS[2]),later=event('blocked-'+backend,DUO_VARIANTS[3]);
  await h.router.beforeAccept(first);assert.equal(h.router.accept(first).code,202);
  await h.router.beforeAccept(later);assert.equal(h.router.accept(later).code,409);
  await nextTurn();await nextTurn();assert.deepEqual(h.calls.map(c=>c.label),['C']);
  h.slots[2].engine.state.events[first.event_id].status='pickup_unavailable';
  let timedOut;h.router.onGlobalTimeout=async id=>{timedOut=id;};const start=Date.parse(h.router.globalLock.claimed_at);
  assert.equal(await h.router.watchGlobalTimeout(start+59999),false);
  assert.equal(await h.router.watchGlobalTimeout(start+60000),true);assert.equal(timedOut,first.event_id);
  assert.equal(h.slots[3].browser.requestReservations||0,0);
});

test('strict first arrival drops busy events permanently even with old candidate TTL configured',async t=>{
  const h=harness(t,true);h.config.recent_request_ttl_seconds=10;
  const first=event('owner',DUO_VARIANTS[0]),later=event('discarded',DUO_VARIANTS[1]);
  h.router.accept(first);await nextTurn();await nextTurn();
  assert.equal(h.router.accept(later).body.status,'busy');
  assert.equal(h.router.waiting().length,0);assert.equal(h.router.health().busy_event_policy,'drop');
  assert.equal(h.router.health().recent_request_ttl_seconds,0);
  h.slots[0].engine.reset('owner');await h.router.reset('owner');
  assert.equal(h.router.dispatchWaiting(Date.now()+1000),false);
  assert.equal(h.router.accept(later).body.status,'busy');
  await nextTurn();assert.deepEqual(h.calls.map(c=>c.label),['A']);
  assert.equal(h.router.accept(event('new-after-free',DUO_VARIANTS[2])).code,202);
  await nextTurn();await nextTurn();assert.deepEqual(h.calls.map(c=>c.label),['A','C']);
});
