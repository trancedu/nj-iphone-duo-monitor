import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PickupBrowser} from '../browser.mjs';
import {DUO_VARIANTS} from '../variant_bag.mjs';
import {expectedProduct} from '../protocol.mjs';
import {preparedPageURL} from '../warm_products.mjs';

async function fixture(t,extraAfterAdd=false) {
  const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
  const context=await chrome.newContext();let bag=[],adds=0,products=0,checkout=0,forbidden=0;
  await context.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    const index=DUO_VARIANTS.findIndex(u=>new URL(u).pathname===path);let html;
    if(path==='/shop/bag')html=bag.length?bag.map((u,i)=>`<div data-autom="bag-item"><h2><a href="${u}">${expectedProduct(u)}</a></h2><label>Quantity for iPhone<select><option>1</option></select></label><button id="remove-${i}" onclick="location.href='/removed'">Remove iPhone</button></div>`).join('')+`<button onclick="location.href='/checkout'">Checkout with Apple Pay</button>`:'<h1>Your bag is empty.</h1>';
    else if(index>=0){products++;html=`<p>${expectedProduct(DUO_VARIANTS[index])}</p><label><input type="radio" onchange="document.querySelector('button').disabled=false">No AppleCare coverage</label><button disabled onclick="location.href='/added/${index}'">Add to Bag</button>`;}
    else if(path.startsWith('/added/')){adds++;const n=Number(path.split('/').at(-1));bag.push(DUO_VARIANTS[n]);if(extraAfterAdd)bag.push(DUO_VARIANTS[(n+1)%4]);html='<button onclick="location.href=\'/forbidden\'">Review Bag</button>';}
    else if(path==='/removed'){bag=[];html='<h1>Your bag is empty.</h1>';}
    else if(path==='/checkout'){checkout++;html='<label><input type="radio" onchange="document.querySelector(\'[data-list]\').hidden=false">I’ll pick it up</label><div data-list hidden><div data-row><label><input type="radio" disabled>Apple Test unavailable</label></div></div>';}
    else{forbidden++;html='<h1>Forbidden</h1>';}
    await route.fulfill({contentType:'text/html; charset=utf-8',body:html});
  });
  const page=await context.newPage();page.setDefaultTimeout(3000);
  const browser=new PickupBrowser({warm_product_pages:true,auto_clear_bag:true,step_timeout_ms:3000,selectors:{bag_item:'[data-autom=bag-item]',store_list:'[data-list]',store_row:'[data-row]'}});
  browser.page=page;browser.context=context;browser.connected=true;
  return {browser,context,page,counts:()=>({adds,products,checkout,forbidden,bag:bag.length})};
}
test('five-tab warm pool prepares four No AppleCare pages without adding',async t=>{
  const f=await fixture(t);
  assert.equal((await f.browser.warmIdle()).products,4);
  assert.equal(f.context.pages().length,5);
  assert.deepEqual(f.counts(),{adds:0,products:4,checkout:0,forbidden:0,bag:0});
  for(const p of f.context.pages().filter(p=>p!==f.page))assert.equal(await p.getByRole('radio',{name:'No AppleCare coverage'}).isChecked(),true);
});
test('warm task adds once from prepared page, checks bag in fifth tab, and rewarms after release',async t=>{
  const f=await fixture(t);await f.browser.warmIdle();const stages=[];
  await assert.rejects(()=>f.browser.prepare({product_url:DUO_VARIANTS[0]},s=>stages.push(s)),e=>e.code==='pickup_unavailable');
  assert.equal(f.browser.page,f.page);assert.equal(new URL(f.page.url()).pathname,'/checkout');
  assert.deepEqual(f.counts(),{adds:1,products:4,checkout:1,forbidden:0,bag:1});
  assert(stages.includes('prepared_product_ready_at'));
  await f.browser.warmIdle();
  assert.equal(f.context.pages().length,5);assert.equal(f.counts().adds,1);assert.equal(f.counts().bag,0);
  const urls=[];for(const p of f.context.pages()){const u=await preparedPageURL(p);if(u)urls.push(u);}
  assert.deepEqual(urls.sort(),[...DUO_VARIANTS].sort());
});
test('warm task refuses checkout if post-add bag contains an extra product',async t=>{
  const f=await fixture(t,true);await f.browser.warmIdle();
  await assert.rejects(()=>f.browser.prepare({product_url:DUO_VARIANTS[0]},()=>{}),e=>e.code==='bag_has_other_items');
  assert.equal(f.counts().adds,1);assert.equal(f.counts().checkout,0);assert.equal(f.counts().bag,2);
});
