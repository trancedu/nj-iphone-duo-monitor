import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {handoffActivity} from '../safari/idle.mjs';
import {Engine} from '../engine.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate as turn} from 'node:timers/promises';
async function pageFixture(t){
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:new URL(r.request().url()).pathname==='/shop/bag'?'<h1>Your bag is empty.</h1>':'<h1>Now fill out your pickup information.</h1><label>First Name<input></label><button id="co-options-applePay">Continue with Apple Pay</button><button id="other">Other</button>'}));
 await page.goto('https://www.apple.com/details');
 await page.evaluate(()=>{let tick=0;Object.defineProperty(performance,'now',{value:()=>tick});window.advanceIdleTestClock=ms=>{tick+=ms;};});
 return {page,call:(op,args={})=>page.evaluate(handoffActivity,{op,args:{event_id:'idle-test',...args}}),advance:ms=>page.evaluate(ms=>window.advanceIdleTestClock(ms),ms)};
}
test('ten-minute tracker reuses state, and synthetic DOM input cannot reset it',async t=>{
 const f=await pageFixture(t);assert.equal((await f.call('armIdle')).status,'tracking');await f.advance(601000);
 await f.page.getByRole('textbox').evaluate(e=>e.dispatchEvent(new Event('input',{bubbles:true})));
 assert.equal((await f.call('armIdle')).idle_ms,601000);assert.equal((await f.call('idleState',{event_id:'other-event'})).status,'wrong_event');
});
test('trusted click, typing and wheel interaction reset the idle clock',async t=>{
 const f=await pageFixture(t);await f.call('armIdle');await f.advance(599000);await f.page.getByRole('button',{name:'Other',exact:true}).click();assert.equal((await f.call('idleState')).idle_ms,0);
 await f.advance(599000);await f.page.getByRole('textbox').fill('Test');assert.equal((await f.call('idleState')).idle_ms,0);
 await f.advance(599000);await f.page.mouse.wheel(0,100);await f.page.waitForFunction(()=>window.__iphoneDuoHandoffActivityV1.read().idle_ms===0);assert.equal((await f.call('idleState')).idle_ms,0);
});
test('atomic idle claim refuses recent user activity and navigates only after expiry',async t=>{
 const f=await pageFixture(t);await f.call('armIdle');await f.advance(599999);assert.equal((await f.call('claimIdleReturn',{timeout_ms:600000})).claimed,false);await f.advance(2);
 const navigation=f.page.waitForURL('https://www.apple.com/shop/bag');await f.call('claimIdleReturn',{timeout_ms:600000}).catch(e=>{if(!e.message.includes('Execution context was destroyed'))throw e;});await navigation;assert.equal(new URL(f.page.url()).pathname,'/shop/bag');
});
test('user starting Apple Pay suspends idle return, even far beyond ten minutes',async t=>{
 const f=await pageFixture(t);await f.call('armIdle');await f.page.getByRole('button',{name:'Continue with Apple Pay',exact:true}).click();await f.advance(3600000);assert.equal((await f.call('idleState')).status,'payment_started');assert.equal((await f.call('claimIdleReturn',{timeout_ms:600000})).claimed,false);assert.equal(new URL(f.page.url()).pathname,'/details');
});
test('a changed page never arms or returns an old handoff',async t=>{
 const f=await pageFixture(t);await f.page.setContent('<h1>Order complete</h1>');assert.equal((await f.call('armIdle')).status,'page_changed');assert.equal((await f.call('claimIdleReturn',{timeout_ms:600000})).claimed,false);
});
function engineFixture(t,overrides={}){
 const root=mkdtempSync(join(tmpdir(),'idle-engine-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const calls=[];let state={status:'tracking',idle_ms:600001,last_activity_at:'2026-10-26T20:00:00Z'};
 const browser={ready:()=>true,inspectIdle:async()=>state,returnIfIdle:async()=>{calls.push('claim');return {claimed:true};},seedIdle:async()=>{calls.push('seed');},notifyIdleReturn:async()=>{calls.push('notify');},prepare:async()=>{calls.push('next');return 'awaiting_user';},handoff:async()=>{},...overrides};
 const engine=new Engine({state_dir:root,dry_run:false,queue_while_busy:true,handoff_idle_timeout_seconds:600},browser);
 const item={event_id:'current',product_url:'https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked',status:'awaiting_user',timestamps:{}};engine.state.active='current';engine.state.events.current=item;engine.save();return {engine,browser,calls,item,setState:s=>{state=s;}};
}
test('idle task restores and notifies before releasing its held queue',async t=>{
 const f=engineFixture(t);f.engine.accept({event_id:'next',product_url:f.item.product_url,detected_at:new Date().toISOString()});assert.equal(await f.engine.watchIdle(1000),true);await turn();await turn();assert.deepEqual(f.calls,['claim','seed','notify','next']);assert.equal(f.item.status,'idle_timeout_returned');assert.equal(f.item.release_reason,'handoff_idle_timeout');assert.equal(f.engine.state.active,'next');
});
test('activity or payment state prevents idle claim and preserves lock',async t=>{
 for(const state of [{status:'tracking',idle_ms:599999},{status:'payment_started',idle_ms:999999},{status:'page_changed'},{status:'wrong_event'}]){const f=engineFixture(t);f.setState(state);assert.equal(await f.engine.watchIdle(1000),false);assert.deepEqual(f.calls,[]);assert.equal(f.engine.state.active,'current');}
});
test('activity between initial check and atomic claim cancels release',async t=>{
 const f=engineFixture(t,{returnIfIdle:async()=>({claimed:false,status:'tracking'})});assert.equal(await f.engine.watchIdle(1000),false);assert.deepEqual(f.calls,[]);assert.equal(f.engine.state.active,'current');
});
test('restore failure after idle claim retains task and queue for review',async t=>{
 const f=engineFixture(t,{seedIdle:async()=>{throw Error();}});assert.equal(await f.engine.watchIdle(1000),false);assert.equal(f.engine.state.active,'current');assert.equal(f.item.status,'manual_review');assert.equal(f.item.reason,'idle_restore_failed');
});
test('a concurrently released task cannot be claimed by a stale idle observation',async t=>{
 const f=engineFixture(t);f.browser.inspectIdle=async()=>{f.engine.state.active=null;return {status:'tracking',idle_ms:999999};};assert.equal(await f.engine.watchIdle(1000),false);assert.deepEqual(f.calls,[]);
});
test('notification failure after verified idle restore still releases the lock',async t=>{
 const f=engineFixture(t,{notifyIdleReturn:async()=>{throw Error();}});assert.equal(await f.engine.watchIdle(1000),true);assert.equal(f.engine.state.active,null);assert.equal(f.item.idle_feedback.notification_submitted,false);
});
test('trusted mouse movement within the handoff page counts as user activity',async t=>{
 const f=await pageFixture(t);await f.call('armIdle');await f.advance(599000);await f.page.mouse.move(30,30);assert.equal((await f.call('idleState')).idle_ms,0);
});
