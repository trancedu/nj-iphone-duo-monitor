import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PickupBrowser} from '../browser.mjs';
import {clearBag} from '../clear_bag.mjs';
import {readFileSync} from 'node:fs';
const URL='https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-black-unlocked';
const PRODUCT='iPhone 18 Pro Max 256GB Black';
// Real Playwright against locally fulfilled fixtures: no Apple requests or accounts.
async function fixture(t,options={}) {
  const chrome=await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>chrome.close());
  const context=await chrome.newContext();
  const page=await context.newPage();page.setDefaultTimeout(750);
  let bag=options.existing||'empty',adds=0,checkout=0,forbidden=0;
  await context.route('**/*',async route=>{
    const path=new globalThis.URL(route.request().url()).pathname;
    let html='';
    if(path==='/shop/bag') {
      html=bag==='empty'?'<h1>Your bag is empty.</h1>':`<div data-autom="bag-item"><a href="${URL}">${bag==='other'?'iPhone 18 Pro Max 512GB Black':PRODUCT}</a><label>Quantity for iPhone<select><option selected>${bag==='two'?'2':'1'}</option></select></label><button id="remove-old" onclick="location.href='/cleared'">Remove old iPhone</button></div>${options.realPay?'<button id="shoppingCart.actions.navApwCheckout" onclick="location.href=\'/checkout\'">Check out with Pay</button><button id="shoppingCart.actions.apwCheckout">Check out with Pay</button>':'<button onclick="location.href=\'/checkout\'">Checkout with Apple Pay</button>'}`;
    } else if(path==='/cleared') {
      bag='empty';html='<h1>Your bag is empty.</h1>';
    } else if(path===new globalThis.URL(URL).pathname) {
      html=`<p>${PRODUCT}</p><label><input type="radio" name="care" onchange="document.querySelector('button').disabled=false">No AppleCare coverage</label><button disabled onclick="location.href='/added'">Add to Bag</button>`;
    } else if(path==='/added') {
      adds++;bag='same';html=options.uncertain?'<h1>Something went wrong</h1>':`<button onclick="location.href='/shop/bag'">Review Bag</button>`;
    } else if(path==='/checkout') {
      checkout++;
      html=`<label><input type="radio" name="fulfillment" id="pickup" onchange="document.querySelector('${options.zip?'#zip-form':'[data-autom=store-list]'}').hidden=false">I’ll pick it up</label><label><input type="radio" name="fulfillment" id="delivery">Deliver to me</label>${options.zip?`<div id="zip-form" hidden><label>Zip Code or City, State<input role="combobox"></label><button onclick="document.querySelector('[data-autom=store-list]').hidden=false;document.querySelector('#zip-form').hidden=true">Apply</button></div>`:''}<div data-autom="store-list" hidden>${options.zip?'<button>07094</button>':''}<div data-autom="store-row"><label><input type="radio" name="store" ${options.unavailable&&!(options.availableAfter&&checkout>=options.availableAfter)?'disabled':''}>American Dream</label></div></div><button onclick="location.href='/forbidden'">Continue</button><button onclick="location.href='/forbidden'">Pay</button>`;
    } else {forbidden++;html='<h1>Forbidden action</h1>';}
    await route.fulfill({contentType:'text/html; charset=utf-8',body:html});
  });
  const browser=new PickupBrowser({selectors:{bag_item:'[data-autom="bag-item"]',store_list:'[data-autom="store-list"]',store_row:'[data-autom="store-row"]'}});
  browser.context=context;browser.page=page;browser.connected=true;
  return {browser,page,counts:()=>({adds,checkout,forbidden})};
}
test('empty bag: No AppleCare before exactly one Add, stop at pickup without store/time/payment',async t=>{
  const f=await fixture(t);const stages=[];
  assert.equal(await f.browser.prepare({product_url:URL},s=>stages.push(s)),'awaiting_user');
  assert.deepEqual(f.counts(),{adds:1,checkout:1,forbidden:0});
  assert.equal(await f.page.locator('#pickup').isChecked(),true);
  assert.equal(await f.page.locator('input[name=store]').isChecked(),false);
  assert.equal(await f.page.locator('#delivery').isChecked(),false);
  assert.deepEqual(stages,['bag_page_ready_at','bag_checked_at','opened_at','care_selected_at','add_started_at','add_returned_at','review_bag_started_at','bag_ready_at','apple_pay_at','pickup_check_0_started_at','handoff_at']);
});
test('same one already in bag is reused without adding',async t=>{
  const f=await fixture(t,{existing:'same'});
  assert.equal(await f.browser.prepare({product_url:URL},()=>{}),'awaiting_user');
  assert.deepEqual(f.counts(),{adds:0,checkout:1,forbidden:0});
});
for(const existing of ['other','two']) test(`bag ${existing} stops before checkout and never removes/adds`,async t=>{
  const f=await fixture(t,{existing});
  await assert.rejects(()=>f.browser.prepare({product_url:URL},()=>{}),e=>e.code=== (existing==='two'?'bag_quantity_not_one':'bag_configuration_mismatch'));
  assert.deepEqual(f.counts(),{adds:0,checkout:0,forbidden:0});
});
test('uncertain add rechecks bag instead of clicking Add again',async t=>{
  const f=await fixture(t,{uncertain:true});
  assert.equal(await f.browser.prepare({product_url:URL},()=>{}),'awaiting_user');
  assert.deepEqual(f.counts(),{adds:1,checkout:1,forbidden:0});
});
test('all stores disabled records pickup_unavailable and stays on pickup list',async t=>{
  const f=await fixture(t,{unavailable:true});
  await assert.rejects(()=>f.browser.prepare({product_url:URL},()=>{}),e=>e.code==='pickup_unavailable');
  assert.equal(await f.page.locator('#pickup').isChecked(),true);
  assert.deepEqual(f.counts(),{adds:1,checkout:1,forbidden:0});
});
test('observed Apple logo label and duplicate checkout buttons use unique navigation button',async t=>{
  const f=await fixture(t,{existing:'same',realPay:true});
  assert.equal(await f.browser.prepare({product_url:URL},()=>{}),'awaiting_user');
  assert.deepEqual(f.counts(),{adds:0,checkout:1,forbidden:0});
});
for(const confirm of [false,true]) test(`clear bag confirm=${confirm} verifies preview or empty result`,async t=>{
  const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
  const page=await chrome.newPage();page.setDefaultTimeout(1000);
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<main><div role="listitem" data-autom="bag-item-1"><label>Quantity for iPhone<select><option>1</option></select></label><button id="remove-1" onclick="this.parentElement.remove();document.querySelector('h1').hidden=false">Remove iPhone Duo</button></div><h1 hidden>Your bag is empty.</h1></main>`}));
  const browser=new PickupBrowser({selectors:{bag_item:'[role="listitem"][data-autom^="bag-item-"]'}});
  browser.page=page;browser.connected=true;
  const result=await clearBag(browser,{confirm});
  assert.deepEqual(result,confirm?{status:'bag_empty',removed:1}:{status:'clear_preview',items:1,removed:0});
  assert.equal(await page.getByRole('button',{name:'Remove iPhone Duo'}).count(),confirm?0:1);
});
test('CDP rejects non-loopback endpoints before connecting',async()=>{
  for(const endpoint of ['http://192.168.1.10:9222','https://127.0.0.1:9222','http://user@127.0.0.1:9222','http://127.0.0.1:9222/path']) {
    await assert.rejects(()=>new PickupBrowser({cdp_endpoint:endpoint}).start(),e=>e.code==='cdp_loopback_required');
  }
});
test('pickup ZIP uses explicit configured value and leaves store selection untouched',async t=>{
  const f=await fixture(t,{existing:'same',zip:true});f.browser.config.pickup_zip='07094';
  assert.equal(await f.browser.prepare({product_url:URL},()=>{}),'awaiting_user');
  assert.equal(await f.page.locator('#zip-form input').inputValue(),'07094');
  assert.equal(await f.page.locator('input[name=store]').isChecked(),false);
});
test('missing pickup ZIP stops for manual entry without continuing checkout',async t=>{
  const f=await fixture(t,{existing:'same',zip:true});
  await assert.rejects(()=>f.browser.prepare({product_url:URL},()=>{}),e=>e.code==='pickup_zip_required');
  assert.deepEqual(f.counts(),{adds:0,checkout:1,forbidden:0});
});
test('CDP example selector covers nested legend heading and every store radio',async t=>{
  const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
  const page=await chrome.newPage();
  await page.setContent('<fieldset><legend><h3>Select your pickup store:</h3></legend><div class="rt-storelocator-store-group">'+Array.from({length:5},(_,i)=>`<label><input type="radio" disabled name="store">Store ${i}</label>`).join('')+'</div></fieldset>');
  const cfg=JSON.parse(readFileSync(new globalThis.URL('../receiver.cdp.example.json',import.meta.url)));
  const list=page.locator(cfg.selectors.store_list);
  assert.equal(await list.count(),1);
  assert.equal(await list.locator(cfg.selectors.store_row).getByRole('radio').count(),5);
});
test('opt-in preflight clears recognized old configuration then adds target exactly once',async t=>{
  const f=await fixture(t,{existing:'other'});f.browser.config.auto_clear_bag=true;
  const stages=[];
  assert.equal(await f.browser.prepare({product_url:URL},s=>stages.push(s)),'awaiting_user');
  assert.deepEqual(f.counts(),{adds:1,checkout:1,forbidden:0});
  assert(stages.indexOf('old_bag_cleared_at')<stages.indexOf('opened_at'));
});
test('opt-in cleanup still reuses same-one bag without add or removal navigation',async t=>{
  const f=await fixture(t,{existing:'same'});f.browser.config.auto_clear_bag=true;
  const stages=[];
  assert.equal(await f.browser.prepare({product_url:URL},s=>stages.push(s)),'awaiting_user');
  assert.deepEqual(f.counts(),{adds:0,checkout:1,forbidden:0});
  assert(!stages.includes('old_bag_cleared_at'));
});

test('pickup refresh resumes when stock appears, without adding or checking out again',async t=>{
  const f=await fixture(t,{existing:'same',unavailable:true,availableAfter:2});
  f.browser.config.pickup_unavailable_retries=5;
  const stages=[];
  assert.equal(await f.browser.prepare({product_url:URL},s=>stages.push(s)),'awaiting_user');
  assert.deepEqual(f.counts(),{adds:0,checkout:2,forbidden:0});
  assert.ok(stages.includes('pickup_refresh_1_at'));
  assert.ok(!stages.includes('pickup_refresh_2_at'));
  assert.equal(await f.page.locator('#pickup').isChecked(),true);
});
test('three additional refreshes exhaust and stop with no payment or cart mutation',async t=>{
  const f=await fixture(t,{existing:'same',unavailable:true,zip:true});
  Object.assign(f.browser.config,{pickup_unavailable_retries:3,pickup_zip:'07094'});
  const stages=[];
  await assert.rejects(()=>f.browser.prepare({product_url:URL},s=>stages.push(s)),e=>e.code==='pickup_unavailable');
  assert.deepEqual(f.counts(),{adds:0,checkout:4,forbidden:0});
  assert.equal(stages.filter(s=>/^pickup_refresh_/.test(s)).length,3);
  assert.ok(stages.includes('pickup_check_3_unavailable_at'));
  assert.equal(await f.page.locator('#zip-form input').inputValue(),'07094');
});
test('unrecognized pickup DOM stops immediately rather than refreshing',async t=>{
  const f=await fixture(t,{existing:'same',unavailable:true});
  f.browser.config.pickup_unavailable_retries=5;
  f.browser.config.selectors.store_row='[missing-store-row]';
  await assert.rejects(()=>f.browser.prepare({product_url:URL},()=>{}),e=>e.code==='store_list_unrecognized');
  assert.deepEqual(f.counts(),{adds:0,checkout:1,forbidden:0});
});
