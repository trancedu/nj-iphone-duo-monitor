import {Stop,escaped} from './protocol.mjs';

const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
const dateName=/^(january|february|march|april|may|june|july|august|september|october|november|december)\s*\d{1,2}$/i;
const slotSelector='[id="checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue"]';

export async function checkPickupRadio(page,radio) {
  if(await radio.count()!==1||!await radio.isEnabled())throw new Stop('pickup_radio_unavailable');
  if(await radio.isChecked())return;
  const id=await radio.getAttribute('id');
  const label=id?page.locator('label[for='+JSON.stringify(id)+']'):null;
  // Real Apple store cards overlay their native radio with its associated
  // label. Click that label rather than forcing a click through the overlay.
  if(label&&await label.count()===1&&await label.isVisible())await label.click();
  else await radio.check();
  if(!await radio.isChecked())throw new Stop('pickup_radio_not_selected');
}

export function validatePickupDetails(c) {
  for(const key of ['store_name','first_name','last_name']) if(typeof c[key]!=='string'||!c[key].trim()||c[key].length>200) throw new Stop('pickup_contact_config_required');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email||'')||!/^\d{10}$/.test(c.phone||'')) throw new Stop('pickup_contact_config_required');
  if(!Number.isInteger(c.preferred_slot)||c.preferred_slot<1||c.preferred_slot>20||!Number.isFinite(c.min_lead_minutes)||c.min_lead_minutes<0) throw new Stop('pickup_slot_config_invalid');
}

export function chooseTimeWindow(options,dateLabel,c,now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
  const m=dateLabel.toLowerCase().replace(/\s/g,'').match(/^([a-z]+)(\d{1,2})$/);
  if(!m||!months.includes(m[1])) throw new Stop('pickup_date_unrecognized');
  const today=Date.UTC(+parts.year,+parts.month-1,+parts.day);
  let date=Date.UTC(+parts.year,months.indexOf(m[1]),+m[2]);
  if(date<today) date=Date.UTC(+parts.year+1,months.indexOf(m[1]),+m[2]);
  const dayOffset=(date-today)/86400000;
  if(dayOffset<0||dayOffset>7) throw new Stop('pickup_date_unrecognized');
  const minutesNow=Number(parts.hour)*60+Number(parts.minute);
  const choices=options.filter(o=>o.value&&!o.disabled).map(o=>{
    const start=o.label.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
    if(!start||+start[1]>12||+start[2]>59) throw new Stop('pickup_time_unrecognized');
    return {...o,lead:dayOffset*1440+(+start[1]%12+(start[3].toLowerCase()==='p'?12:0))*60+(+start[2])-minutesNow};
  });
  const preferred=choices[Math.min(c.preferred_slot-1,choices.length-1)];
  if(preferred?.lead>=c.min_lead_minutes) return preferred;
  const sufficientlyLate=choices.find(o=>o.lead>=c.min_lead_minutes);
  if(sufficientlyLate) return sufficientlyLate;
  // User requested the one-hour margin as a preference; use the latest future
  // option if the day has no option satisfying that margin.
  const future=choices.filter(o=>o.lead>0);
  if(!future.length) throw new Stop('pickup_time_unavailable');
  return future.at(-1);
}

export async function preparePickupDetails(browser,stage,now=new Date()) {
  const c=browser.config.pickup_details;validatePickupDetails(c);
  const page=browser.page;
  await browser.guard();
  const list=page.locator(browser.config.selectors.store_list);
  const preferred=browser.requestedStore||c.store_name;
  const storeName=/^Apple\s/.test(preferred)?preferred:'Apple '+preferred;
  const store=list.getByRole('radio',{name:new RegExp('^'+escaped(storeName)+'(?:\\s|$)')});
  if(await store.count()!==1||!await store.isEnabled()) throw new Stop('configured_store_unavailable');
  await checkPickupRadio(page,store);
  if(!await store.isChecked()) throw new Stop('store_not_selected');
  const dates=list.getByRole('radio',{name:dateName});
  await dates.first().waitFor({state:'visible'});
  let selectedDate=null;
  for(const date of await dates.all()) if(await date.isChecked()&&await date.isEnabled()) selectedDate=date;
  if(!selectedDate) for(const date of await dates.all()) if(await date.isEnabled()) {await checkPickupRadio(page,date);selectedDate=date;break;}
  if(!selectedDate) throw new Stop('pickup_date_unrecognized');
  const dateLabel=await selectedDate.evaluate(e=>e.getAttribute('aria-label')||Array.from(e.labels||[]).map(l=>l.textContent).join(' ')||e.textContent);
  const slots=page.locator(slotSelector);await slots.waitFor({state:'visible'});
  await page.waitForFunction(selector=>{const e=document.querySelector(selector);return e&&Array.from(e.options).some(o=>o.value&&!o.disabled);},slotSelector);
  const options=await slots.evaluate(e=>Array.from(e.options).map(o=>({value:o.value,label:o.label,disabled:o.disabled})));
  const chosen=chooseTimeWindow(options,dateLabel,c,now);
  await slots.selectOption(chosen.value);
  if(await slots.inputValue()!==chosen.value) throw new Stop('pickup_time_not_selected');
  stage('pickup_time_at');
  await browser.guard();
  stage('details_navigation_at');
  // Wait for the actual destination form below, not a full page-load barrier.
  await page.getByRole('button',{name:'Continue to Pickup Details',exact:true}).click({noWaitAfter:true});
  await page.getByRole('heading',{name:'Now fill out your pickup information.',exact:true}).waitFor({state:'visible'});
  stage('details_page_ready_at');
  await browser.guard();
  const self=page.getByRole('radio',{name:'I’ll pick it up',exact:true});
  await self.check();
  stage('contact_fill_started_at');
  for(const [label,key] of [['First Name','first_name'],['Last Name','last_name'],['Email Address','email'],['Phone Number','phone']]) {
    const field=page.getByRole('textbox',{name:label,exact:true});await field.fill(c[key]);
    const actual=await field.inputValue();
    if(key==='phone'?actual.replace(/\D/g,'')!==c[key]:actual!==c[key]) throw new Stop('pickup_contact_not_verified');
  }
  const finalButton=page.locator('[id="co-options-applePay"]');
  await finalButton.waitFor({state:'visible'});
  if(await finalButton.count()!==1||!await finalButton.isEnabled()) throw new Stop('apple_pay_handoff_not_ready');
  stage('pickup_details_at');stage('handoff_at');
  if(browser.config.open_apple_pay_sheet===true){
    if(!/^Continue with (?:Apple\s*|\uF8FF\s*)Pay$/i.test((await finalButton.innerText()).trim()))throw new Stop('apple_pay_button_label_changed');
    await page.bringToFront();
    stage('apple_pay_sheet_requested_at');
    await finalButton.click({noWaitAfter:true}); // One click; no automatic retry after uncertainty.
    stage('apple_pay_button_clicked_at');
  }
  // Device/biometric authorization remains manual; no terms or order-submit action.
  return 'awaiting_user';
}
