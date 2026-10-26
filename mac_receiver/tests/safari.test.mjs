import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Stop} from '../protocol.mjs';
import {safariDOM} from '../safari/dom.mjs';
import {prepareSafari,SafariWindow} from '../safari/shopping.mjs';
const url='https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked';
const product='iPhone 18 Pro 256GB Burgundy';
const config={pickup_zip:'07094',pickup_unavailable_retries:1,pickup_retry_interval_ms:1000,pickup_details:{store_name:'Apple Test Store',first_name:'Test',last_name:'User',email:'test@example.com',phone:'2025550123',preferred_slot:2,min_lead_minutes:0}};
async function fixture(t,{existing=false,availableAfter=1,wrong=false}={}) {
 const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
 const page=await chrome.newPage();let bag=existing,adds=0,checks=0,forbidden=0;
 await page.route('**/*',async route=>{
  const path=new URL(route.request().url()).pathname;let body;
  if(path==='/shop/bag')body=bag?`<div role="listitem" data-autom="bag-item-1"><h2>${wrong?'Wrong Product':product}</h2><label>Quantity<select><option>1</option></select></label></div><button id="shoppingCart.actions.navApwCheckout" onclick="location.href='/checkout'">Check out with Pay</button><button>Check out with Pay</button>`:'<h1>Your bag is empty.</h1>';
  else if(path===new URL(url).pathname)body=`<p>${product}</p><label><input type="radio" name="care">No AppleCare coverage</label><button onclick="location.href='/added'">Add to Bag</button>`;
  else if(path==='/added'){adds++;bag=true;body='<button onclick="location.href=\'/shop/bag\'">Review Bag</button>';}
  else if(path==='/checkout'){
   checks++;body=`<label><input type="radio">I’ll pick it up</label><fieldset><legend>Select your pickup store:</legend><label><input type="radio" name="store" ${checks<availableAfter?'disabled':''}>Apple Test Store Available Today</label><label><input type="radio" name="date" checked>october27</label><select id="checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue"><option value="1">10:00 a.m. – 10:15 a.m.</option><option value="2">10:15 a.m. – 10:30 a.m.</option></select></fieldset><button onclick="location.href='/details'">Continue to Pickup Details</button>`;
  } else if(path==='/details')body=`<h1>Now fill out your pickup information.</h1><label><input type="radio" checked>I’ll pick it up</label>${['First Name','Last Name','Email Address','Phone Number'].map(label=>`<label>${label}<input></label>`).join('')}<button id="co-options-applePay" onclick="location.href='/payment'">Continue with Apple Pay</button>`;
  else{forbidden++;body='<h1>Forbidden</h1>';}
  await route.fulfill({contentType:'text/html; charset=utf-8',body});
 });
 await page.goto('https://www.apple.com/shop/bag');
 const window={call:async(op,args)=>{try{return await page.evaluate(safariDOM,{op,args});}catch(e){if(e.message.includes('Execution context was destroyed')){e.code='safari_navigation_pending';}throw e;}},goto:url=>page.goto(url),reload:()=>page.reload(),foreground:async()=>{}};
 return {window,page,counts:()=>({adds,checks,forbidden})};
}
test('Safari test path seeds once, picks second time, verifies contact and stops before final Pay',async t=>{
 const f=await fixture(t);const stages=[];
 const result=await prepareSafari(f.window,url,config,{stage:s=>stages.push(s)});
 assert.equal(result.status,'awaiting_user');assert.equal(result.time,'10:15 a.m. – 10:30 a.m.');
 assert.equal(await f.page.getByRole('textbox',{name:'First Name',exact:true}).inputValue(),'Test');
 assert.deepEqual(f.counts(),{adds:1,checks:1,forbidden:0});assert.ok(stages.includes('handoff_at'));
});
test('Safari refresh continues on newly available stock without a second Add',async t=>{
 const f=await fixture(t,{existing:true,availableAfter:2});const stages=[];
 assert.equal((await prepareSafari(f.window,url,config,{stage:s=>stages.push(s)})).status,'awaiting_user');
 assert.deepEqual(f.counts(),{adds:0,checks:2,forbidden:0});assert.equal(stages.filter(s=>s.startsWith('pickup_refresh_')).length,1);
});
test('Safari sold-out retry is bounded and preserves pickup page',async t=>{
 const f=await fixture(t,{existing:true,availableAfter:99});
 assert.equal((await prepareSafari(f.window,url,config)).status,'pickup_unavailable');
 assert.deepEqual(f.counts(),{adds:0,checks:2,forbidden:0});assert.equal(new URL(f.page.url()).pathname,'/checkout');
});
test('Safari unexpected bag configuration never clicks checkout or removes anything',async t=>{
 const f=await fixture(t,{existing:true,wrong:true});
 await assert.rejects(()=>prepareSafari(f.window,url,config),e=>e.code==='bag_not_exactly_one_target');
 assert.deepEqual(f.counts(),{adds:0,checks:0,forbidden:0});
});
test('Safari dispatcher has no final payment operation',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.window.call('pay'),/unsupported_safari_operation/);
 assert.deepEqual(f.counts(),{adds:0,checks:0,forbidden:0});
});
test('Safari window rejects invalid ids; AppleScript pins exact profile and one tab',()=>{
 assert.throws(()=>new SafariWindow(0,'Test'));
 const script=new SafariWindow(42,'Test').script('return 1');
 assert.match(script,/window id 42/);assert.match(script,/Test — /);assert.match(script,/count of tabs of w/);
});
test('Safari custom ARIA pickup radio waits for asynchronous checked state',async t=>{
 const f=await fixture(t);await f.page.setContent('<button role="radio" aria-checked="false" onclick="setTimeout(()=>this.setAttribute(\'aria-checked\',\'true\'),20)">I’ll pick it up</button>');
 assert.equal((await f.window.call('pickup')).ready,false);
 await f.page.getByRole('radio').evaluate(e=>new Promise(r=>{const check=()=>e.getAttribute('aria-checked')==='true'?r():setTimeout(check,10);check();}));
 assert.equal((await f.window.call('pickup')).ready,true);
});
test('Safari contact readback accepts formatted phone digits and never clicks payment',async t=>{
 const f=await fixture(t);await f.page.goto('https://www.apple.com/details');
 await f.page.getByRole('textbox',{name:'Phone Number',exact:true}).evaluate(e=>{e.type='tel';e.addEventListener('input',()=>{e.value='(202) 555-0123';});});
 assert.equal((await f.window.call('fillContact',{contact:config.pickup_details})).filled,true);
 assert.equal(await f.page.getByRole('textbox',{name:'Phone Number',exact:true}).inputValue(),'(202) 555-0123');
 assert.equal(f.counts().forbidden,0);
});

