import test from 'node:test';
import assert from 'node:assert/strict';
import {waitFor,appleScript,MAX_PICKUP_STEP_MS} from '../safari/shopping.mjs';
test('configured step timeout above ten seconds is capped, including older twenty-second configs',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 assert.equal(MAX_PICKUP_STEP_MS,10000);
 const waiting=waitFor(async()=>false,20000,100);
 const checked=assert.rejects(waiting,e=>e.code==='safari_step_timeout');
 await Promise.resolve();await Promise.resolve();t.mock.timers.tick(10000);await checked;
});
test('nested waits cannot restart the current step deadline',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const outer=waitFor(async()=>waitFor(async()=>false,20000,10),100,10);
 const checked=assert.rejects(outer,e=>e.code==='safari_step_timeout');
 await Promise.resolve();await Promise.resolve();t.mock.timers.tick(100);await checked;
});
test('AppleScript bridge is terminated at remaining step budget rather than another ten seconds',async()=>{
 const start=Date.now();
 await assert.rejects(()=>waitFor(()=>appleScript('delay 2\nreturn "late"'),100),e=>e.code==='safari_step_timeout');
 assert.ok(Date.now()-start<1000);
});
