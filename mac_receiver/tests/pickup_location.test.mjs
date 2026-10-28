import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {pickupLocationDOM} from '../pickup_location.mjs';
import {PickupBrowser,correctPickupLocation} from '../browser.mjs';
for(const location of ['East Rutherford, NJ','10001','07094'])test(`location correction handles ${location} without selecting any store`,async t=>{
 const b=await chromium.launch({channel:'chrome',headless:true});t.after(()=>b.close());const page=await b.newPage();page.setDefaultTimeout(2000);
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<button id="location" onclick="document.getElementById('editor').hidden=false;this.hidden=true">${location}</button><div id="editor" hidden><label>Zip Code or City, State<input role="combobox" value="${location}"></label><button onclick="window.applied=document.querySelector('input').value;document.querySelector('fieldset').innerHTML='<label><input type=radio>Apple Queens Center Available Today</label>'">Apply</button></div><fieldset data-list><label><input type="radio" disabled>Apple American Dream unavailable</label></fieldset>`}));
 await page.goto('https://secure7.store.apple.com/shop/apw/checkout');
 const browser=new PickupBrowser({pickup_zip:'07094',selectors:{store_list:'[data-list]'}});browser.page=page;browser.connected=true;
 const changed=await correctPickupLocation(browser);assert.equal(changed,location!=='07094');
 assert.equal(await page.evaluate(()=>window.applied),location==='07094'?undefined:'07094');
 assert.equal(await page.locator('input:checked').count(),0);
 if(changed)assert.equal((await page.evaluate(pickupLocationDOM,{})).displayed_zip,'07094');
});
test('ambiguous location controls stop rather than click an arbitrary ZIP',async t=>{
 const b=await chromium.launch({channel:'chrome',headless:true});t.after(()=>b.close());const p=await b.newPage();await p.route('**/*',r=>r.fulfill({body:'<button>10001</button><button>10002</button>'}));await p.goto('https://secure7.store.apple.com/shop/apw/checkout');
 await assert.rejects(()=>p.evaluate(pickupLocationDOM,{open:true}),/pickup_location_ambiguous/);
});
test('city label remains unverified and is recorded rather than guessed as ZIP 07094',async t=>{
 const b=await chromium.launch({channel:'chrome',headless:true});t.after(()=>b.close());const p=await b.newPage();
 await p.route('**/*',r=>r.fulfill({body:'<button aria-label="Edit Zip Code or City, State, East Rutherford, NJ">East Rutherford, NJ</button>'}));
 await p.goto('https://secure7.store.apple.com/shop/apw/checkout');
 const state=await p.evaluate(pickupLocationDOM,{});
 assert.equal(state.displayed_zip,null);assert.match(state.displayed_location,/East Rutherford/);
 assert.equal(state.editor_available,true);
});