test('available stock never refreshes, even with five retries configured',async t=>{
 const f=await fixture(t,{existing:true});let reloads=0;const reload=f.window.reload;f.window.reload=()=>{reloads++;return reload();};
 assert.equal((await prepareSafari(f.window,url,{...config,pickup_unavailable_retries:5})).status,'awaiting_user');
 assert.equal(reloads,0);assert.deepEqual(f.counts(),{adds:0,checks:1,forbidden:0});
});
test('wrong quantity stops before checkout without clearing the bag',async t=>{
 const f=await fixture(t,{existing:true});await f.page.locator('select').evaluate(e=>{e.options[0].value='2';});
 await assert.rejects(()=>prepareSafari(f.window,url,config),e=>e.code==='bag_not_exactly_one_target');
 assert.deepEqual(f.counts(),{adds:0,checks:0,forbidden:0});
});
test('extra bag item stops before checkout',async t=>{
 const f=await fixture(t,{existing:true});await f.page.locator('[role=listitem]').evaluate(e=>e.after(e.cloneNode(true)));
 await assert.rejects(()=>prepareSafari(f.window,url,config),e=>e.code==='bag_not_exactly_one_target');
 assert.deepEqual(f.counts(),{adds:0,checks:0,forbidden:0});
});
test('unknown store list stops immediately without any refresh',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call;let reloads=0;
 f.window.call=(op,args)=>op==='stores'?Promise.resolve({stores:[]}):call(op,args);f.window.reload=()=>{reloads++;};
 await assert.rejects(()=>prepareSafari(f.window,url,{...config,step_timeout_ms:250}),e=>e.code==='store_list_unrecognized');assert.equal(reloads,0);
});
test('available store with missing date stops without refreshing or payment',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call;let reloads=0;
 f.window.call=(op,args)=>op==='dates'?Promise.resolve({dates:[]}):call(op,args);f.window.reload=()=>{reloads++;};
 await assert.rejects(()=>prepareSafari(f.window,url,{...config,step_timeout_ms:250}),e=>e.code==='safari_step_timeout');
 assert.equal(reloads,0);assert.equal(f.counts().forbidden,0);
});
test('contact failure after selecting stock never refreshes or proceeds to Pay',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call;let reloads=0;
 f.window.call=(op,args)=>{if(op==='fillContact')throw new Stop('contact_not_verified');return call(op,args);};f.window.reload=()=>{reloads++;};
 await assert.rejects(()=>prepareSafari(f.window,url,config),e=>e.code==='contact_not_verified');assert.equal(reloads,0);assert.equal(f.counts().forbidden,0);
});
test('captcha page stops without any click',async t=>{
 const f=await fixture(t,{existing:true});await f.page.setContent('<iframe title="CAPTCHA"></iframe>');
 await assert.rejects(()=>prepareSafari(f.window,url,config),/captcha_required/);assert.deepEqual(f.counts(),{adds:0,checks:0,forbidden:0});
});
test('other sites are rejected before DOM actions',async t=>{
 const f=await fixture(t);await f.page.route('https://example.com/**',r=>r.fulfill({body:'<h1>Other site</h1>'}));await f.page.goto('https://example.com/');
 await assert.rejects(()=>f.window.call('snapshot'),/unexpected_navigation/);assert.equal(f.counts().forbidden,0);
});

