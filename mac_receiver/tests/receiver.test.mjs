import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createReceiver} from '../server.mjs';
import {Engine} from '../engine.mjs';
import {Stop,productURL,expectedProduct,validateEvent} from '../protocol.mjs';
const SECRET='test-only-not-production-'.repeat(3);
const URL='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked';
const event=(id='event-one')=>({event_id:id,detected_at:'2026-10-26T12:00:00Z',product_url:URL});
async function harness(t,dry=true,browser={ready:()=>true,handoff:async()=>{}}) {
  const dir=mkdtempSync(join(tmpdir(),'pickup-api-test-'));
  const config={state_dir:dir,allowed_sources:['127.0.0.1'],dry_run:dry};
  const {server,engine}=createReceiver(config,browser,SECRET);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(ok=>server.close(ok));rmSync(dir,{recursive:true,force:true});});
  const request=async(path,body,auth=SECRET)=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body?'POST':'GET',
      headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {code:r.status,body:await r.json()};
  };
  return {request,engine,config,dir};
}
test('strict product URL validation rejects credentials, ports, query tokens and other hosts',()=>{
  assert.equal(productURL(URL),URL);
  for(const u of ['http://www.apple.com/shop/buy-iphone/a/b',URL+'?token=secret',URL+'#x',URL.replace('www.apple.com','www.apple.com.evil.test'),URL.replace('www.apple.com','user:pass@www.apple.com'),URL.replace('.com','.com:1234'),URL.replace('iphone-duo/','iphone-duo/%2e%2e/')]) assert.throws(()=>productURL(u));
  assert.equal(expectedProduct(URL),'iPhone Duo 256GB Star White');
  assert.equal(expectedProduct('https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-black-unlocked'),'iPhone 18 Pro Max 256GB Black');
});
test('dry run authenticates, persists deduplication, and never calls browser',async t=>{
  let calls=0;
  const h=await harness(t,true,{ready:()=>false,prepare:async()=>calls++,handoff:async()=>calls++});
  assert.equal((await h.request('/health',null,'bad')).code,401);
  assert.equal((await h.request('/health')).body.mode,'dry_run');
  const a=await h.request('/prepare',event());assert.equal(a.code,202);
  await nextTurn();await nextTurn();
  const b=await h.request('/prepare',event());assert.equal(b.code,200);assert.equal(b.body.status,'dry_run_completed');
  assert.equal((await h.request('/status/event-one')).body.status,'dry_run_completed');
  assert.equal(calls,0);
  const restarted=new Engine(h.config,{ready:()=>true});
  assert.equal(restarted.accept(validateEvent(event())).body.status,'dry_run_completed');
  assert.equal((await h.request('/prepare',{...event(),product_url:URL.replace('256gb','512gb')})).code,409);
  assert.equal((await h.request('/prepare',{...event('bad-url'),product_url:'https://evil.test/'})).code,400);
});
test('one live task, duplicate safe, busy and handoff lock survive restart',async t=>{
  let calls=0,release;
  const pending=new Promise(ok=>release=ok);
  const h=await harness(t,false,{ready:()=>true,prepare:async(e,stage)=>{calls++;stage('opened_at');await pending;stage('handoff_at');return 'awaiting_user';},handoff:async()=>{}});
  assert.equal((await h.request('/prepare',event())).code,202);await nextTurn();
  assert.equal((await h.request('/prepare',event())).code,200);
  assert.equal((await h.request('/prepare',event('other'))).body.status,'busy');
  assert.equal((await h.request('/reset',{event_id:'event-one',confirm:true})).code,409);
  release();await nextTurn();await nextTurn();
  assert.equal((await h.request('/status/event-one')).body.status,'awaiting_user');assert.equal(calls,1);
  const restarted=new Engine(h.config,{ready:()=>true});assert.equal(restarted.state.active,'event-one');
  assert.equal(restarted.accept(validateEvent(event('after-restart'))).body.status,'busy');
  assert.equal((await h.request('/reset',{event_id:'event-one',confirm:true})).body.status,'reset');
});
test('live exceptions preserve page, lock, and emit sanitized reason',async t=>{
  let handoffs=0;
  const h=await harness(t,false,{ready:()=>true,prepare:async()=>{throw new Error('COOKIE SECRET PRIVATE PAGE');},handoff:async()=>handoffs++});
  await h.request('/prepare',event());await nextTurn();await nextTurn();
  const result=await h.request('/status/event-one');assert.equal(result.body.status,'manual_review');assert.equal(result.body.reason,'browser_error');
  assert.equal(handoffs,1);assert.equal((await h.request('/prepare',event('next'))).body.status,'busy');
  assert(!readFileSync(join(h.dir,'events.jsonl'),'utf8').includes('COOKIE SECRET'));
});
test('source restriction, body limit, and prototype-like event IDs',async t=>{
  const h=await harness(t);
  h.engine.config.allowed_sources=[]; // createReceiver snapshots its allowlist; test a second receiver below.
  assert.equal((await h.request('/prepare',event('__proto__'))).code,202);await nextTurn();
  assert.equal((await h.request('/status/__proto__')).body.status,'dry_run_completed');
  const response=await h.request('/prepare',{...event('large'),unused:'x'.repeat(9000)});assert.equal(response.code,413);
  const denied=createReceiver({...h.config,allowed_sources:['192.168.1.99']},{ready:()=>false},SECRET);
  denied.server.listen(0,'127.0.0.1');await once(denied.server,'listening');
  const r=await fetch(`http://127.0.0.1:${denied.server.address().port}/health`,{headers:{Authorization:`Bearer ${SECRET}`}});assert.equal(r.status,403);
  await new Promise(ok=>denied.server.close(ok));
});
test('in-flight restart becomes interrupted and never resumes browser work',async t=>{
  const h=await harness(t,true);const e=validateEvent(event());h.engine.accept(e);
  const restarted=new Engine(h.config,{ready:()=>true});assert.equal(restarted.state.events[e.event_id].status,'interrupted');assert.equal(restarted.state.active,e.event_id);
  await nextTurn();
});
test('hold queue is durable, deduplicated, bounded and runs only after release',async t=>{
  const calls=[];
  const h=await harness(t,false,{ready:()=>true,prepare:async e=>{calls.push(e.event_id);return 'awaiting_user';},handoff:async()=>{}});
  Object.assign(h.config,{queue_while_busy:true,max_pending_events:1});
  await h.request('/prepare',event());await nextTurn();await nextTurn();
  const next={...event('held-two'),detected_at:new Date().toISOString()};
  assert.equal((await h.request('/prepare',next)).body.status,'held');
  assert.equal((await h.request('/prepare',next)).code,200);
  assert.equal((await h.request('/prepare',{...next,event_id:'overflow'})).code,429);
  assert.deepEqual(calls,['event-one']);
  await h.request('/reset',{event_id:'event-one',confirm:true});await nextTurn();await nextTurn();
  assert.deepEqual(calls,['event-one','held-two']);assert.equal(h.engine.state.active,'held-two');
});
test('expired held events and held events surviving restart never execute',async t=>{
  const calls=[];
  const h=await harness(t,false,{ready:()=>true,prepare:async e=>{calls.push(e.event_id);return 'awaiting_user';},handoff:async()=>{}});
  h.config.queue_while_busy=true;
  await h.request('/prepare',event());await nextTurn();await nextTurn();
  await h.request('/prepare',{...event('stale-held'),detected_at:new Date(Date.now()-200000).toISOString()});
  assert.equal((await h.request('/status/stale-held')).body.status,'expired');
  await h.request('/prepare',{...event('fresh-held'),detected_at:new Date().toISOString()});
  const restarted=new Engine(h.config,{ready:()=>true});
  assert.equal(restarted.state.events['fresh-held'].status,'expired');assert.equal(restarted.state.active,'event-one');
  assert.deepEqual(calls,['event-one']);
});
test('closing only the completed task tab releases held work; disconnect preserves lock',async t=>{
  const calls=[],oldPage={id:'task'};
  let connected=true;
  const browser={page:oldPage,ready:()=>connected,ensurePage:async()=>{if(!connected)throw new Stop('browser_not_ready');browser.page={id:'next'};},prepare:async e=>{calls.push(e.event_id);return 'awaiting_user';},handoff:async()=>{}};
  const h=await harness(t,false,browser);Object.assign(h.config,{queue_while_busy:true,release_on_task_tab_close:true});
  await h.request('/prepare',event());await nextTurn();await nextTurn();
  await h.request('/prepare',{...event('held-two'),detected_at:new Date().toISOString()});
  await h.engine.tabClosed({id:'unrelated'});assert.equal(h.engine.state.active,'event-one');
  connected=false;await assert.rejects(()=>h.engine.tabClosed(oldPage));assert.equal(h.engine.state.active,'event-one');
  connected=true;await h.engine.tabClosed(oldPage);await nextTurn();await nextTurn();
  assert.deepEqual(calls,['event-one','held-two']);assert.equal(h.engine.state.active,'held-two');
});
test('incoming event recreates an idle closed work tab without releasing an active task',async t=>{
  let ready=false,created=0,prepared=0;
  const browser={ready:()=>ready,ensurePage:async()=>{created++;ready=true;},prepare:async()=>{prepared++;return 'awaiting_user';},handoff:async()=>{}};
  const h=await harness(t,false,browser);
  assert.equal((await h.request('/prepare',event())).code,202);await nextTurn();await nextTurn();
  assert.equal(created,1);assert.equal(prepared,1);
  ready=false;
  assert.equal((await h.request('/prepare',event('another'))).body.status,'busy');
  assert.equal(created,1);assert.equal(h.engine.state.active,'event-one');
});
test('production sold-out outcome reseeds and releases, but seed failure preserves lock',async t=>{
  let seeds=0,fail=false;
  const browser={ready:()=>true,prepare:async()=>{throw new Stop('pickup_unavailable');},handoff:async()=>{},seedIdle:async()=>{seeds++;if(fail)throw Error('restore failed');}};
  const h=await harness(t,false,browser);h.config.auto_release_unavailable=true;
  await h.request('/prepare',event());await nextTurn();await nextTurn();assert.equal(seeds,1);assert.equal(h.engine.state.active,null);
  fail=true;await h.request('/prepare',event('failed-restore'));await nextTurn();await nextTurn();assert.equal(h.engine.state.active,'failed-restore');assert.equal(h.engine.state.events['failed-restore'].reason,'standby_restore_failed');
});
test('successful handoff stays locked without standby navigation even with auto release enabled',async t=>{
 let seeds=0,prepares=0;
 const browser={ready:()=>true,prepare:async(e,stage)=>{prepares++;stage('pickup_stock_found_at');stage('handoff_at');return 'awaiting_user';},handoff:async()=>{},seedIdle:async()=>{seeds++;}};
 const h=await harness(t,false,browser);Object.assign(h.config,{auto_release_unavailable:true,queue_while_busy:true});
 await h.request('/prepare',event());await nextTurn();await nextTurn();
 await h.request('/prepare',{...event('next-held'),detected_at:new Date().toISOString()});await nextTurn();
 assert.equal(h.engine.state.active,'event-one');assert.equal(h.engine.state.events['event-one'].status,'awaiting_user');assert.equal(h.engine.state.events['next-held'].status,'held');assert.equal(seeds,0);assert.equal(prepares,1);
});
test('an unavailable error after finding stock preserves page and lock for manual continuation',async t=>{
 let seeds=0;const browser={ready:()=>true,prepare:async(e,stage)=>{stage('pickup_stock_found_at');throw new Stop('pickup_unavailable');},handoff:async()=>{},seedIdle:async()=>{seeds++;}};
 const h=await harness(t,false,browser);h.config.auto_release_unavailable=true;
 await h.request('/prepare',event());await nextTurn();await nextTurn();assert.equal(h.engine.state.events['event-one'].status,'manual_review');assert.equal(h.engine.state.events['event-one'].reason,'pickup_unavailable_after_selection_preserved');assert.equal(h.engine.state.active,'event-one');assert.equal(seeds,0);
});
test('incoming signal announcement never delays preparation or repeats a duplicate/held request',async t=>{
 let announceDone,announcements=0,prepares=0;const browser={ready:()=>true,onEventStarted:()=>{announcements++;return new Promise(r=>{announceDone=r;});},prepare:async()=>{prepares++;return 'awaiting_user';},handoff:async()=>{}};
 const h=await harness(t,false,browser);h.config.queue_while_busy=true;const first=event();await h.request('/prepare',first);await nextTurn();await nextTurn();assert.equal(prepares,1);assert.equal(h.engine.state.events[first.event_id].status,'awaiting_user');await h.request('/prepare',first);await h.request('/prepare',event('held-signal'));assert.equal(announcements,1);announceDone({audio_queued:true});await nextTurn();
});

test('confirmed expired inventory after selection restores and releases immediately; uncertain failure keeps lock',async t=>{
 let restores=0,fail=false;
 const browser={ready:()=>true,prepare:async(e,stage)=>{stage('store_selected_at');stage('pickup_expired_confirmed_at');return 'pickup_expired';},handoff:async()=>{},restoreExpiredPickup:async()=>{restores++;if(fail)throw Error('stock returned');}};
 const h=await harness(t,false,browser);h.config.auto_release_unavailable=true;
 await h.request('/prepare',event());await nextTurn();await nextTurn();assert.equal(restores,1);assert.equal(h.engine.state.active,null);assert.equal(h.engine.state.events['event-one'].status,'pickup_expired');
 fail=true;await h.request('/prepare',event('changed-stock'));await nextTurn();await nextTurn();assert.equal(h.engine.state.active,'changed-stock');assert.equal(h.engine.state.events['changed-stock'].reason,'standby_restore_failed');
});
