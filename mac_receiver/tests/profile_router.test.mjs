import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Engine} from '../engine.mjs';
import {ProfileRouter} from '../profile_router.mjs';
import {DUO_VARIANTS} from '../variant_bag.mjs';

const aliases=['256gb-burgundy','256gb-glacier','256gb-glacier','512gb-glacier'].map(s=>'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-'+s+'-unlocked');
function harness(t){
  const root=mkdtempSync(join(tmpdir(),'profile-router-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const calls=[];
  const slots=DUO_VARIANTS.map((url,i)=>{const label='ABCD'[i],browser={ready:()=>true,prepare:async e=>{calls.push({label,url:e.product_url});return 'awaiting_user';},handoff:async()=>{}};const engine=new Engine({state_dir:join(root,label),dry_run:false,queue_while_busy:true},browser);return {label,product_url:url,aliases:[aliases[i]],browser,engine};});
  return {router:new ProfileRouter({dry_run:false},slots),slots,calls};
}
const event=(id,url)=>({event_id:id,product_url:url,detected_at:new Date().toISOString()});
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