test('stock appearing during retry pause proceeds without refreshing the available page',async t=>{
 const f=await fixture(t,{existing:true,availableAfter:99});const call=f.window.call;let first=true,reloads=0;
 f.window.call=async(op,args)=>{const result=await call(op,args);if(op==='stores'&&first){first=false;await f.page.locator('input[name=store]').evaluate(e=>setTimeout(()=>{e.disabled=false;},100));}return result;};
 f.window.reload=()=>{reloads++;};const stages=[];
 assert.equal((await prepareSafari(f.window,url,config,{stage:s=>stages.push(s)})).status,'awaiting_user');
 assert.equal(reloads,0);assert.ok(stages.includes('pickup_available_before_refresh_at'));assert.deepEqual(f.counts(),{adds:0,checks:1,forbidden:0});
});

test('Safari pickup readiness waits for store radios, not just visible fieldset',async t=>{
 const f=await fixture(t,{existing:true});await f.page.goto('https://www.apple.com/checkout');
 await f.page.locator('input[name=store]').evaluate(e=>e.remove());
 assert.equal((await f.window.call('pickupReady')).ready,false);
 await f.page.locator('fieldset').evaluate(e=>{const label=document.createElement('label');label.innerHTML='<input type="radio" name="store">Apple Test Store Available Today';e.append(label);});
 assert.equal((await f.window.call('pickupReady')).ready,true);
});
test('transient empty store rows wait for rendering and then continue without refresh',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call;let emptyOnce=true,reloads=0;
 f.window.call=(op,args)=>{if(op==='stores'&&emptyOnce){emptyOnce=false;return Promise.resolve({stores:[]});}return call(op,args);};f.window.reload=()=>{reloads++;};
 assert.equal((await prepareSafari(f.window,url,{...config,step_timeout_ms:1000})).status,'awaiting_user');assert.equal(reloads,0);assert.equal(f.counts().forbidden,0);
});
