import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PickupBrowser} from '../browser.mjs';
import {DUO_VARIANTS,retainTargetVariant} from '../variant_bag.mjs';
import {expectedProduct} from '../protocol.mjs';

async function fixture(t,{urls=DUO_VARIANTS,quantity=1,uncertain=false,asyncRemove=false}={}) {
  const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
  const page=await chrome.newPage();page.setDefaultTimeout(700);
  const html=urls.map((url,i)=>`<div role="listitem" data-autom="bag-item-${i}"><h2><a href="${url}">${expectedProduct(url)}</a></h2><label>Quantity for ${expectedProduct(url)}<select><option>${quantity}</option></select></label><button id="remove-${i}" onclick="window.removals=(window.removals||0)+1;${uncertain?'':asyncRemove?'const row=this.parentElement;this.remove();setTimeout(()=>row.remove(),100)':'this.parentElement.remove()'}">Remove ${expectedProduct(url)}</button></div>`).join('');
  await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  await page.goto('https://www.apple.com/shop/bag');
  const browser=new PickupBrowser({selectors:{bag_item:'[role="listitem"][data-autom^="bag-item-"]'}});browser.page=page;browser.connected=true;
  return {page,browser};
}
test('retain selected preloaded Duo only, remove three once, no add or checkout',async t=>{
  const f=await fixture(t),stages=[];
  assert.equal(await retainTargetVariant(f.browser,DUO_VARIANTS[2],s=>stages.push(s)),'same_one');
  assert.equal(await f.page.getByRole('heading',{level:2}).innerText(),expectedProduct(DUO_VARIANTS[2]));
  assert.equal(await f.page.getByRole('combobox').inputValue(),'1');
  assert.equal(await f.page.evaluate(()=>window.removals),3);
  assert.deepEqual(stages,['preloaded_bag_checked_at','variant_removed_1_at','variant_removed_2_at','variant_removed_3_at','variants_retained_at']);
});
test('already retained target causes zero removals',async t=>{
  const f=await fixture(t,{urls:[DUO_VARIANTS[0]]});
  assert.equal(await retainTargetVariant(f.browser,DUO_VARIANTS[0]),'same_one');
  assert.equal(await f.page.evaluate(()=>window.removals||0),0);
});
test('missing target stops without removing any other variant',async t=>{
  const f=await fixture(t,{urls:DUO_VARIANTS.slice(1)});
  await assert.rejects(()=>retainTargetVariant(f.browser,DUO_VARIANTS[0]),e=>e.code==='preloaded_target_missing');
  assert.equal(await f.page.evaluate(()=>window.removals||0),0);
});
test('unexpected quantities stop before deletion',async t=>{
  const f=await fixture(t,{quantity:2});
  await assert.rejects(()=>retainTargetVariant(f.browser,DUO_VARIANTS[0]),e=>e.code==='variant_quantity_not_one');
  assert.equal(await f.page.evaluate(()=>window.removals||0),0);
});
test('uncertain deletion is not retried and never deletes another line',async t=>{
  const f=await fixture(t,{uncertain:true});
  await assert.rejects(()=>retainTargetVariant(f.browser,DUO_VARIANTS[0]));
  assert.equal(await f.page.evaluate(()=>window.removals),1);
  assert.equal(await f.page.getByRole('heading',{level:2}).count(),4);
});
test('button detachment before async row update does not trigger premature next deletion',async t=>{
  const f=await fixture(t,{asyncRemove:true});
  assert.equal(await retainTargetVariant(f.browser,DUO_VARIANTS[0]),'same_one');
  assert.equal(await f.page.evaluate(()=>window.removals),3);
  assert.equal(await f.page.getByRole('heading',{level:2}).innerText(),expectedProduct(DUO_VARIANTS[0]));
});
