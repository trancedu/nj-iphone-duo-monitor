import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PickupBrowser} from '../browser.mjs';
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
      html=bag==='empty'?'<h1>Your bag is empty.</h1>':`<div data-autom="bag-item"><a href="${URL}">${bag==='other'?'iPhone 18 Pro Max 512GB Black':PRODUCT}</a><label>Quantity for iPhone<select><option selected>${bag==='two'?'2':'1'}</option></select></label></div><button onclick="location.href='/checkout'">Checkout with Apple Pay</button>`;
    } else if(path===new globalThis.URL(URL).pathname) {
      html=`<p>${PRODUCT}</p><label><input type="radio" name="care" onchange="document.querySelector('button').disabled=false">No AppleCare coverage</label><button disabled onclick="location.href='/added'">Add to Bag</button>`;
    } else if(path==='/added') {
      adds++;bag='same';html=options.uncertain?'<h1>Something went wrong</h1>':`<button onclick="location.href='/shop/bag'">Review Bag</button>`;
    } else if(path==='/checkout') {
      checkout++;
      html=`<label><input type="radio" name="fulfillment" id="pickup" onchange="document.querySelector('[data-autom=store-list]').hidden=false">I’ll pick it up</label><label><input type="radio" name="fulfillment" id="delivery">Deliver to me</label><div data-autom="store-list" hidden><div data-autom="store-row"><label><input type="radio" name="store" ${options.unavailable?'disabled':''}>American Dream</label></div></div><button onclick="location.href='/forbidden'">Continue</button><button onclick="location.href='/forbidden'">Pay</button>`;
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
  assert.deepEqual(stages,['opened_at','bag_ready_at','apple_pay_at','handoff_at']);
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
