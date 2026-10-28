import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Stop} from '../protocol.mjs';
import {safariDOM} from '../safari/dom.mjs';
import {handoffActivity} from '../safari/idle.mjs';
import {pickupLocationDOM} from '../pickup_location.mjs';
import {prepareSafari,SafariWindow} from '../safari/shopping.mjs';
const url='https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked';
const product='iPhone 18 Pro 256GB Burgundy';
// Keep the fixture's 10 a.m. slots in the future regardless of test-run time.
const pickupDate=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'long',day:'numeric'}).format(new Date(Date.now()+86400000)).replace(/\s/g,'').toLowerCase();
const config={pickup_first_available_store:false,pickup_zip:'07094',pickup_unavailable_retries:1,pickup_retry_interval_ms:1000,pickup_details:{store_name:'Apple Test Store',first_name:'Test',last_name:'User',email:'test@example.com',phone:'2025550123',preferred_slot:2,min_lead_minutes:0}};
async function fixture(t,{existing=false,availableAfter=1,wrong=false,hiddenTarget=false,wrongLocation=false,walletSheet=false}={}) {
 const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
 const page=await chrome.newPage();let bag=existing,adds=0,checks=0,forbidden=0;
 await page.route('**/*',async route=>{
  const path=new URL(route.request().url()).pathname;let body;
  if(path==='/shop/bag')body=bag?`<div role="listitem" data-autom="bag-item-1"><h2>${wrong?'Wrong Product':product}</h2><label>Quantity<select><option>1</option></select></label></div><button id="shoppingCart.actions.navApwCheckout" onclick="location.href='/checkout'">Check out with Pay</button><button>Check out with Pay</button>`:'<h1>Your bag is empty.</h1>';
  else if(path===new URL(url).pathname)body=`<p>${product}</p><label><input type="radio" name="care">No AppleCare coverage</label><button onclick="location.href='/added'">Add to Bag</button>`;
  else if(path==='/added'){adds++;bag=true;body='<button onclick="location.href=\'/shop/bag\'">Review Bag</button>';}
  else if(path==='/checkout'){
   checks++;body=`<button>07094</button><label><input type="radio">I’ll pick it up</label><fieldset><legend>Select your pickup store:</legend>${hiddenTarget?Array.from({length:5},(_,i)=>`<label><input type="radio" disabled>Apple Other ${i} unavailable</label>`).join('')+'<div id="extra-stores" hidden>':''}<label><input id="store-target" type="radio" name="store" ${checks<availableAfter?'disabled':''}>Apple Test Store Available Today</label>${hiddenTarget?'</div><a href="#" onclick="event.preventDefault();document.getElementById(\'extra-stores\').hidden=false;this.remove()">Show more stores</a>':''}<label><input type="radio" name="date" checked>${pickupDate}</label><select id="checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue"><option value="1">10:00 a.m. – 10:15 a.m.</option><option value="2">10:15 a.m. – 10:30 a.m.</option></select></fieldset><button onclick="location.href='/details'">Continue to Pickup Details</button>`;
  } else if(path==='/details')body=`<h1>Now fill out your pickup information.</h1><label><input type="radio" checked>I’ll pick it up</label>${['First Name','Last Name','Email Address','Phone Number'].map(label=>`<label>${label}<input></label>`).join('')}<button id="co-options-applePay" onclick="location.href='/payment'">Continue with Apple Pay</button>`;
  else{forbidden++;body='<h1>Forbidden</h1>';}
  if(path==='/details'&&walletSheet)body=body.replace("onclick=\"location.href='/payment'\"","onclick=\"window.walletRequests=(window.walletRequests||0)+1;document.getElementById('wallet-sheet').hidden=false\"")+'<div id="wallet-sheet" hidden>Confirm with Touch ID<button onclick="window.authorized=true">Authorize payment</button></div>';
  if(path==='/checkout'&&wrongLocation)body=body.replace('<button>07094</button>',`<button onclick="document.getElementById('zip-editor').hidden=false;this.hidden=true">East Rutherford, NJ</button><div id="zip-editor" hidden><label>Zip Code or City, State<input role="combobox" value="East Rutherford, NJ"></label><button onclick="window.zipApplied=(window.zipApplied||0)+1;document.getElementById('store-target').disabled=false">Apply</button></div>`);
  await route.fulfill({contentType:'text/html; charset=utf-8',body});
 });
 await page.goto('https://www.apple.com/shop/bag');
 const window={call:async(op,args)=>{try{if(['locationState','openLocation'].includes(op))return await page.evaluate(pickupLocationDOM,{open:op==='openLocation'});return await page.evaluate(['armIdle','idleState','claimIdleReturn'].includes(op)?handoffActivity:safariDOM,{op,args});}catch(e){if(e.message.includes('Execution context was destroyed')){e.code='safari_navigation_pending';}throw e;}},goto:url=>page.goto(url),reload:()=>page.reload(),foreground:async()=>{}};
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
test('Safari dispatcher has no wallet authorization operation',async t=>{
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
 f.window.call=(op,args)=>{if(['fillContact','prepareContact'].includes(op))throw new Stop('contact_not_verified');return call(op,args);};f.window.reload=()=>{reloads++;};
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
test('missing target produces specific error and records actual available alternatives',async t=>{
 const f=await fixture(t,{existing:true});const observations=[];
 await assert.rejects(()=>prepareSafari(f.window,url,{...config,pickup_unavailable_retries:0,pickup_details:{...config.pickup_details,store_name:'Apple Missing Store'}},{stage:(name,detail)=>{if(detail)observations.push(detail);}}),e=>e.code==='target_store_not_listed');
 assert.equal(f.counts().checks,1);assert.equal(f.counts().forbidden,0);assert.ok(observations.some(d=>d.verdict==='target_store_not_listed'&&d.stores[0].enabled));
 assert.ok(!JSON.stringify(observations).includes(config.pickup_details.email));
});
test('store observation includes availability text, visibility and sanitized page coordinates',async t=>{
 const f=await fixture(t,{existing:true});await f.page.goto('https://www.apple.com/checkout?_s=Fulfillment-init&token=not-for-log');const d=await f.window.call('stores');
 assert.equal(d.stores[0].availability_text,'Available Today');assert.equal(d.stores[0].visible,true);assert.equal(d.page.path,'/checkout');assert.equal(d.page.state,'Fulfillment-init');assert.equal(d.page.url,undefined);assert.ok(!JSON.stringify(d).includes('not-for-log'));
});
test('expanding stores waits for asynchronously inserted target before judging inventory',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call,observations=[];
 f.window.call=async(op,args)=>{if(op==='moreStores'){await f.page.locator('fieldset').evaluate(e=>setTimeout(()=>{const label=document.createElement('label');label.innerHTML='<input type="radio" name="store">Apple Missing Store Available Today';e.append(label);},100));return {expanded:true};}return call(op,args);};
 const result=await prepareSafari(f.window,url,{...config,step_timeout_ms:1500,pickup_details:{...config.pickup_details,store_name:'Apple Missing Store'}},{stage:(name,detail)=>{if(detail)observations.push(detail);}});
 assert.equal(result.status,'awaiting_user');assert.ok(observations.some(d=>d.phase==='after_expansion'&&d.verdict==='target_store_selectable'));assert.equal(f.counts().checks,1);assert.equal(f.counts().forbidden,0);
});
test('default two unavailable retries perform three checks and never enter payment',async t=>{
 const f=await fixture(t,{existing:true,availableAfter:99});let reloads=0;const reload=f.window.reload;f.window.reload=()=>{reloads++;return reload();};
 const {pickup_unavailable_retries,...defaults}=config;
 const result=await prepareSafari(f.window,url,defaults);assert.equal(result.status,'pickup_unavailable');assert.equal(result.checks,3);assert.equal(reloads,2);assert.deepEqual(f.counts(),{adds:0,checks:3,forbidden:0});
});
test('production idle observer is armed before foreground handoff and does not click payment',async t=>{
 const f=await fixture(t,{existing:true});let seen;
 f.window.foreground=async()=>{seen=await f.window.call('idleState',{event_id:'idle-test'});};
 const result=await prepareSafari(f.window,url,{...config,handoff_idle_timeout_seconds:600,handoff_event_id:'idle-test'});assert.equal(result.status,'awaiting_user');assert.equal(seen.status,'tracking');assert.equal(f.counts().forbidden,0);
});
test('available sixth store is revealed through Show more link before selection, without refresh',async t=>{
 const f=await fixture(t,{existing:true,hiddenTarget:true});let reloads=0;f.window.reload=()=>{reloads++;};const stages=[];
 assert.equal((await prepareSafari(f.window,url,config,{stage:s=>stages.push(s)})).status,'awaiting_user');assert.ok(stages.includes('pickup_stock_found_at'));assert.ok(stages.includes('target_store_revealed_at'));assert.equal(reloads,0);assert.equal(f.counts().forbidden,0);
});
test('stock lost while revealing store preserves the pickup page rather than refreshing',async t=>{
 const f=await fixture(t,{existing:true,hiddenTarget:true});const call=f.window.call;let reloads=0;
 f.window.call=async(op,args)=>{const r=await call(op,args);if(op==='moreStores')await f.page.locator('#store-target').evaluate(e=>{e.disabled=true;});return r;};f.window.reload=()=>{reloads++;};
 await assert.rejects(()=>prepareSafari(f.window,url,config),e=>e.code==='target_store_changed_after_expansion');assert.equal(reloads,0);assert.equal(new URL(f.page.url()).pathname,'/checkout');assert.equal(f.counts().forbidden,0);
});

test('wrong city location is corrected once before unavailable verdict, then preserves newly available stock',async t=>{
 const f=await fixture(t,{existing:true,availableAfter:99,wrongLocation:true});let reloads=0;f.window.reload=()=>{reloads++;};const stages=[];
 const result=await prepareSafari(f.window,url,config,{stage:s=>stages.push(s)});
 assert.equal(result.status,'awaiting_user');assert.equal(stages.filter(s=>s==='pickup_location_corrected_at').length,1);assert.ok(stages.includes('pickup_stock_found_at'));assert.equal(reloads,0);assert.equal(f.counts().forbidden,0);
});

test('opt-in requests Apple Pay exactly once after verified contact; never authenticates',async t=>{
 const f=await fixture(t,{existing:true,walletSheet:true});const stages=[];
 const result=await prepareSafari(f.window,url,{...config,open_apple_pay_sheet:true},{stage:s=>stages.push(s)});
 assert.equal(result.status,'awaiting_user');assert.equal(result.finalApplePayClicked,true);assert.equal(result.applePayAuthenticated,false);
 assert.equal(await f.page.evaluate(()=>window.walletRequests),1);assert.equal(await f.page.evaluate(()=>window.authorized),undefined);
 assert.ok(stages.indexOf('contact_verified_at')<stages.indexOf('apple_pay_sheet_requested_at'));
 await assert.rejects(()=>f.window.call('requestApplePay',{contact:config.pickup_details}),/apple_pay_already_requested/);
 assert.equal(await f.page.evaluate(()=>window.walletRequests),1);assert.equal(f.counts().forbidden,0);
});
test('Apple Pay request refuses changed contact and never clicks',async t=>{
 const f=await fixture(t,{existing:true,walletSheet:true});await prepareSafari(f.window,url,config);
 await f.page.getByRole('textbox',{name:'Email Address',exact:true}).fill('changed@example.com');
 await assert.rejects(()=>f.window.call('requestApplePay',{contact:config.pickup_details}),/contact_not_verified/);
 assert.equal(await f.page.evaluate(()=>window.walletRequests),undefined);assert.equal(f.counts().forbidden,0);
});
test('uncertain Apple Pay invocation is not retried and the found-stock stage remains',async t=>{
 const f=await fixture(t,{existing:true,walletSheet:true});const call=f.window.call;let requests=0;const stages=[];
 f.window.call=async(op,args)=>{if(op==='requestApplePay'){requests++;await call(op,args);throw Error('reply_lost_after_click');}return call(op,args);};
 await assert.rejects(()=>prepareSafari(f.window,url,{...config,open_apple_pay_sheet:true},{stage:s=>stages.push(s)}),/reply_lost_after_click/);
 assert.equal(requests,1);assert.ok(stages.includes('pickup_stock_found_at'));assert.ok(stages.includes('apple_pay_sheet_requested_at'));assert.equal(await f.page.evaluate(()=>window.walletRequests),1);assert.equal(await f.page.evaluate(()=>window.authorized),undefined);
});
test('Available Windows placeholder and reset time cannot reach pickup details',async t=>{
 const f=await fixture(t,{existing:true});await f.page.goto('https://www.apple.com/checkout');
 const slot=f.page.locator('select');
 await slot.evaluate(e=>{const o=new Option('Available Windows','placeholder',true,true);e.prepend(o);e.value='placeholder';});
 await assert.rejects(()=>f.window.call('selectTime',{value:'placeholder'}),/time_unavailable/);
 await assert.rejects(()=>f.window.call('continuePickup',{expected_time:'placeholder'}),/pickup_time_not_selected/);
 await f.window.call('selectTime',{value:'2'});await slot.evaluate(e=>e.value='placeholder');
 await assert.rejects(()=>f.window.call('continuePickup',{expected_time:'2'}),/pickup_time_not_selected/);
 assert.equal(new URL(f.page.url()).pathname,'/checkout');assert.equal(f.counts().forbidden,0);
});

test('time reset after initial selection is reselected before the one Continue click',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call;let continues=0,resets=0;
 f.window.call=async(op,args)=>{
  if(op==='continuePickup'){
   continues++;
   if(resets++===0)await f.page.locator('select').evaluate(e=>{e.value='';});
  }
  return call(op,args);
 };
 const stages=[];const r=await prepareSafari(f.window,url,config,{stage:s=>stages.push(s)});
 assert.equal(r.status,'awaiting_user');assert.equal(continues,2);
 assert.ok(stages.includes('time_reselected_at'));assert.equal(f.counts().forbidden,0);
});
test('Continue request is issued once even if its response is queried again',async t=>{
 const f=await fixture(t,{existing:true});await f.page.goto('https://www.apple.com/checkout');
 await f.page.getByRole('button',{name:'Continue to Pickup Details'}).evaluate(e=>e.onclick=()=>{window.continueRequests=(window.continueRequests||0)+1;});
 await f.window.call('selectTime',{value:'2'});
 await f.window.call('continuePickup',{expected_time:'2'});await f.window.call('continuePickup',{expected_time:'2'});
 assert.equal(await f.page.evaluate(()=>window.continueRequests),1);
});

test('visible available store is selected before time slots without expanding other stores',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call;let expanded=0,selected=false;
 f.window.call=async(op,args)=>{
  if(op==='moreStores')expanded++;
  if(op==='dates')assert.equal(selected,true);
  const r=await call(op,args);
  if(op==='selectStore')selected=r.selected;
  return r;
 };
 assert.equal((await prepareSafari(f.window,url,config)).status,'awaiting_user');
 assert.equal(selected,true);assert.equal(expanded,0);assert.equal(f.counts().forbidden,0);
});

test('default shared policy selects first enabled store even when notification names another',async t=>{
 const f=await fixture(t,{existing:true});const call=f.window.call;let chosen;
 f.window.call=async(op,args)=>{
  if(op==='stores')await f.page.locator('#store-target').evaluate(e=>{
   if(document.getElementById('first-available'))return;
   const label=document.createElement('label');label.innerHTML='<input id="first-available" type="radio" name="store" value="R001">Apple First Available Today';e.parentElement.before(label);
  });
  if(op==='selectStore')chosen=args;
  return call(op,args);
 };
 const {pickup_first_available_store,...defaults}=config;
 assert.equal((await prepareSafari(f.window,url,{...defaults,pickup_details:{...config.pickup_details,store_name:'Apple Notification Store'}})).status,'awaiting_user');
 assert.equal(chosen.store_id,'R001');assert.equal(f.counts().forbidden,0);
});
