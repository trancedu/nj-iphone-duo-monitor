import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {PickupBrowser} from '../browser.mjs';
import {chooseTimeWindow,preparePickupDetails,checkPickupRadio} from '../pickup_details.mjs';

const now=new Date('2026-10-26T21:00:00Z'); // 17:00 New York
const contact={store_name:'Apple West 14th Street',preferred_slot:2,min_lead_minutes:0,first_name:'Test',last_name:'User',email:'test@example.com',phone:'2025550123'};
const options=['6:45 p.m. – 7:00 p.m.','7:00 p.m. – 7:15 p.m.','7:15 p.m. – 7:30 p.m.','7:30 p.m. – 7:45 p.m.','7:45 p.m. – 8:00 p.m.'].map((label,i)=>({label,value:'slot-'+i,disabled:false}));
test('prefer second available slot, with no one-hour constraint',()=>{
  assert.equal(chooseTimeWindow(options,'october26',contact,now).value,'slot-1');
});
test('one-hour preference takes priority over ordinal; disabled options excluded',()=>{
  const late=new Date('2026-10-26T22:40:00Z'); // 18:40, fourth too early
  assert.equal(chooseTimeWindow(options,'october26',{...contact,preferred_slot:4,min_lead_minutes:60},late).value,'slot-4');
  assert.equal(chooseTimeWindow([{...options[0],disabled:true},...options.slice(1)],'october26',contact,now).value,'slot-2');
});
test('future day is recognized, no past slot or unknown date is accepted',()=>{
  assert.equal(chooseTimeWindow(options,'october27',contact,now).value,'slot-1');
  assert.throws(()=>chooseTimeWindow(options,'unknown',contact,now),e=>e.code==='pickup_date_unrecognized');
  assert.throws(()=>chooseTimeWindow(options,'october26',contact,new Date('2026-10-27T03:00:00Z')),e=>e.code==='pickup_time_unavailable');
});
test('details extension selects slot and fills contact, never clicks final Apple Pay',async t=>{
  const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
  const page=await chrome.newPage();page.setDefaultTimeout(1000);let forbidden=0;
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    let html;
    if(path==='/checkout') html=`<fieldset data-list><legend>Select your pickup store:</legend><label><input type="radio" name="store">Apple West 14th Street Available Today</label><label><input type="radio" name="date" checked>october26</label><select id="checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue">${options.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></fieldset><button onclick="location.href='/details'">Continue to Pickup Details</button>`;
    else if(path==='/details') html=`<h1>Now fill out your pickup information.</h1><label><input type="radio" checked>I’ll pick it up</label>${['First Name','Last Name','Email Address','Phone Number'].map(label=>`<label>${label}<input></label>`).join('')}<button id="co-options-applePay" onclick="location.href='/forbidden'">Continue with Apple Pay</button>`;
    else {forbidden++;html='<h1>Unexpected payment action</h1>';}
    await route.fulfill({contentType:'text/html; charset=utf-8',body:html});
  });
  await page.goto('https://www.apple.com/checkout');
  const browser=new PickupBrowser({selectors:{store_list:'[data-list]'},pickup_details:{...contact,store_name:'Apple Other Preferred Store'}});browser.page=page;browser.connected=true;browser.requestedStore='West 14th Street';
  const stages=[];
  assert.equal(await preparePickupDetails(browser,s=>stages.push(s),now),'awaiting_user');
  assert.equal(await page.getByRole('textbox',{name:'First Name',exact:true}).inputValue(),'Test');
  assert.equal(await page.getByRole('textbox',{name:'Email Address',exact:true}).inputValue(),'test@example.com');
  assert.equal(await page.locator('#co-options-applePay').isVisible(),true);
  assert.equal(forbidden,0);
  assert.deepEqual(stages,['pickup_time_at','details_navigation_at','details_page_ready_at','contact_fill_started_at','pickup_details_at','handoff_at']);
});
test('unavailable configured store stops without selecting another store',async t=>{
  const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
  const page=await chrome.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<fieldset data-list><label><input type="radio" disabled>Apple West 14th Street unavailable</label><label><input type="radio">Apple Other Store available</label></fieldset>'}));
  await page.goto('https://www.apple.com/checkout');
  const browser=new PickupBrowser({selectors:{store_list:'[data-list]'},pickup_details:contact});browser.page=page;browser.connected=true;
  await assert.rejects(()=>preparePickupDetails(browser,()=>{},now),e=>e.code==='configured_store_unavailable');
  assert.equal(await page.getByRole('radio',{name:'Apple Other Store available'}).isChecked(),false);
});
test('native store radio covered by its associated label is selected without force',async t=>{
  const chrome=await chromium.launch({channel:'chrome',headless:true});t.after(()=>chrome.close());
  const page=await chrome.newPage();
  await page.setContent('<div style="position:relative;width:400px;height:60px"><input id="store" type="radio" style="position:absolute;inset:0;width:100%;height:100%;opacity:0"><label for="store" style="position:absolute;inset:0;background:white;z-index:2"><span>Apple SoHo Available Today</span></label></div>');
  const radio=page.getByRole('radio',{name:'Apple SoHo Available Today'});
  await checkPickupRadio(page,radio);assert.equal(await radio.isChecked(),true);
});
