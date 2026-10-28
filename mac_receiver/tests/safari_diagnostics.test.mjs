import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../engine.mjs';
import {sanitizeObservation,appendDiagnostic,classifyStores} from '../safari/diagnostics.mjs';
import {feedbackPlan} from '../safari/feedback.mjs';
const requested='Apple Garden State Plaza';
test('diagnostics distinguish missing, disabled, selectable and ambiguous target',()=>{
 assert.equal(classifyStores([{name:'Apple Other Available Tomorrow',enabled:true}],requested).verdict,'target_store_not_listed');
 const row={name:requested+'8.30 miCurrently unavailable',enabled:false};
 assert.equal(classifyStores([row],requested).verdict,'target_store_not_selectable');
 assert.equal(classifyStores([{...row,enabled:true}],requested).verdict,'target_store_selectable');
 assert.equal(classifyStores([row,{...row}],requested).verdict,'target_store_ambiguous');
});
test('diagnostic whitelist excludes contact, tokens, HTML, and full URLs',()=>{
 const o=sanitizeObservation({kind:'pickup_inventory',requested_store_name:requested,displayed_zip:'07094',configured_zip:'07094',page:{origin:'https://secure9.store.apple.com',path:'/shop/apw/checkout',state:'Fulfillment-init',url:'https://secure9.store.apple.com/?token=secret'},stores:[{name:requested,enabled:false,availability_text:'Available Tomorrow',email:'private@example.com'}],contact:{email:'private@example.com'},html:'<input value="secret">',secret:'super-secret'});
 const json=JSON.stringify(o);assert.ok(!json.includes('private@example.com'));assert.ok(!json.includes('super-secret'));assert.ok(!json.includes('token='));assert.ok(!json.includes('<input'));assert.equal(o.stores[0].availability_text,'Available Tomorrow');assert.equal(o.displayed_zip,'07094');
 assert.equal(sanitizeObservation({page:{state:'secretToken'},displayed_zip:'someone@example.com'}).page.state,null);
});
test('diagnostic records and rotated archives stay bounded and private',t=>{
 const root=mkdtempSync(join(tmpdir(),'safari-diag-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'diagnostics.jsonl');
 for(let i=0;i<4;i++)appendDiagnostic(file,{event_id:'e'+i},1);
 assert.equal(JSON.parse(readFileSync(file)).event_id,'e3');assert.equal(JSON.parse(readFileSync(file+'.1')).event_id,'e2');assert.equal(JSON.parse(readFileSync(file+'.2')).event_id,'e1');assert.equal(statSync(file).mode&0o777,0o600);
 const o=sanitizeObservation({stores:Array.from({length:100},()=>({name:'x'.repeat(1000)}))});assert.equal(o.stores.length,40);assert.equal(o.stores[0].name.length,200);
});
test('engine saves latest observation and separate per-event JSONL history',t=>{
 const root=mkdtempSync(join(tmpdir(),'safari-engine-diag-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const e=new Engine({state_dir:root,browser_backend:'safari',profile_label:'B'},{ready:()=>true});
 const item={event_id:'test-event',status:'running',store_name:requested,store_id:'R117',timestamps:{}};e.state.events[item.event_id]=item;
 for(const phase of ['initial','before_refresh'])e.stage(item,'pickup_inventory_observed_at',{kind:'pickup_inventory',phase,requested_store_name:requested,verdict:'target_store_not_listed',secret:'omitted'});
 const lines=readFileSync(join(root,'diagnostics.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(lines.length,2);assert.equal(lines[1].event_id,'test-event');assert.equal(e.public(item).diagnostic_count,2);assert.equal(e.public(item).last_observation.verdict,'target_store_not_listed');assert.ok(!JSON.stringify(lines).includes('omitted'));
});
test('notification identifies target-not-listed instead of claiming sold out',()=>{
 const p=feedbackPlan({status:'manual_review',reason:'target_store_not_listed'},{profile:'Duo256Black'});assert.ok(p.message.includes('库存尚未确认'));assert.ok(!p.message.includes('unknown'));
});

test('Guest diagnostics retain checkout steps and safe outcome fields without payment values',()=>{
 const o=sanitizeObservation({kind:'guest_submission',page:{origin:'https://secure6.store.apple.com',path:'/shop/checkout',state:'Review'},order_requested:true,response_unknown:true,payment_prepared:true,card_fields_written:false,operation:'guest_place_order',count:2,total_ms:123.456,card:'secret-card',cvv:'secret-cvv',contact:{email:'private@example.com'}});
 assert.equal(o.page.state,'Review');assert.equal(o.page.path,'/shop/checkout');assert.equal(o.order_requested,true);assert.equal(o.response_unknown,true);assert.equal(o.total_ms,123.46);
 assert.ok(!JSON.stringify(o).includes('secret'));assert.ok(!JSON.stringify(o).includes('private@'));
});
test('event trace keeps repeated stages, elapsed time, duplicate decisions and lock release',t=>{
 const root=mkdtempSync(join(tmpdir(),'trace-diag-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const e=new Engine({state_dir:root,checkout_method:'guest_credit'},{ready:()=>true});
 const item={event_id:'trace',status:'awaiting_user',timestamps:{received_at:new Date(Date.now()-100).toISOString(),execution_started_at:new Date(Date.now()-50).toISOString()}};
 e.state.active=item.event_id;e.state.events[item.event_id]=item;
 e.stage(item,'repeated_step');e.stage(item,'repeated_step');e.log(item,'duplicate_event_ignored');e.reset(item.event_id,true);
 const rows=readFileSync(join(root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,4);assert.deepEqual(rows.map(r=>r.sequence),[1,2,3,4]);assert.equal(rows[1].previous_stage,'repeated_step');assert.ok(rows[1].since_received_ms>=100);assert.equal(rows[0].lock_owned,true);assert.equal(rows[3].lock_owned,false);assert.equal(rows[3].stage,'configuration_lock_released');assert.equal(rows[0].checkout_method,'guest_credit');
});
