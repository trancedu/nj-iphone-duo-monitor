// Executed inside an explicitly selected Safari tab. No network/payment API calls.
export function safariDOM({op,args={}}) {
  const fail=code=>{throw new Error(code);};
  const norm=s=>(s||'').replace(/\s+/g,' ').trim();
  const visible=e=>!!e&&!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
  const name=e=>norm(e.getAttribute('aria-label')||norm((e.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' '))||Array.from(e.labels||[]).map(l=>l.textContent).join(' ')||e.textContent);
  const enabled=e=>!!e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true';
  const all=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const buttons=()=>all('button,[role="button"]').filter(visible);
  const one=items=>{if(items.length!==1)fail('missing_or_ambiguous_control');return items[0];};
  const click=e=>{if(!enabled(e)||!visible(e))fail('control_not_available');e.scrollIntoView({block:'center'});e.click();};
  const set=(e,value)=>{
    if(!enabled(e))fail('field_disabled');
    const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);
    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
    if(e.type==='tel'?e.value.replace(/\D/g,'')!==value.replace(/\D/g,''):e.value!==value)fail('field_readback_failed');
  };
  const radio=(pattern,root=document)=>all('input[type="radio"],[role="radio"]',root).filter(e=>pattern.test(name(e)));
  const checked=e=>typeof e.checked==='boolean'?e.checked:e.getAttribute('aria-checked')==='true';
  const check=e=>{if(!enabled(e))fail('radio_unavailable');if(!checked(e)){const label=Array.from(e.labels||[]).find(visible);click(label||e);}return checked(e.id?document.getElementById(e.id)||e:e);};
  const storeList=()=>all('fieldset').find(e=>/Select your pickup store:/i.test(e.querySelector('legend')?.textContent||''));
  const noAvailability=()=>!!storeList()&&/There[’']s no availability within your location\.\s*Please try another search\./i.test(norm(document.body?.innerText));
  const stores=()=>{const root=storeList();return root?all('input[type="radio"]',root).filter(e=>/^Apple\s/i.test(name(e))):[];};
  const slot=()=>document.getElementById('checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue');
  const bag=()=>all('[role="listitem"][data-autom^="bag-item-"]').map(e=>({title:norm(e.querySelector('h2,h3')?.textContent||''),quantity:e.querySelector('select')?.value||'',text:norm(e.textContent)}));
  const verifyBag=()=>{const items=bag();if(items.length!==1||items[0].title!==args.product||items[0].quantity!=='1')fail('bag_not_exactly_one_target');};
  const u=new URL(location.href);
  if(u.protocol!=='https:'||!(u.hostname==='www.apple.com'||/^secure\d*\.store\.apple\.com$/.test(u.hostname)))fail('unexpected_navigation');
  if(all('iframe[src*="captcha"],iframe[title*="CAPTCHA"]').length)fail('captcha_required');
  if(all('h1,h2').some(e=>/^(Sign in|Verify your identity)/i.test(norm(e.textContent))))fail('login_required');
  const productVisible=()=>all('h1,h2,h3,p,[data-autom]').some(e=>norm(e.textContent)===args.product);
  const sessionWarnings=()=>all('[role="dialog"],dialog,[aria-modal="true"]').filter(e=>visible(e)&&/Are you still shopping\?/i.test(norm(e.textContent)));
  const continueSessionButtons=()=>{
    const dialogs=sessionWarnings();
    const scopes=dialogs.length?dialogs:[document];
    const hasHeading=all('h1,h2,h3,[role="heading"]').some(e=>visible(e)&&/^Are you still shopping\?$/i.test(norm(e.textContent)));
    if(!dialogs.length&&!hasHeading)return [];
    return [...new Set(scopes.flatMap(root=>all('button,[role="button"]',root).filter(e=>visible(e)&&/^I[’']m still shopping$/i.test(name(e)))))];
  };
  if(op==='continueShoppingSession'){
    const candidates=continueSessionButtons();
    if(candidates.length!==1)fail('session_continue_missing_or_ambiguous');
    click(candidates[0]);return {clicked:true};
  }
  if(op==='rearmExpiredPickupStandby'){
    // Called only after a stopped/finished request; validate live inventory atomically.
    const d=safariDOM({op:'diagnosticState',args}),state=safariDOM({op:'standbyState',args});
    if(d.pickup_expiry_confirmed!==true||d.page.state!=='Fulfillment-init'||d.displayed_zip!==args.zip||!state.pickup_selected||state.expired||state.session_warning)return {rearmed:false};
    window.__duoPickupStoreSelected=false;
    window.__duoPickupContinueRequested=false;
    return {rearmed:true,...safariDOM({op:'armPickupStandby',args})};
  }
  if(op==='armPickupStandby'){
    const heading=all('h1,h2').some(e=>/How would you like to get your order\?/i.test(norm(e.textContent)));
    if((!args.explicit_test_reset&&window.__duoPickupStoreSelected)||window.__duoApplePayRequested||document.getElementById('co-options-applePay'))fail('standby_checkout_protected');
    // Fulfillment can replace its DOM between two AppleScript calls after reload.
    if(!heading||!storeList()||!stores().length||!norm(document.body?.textContent).includes(args.product))return {armed:false,ready:false};
    if(args.explicit_test_reset)window.__duoPickupStoreSelected=false;
    window.__duoStandbyPrepared=true;
    if(!window.__duoStandbyListener){
      window.__duoStandbyListener=true;
      document.addEventListener('change',e=>{if(e.isTrusted&&(stores().includes(e.target)||e.target===slot()))window.__duoPickupStoreSelected=true;},true);
    }
    return {armed:true,...safariDOM({op:'standbyState',args})};
  }
  if(op==='snapshot')return {url:location.href,title:document.title,ready:document.readyState,document_time_origin:performance.timeOrigin,focused:document.hasFocus(),bag:bag().map(({title,quantity})=>({title,quantity})),radios:all('input[type="radio"]').map(e=>({name:name(e),checked:e.checked,enabled:enabled(e)})),empty:all('h1').some(e=>/Your bag is empty/i.test(e.textContent)),buttons:buttons().map(e=>({id:e.id,name:name(e),enabled:enabled(e)}))};
  if(op==='standbyState'){
    const checkout=/^\/(?:shop\/(?:apw\/)?)?checkout(?:\/|$)/.test(u.pathname);
    const expired=all('h1,h2').some(e=>visible(e)&&/^Your session has expired\.?$/i.test(norm(e.textContent)))&&all('button,a,[role="button"]').some(e=>visible(e)&&/^Return to Bag$/i.test(name(e)));
    const protectedPage=!!window.__duoApplePayRequested||!!window.__duoPickupStoreSelected||!!document.getElementById('co-options-applePay')||all('h1,h2').some(e=>/pickup information|order confirmation|thank you for your order/i.test(norm(e.textContent)))||(!window.__duoStandbyPrepared&&(stores().some(checked)||!!slot()?.value));
    const matching=typeof args.product==='string'&&norm(document.body?.textContent).includes(args.product);
    const processing=all('img,[aria-busy="true"],[role="progressbar"]').some(e=>visible(e)&&(e.tagName!=='IMG'||name(e)==='Processing'));
    const zipInput=all('input[role="combobox"]').some(e=>visible(e)&&name(e)==='Zip Code or City, State');
    return {ready:checkout&&matching&&!!storeList()&&!protectedPage&&!expired,expired,session_warning:continueSessionButtons().length===1,protected:protectedPage,matching_product:matching,checkout,document_time_origin:performance.timeOrigin,pickup_ready:!processing&&!!storeList()&&visible(storeList())&&stores().length>0,zip_needed:zipInput,pickup_selected:radio(/^I[’']ll pick it up/i).some(checked)};
  }
  if(op==='performanceState'){
    const n=performance.getEntriesByType('navigation')[0];
    return {time_origin:performance.timeOrigin,now:performance.now(),navigation:n?{ttfb_ms:n.responseStart-n.requestStart,download_ms:n.responseEnd-n.responseStart,response_end_ms:n.responseEnd,dom_interactive_ms:n.domInteractive,dom_content_loaded_ms:n.domContentLoadedEventEnd,load_ms:n.loadEventEnd}:null,requests:performance.getEntriesByType('resource').filter(r=>['fetch','xmlhttprequest'].includes(r.initiatorType)).map(r=>({path:new URL(r.name,location.href).pathname,kind:r.initiatorType,start_ms:r.startTime,duration_ms:r.duration,response_start_ms:r.responseStart,response_end_ms:r.responseEnd})).slice(-40)};
  }
  if(op==='productReady')return {ready:productVisible()&&radio(/^No AppleCare coverage(?:\s|$)/).length===1};
  if(op==='configure') {
    if(!productVisible())fail('configuration_mismatch');
    for(const text of ['No trade-in','Connect to any carrier later']){const choices=radio(new RegExp('^'+text));if(choices.length===1)check(choices[0]);}
    return {configured:check(one(radio(/^No AppleCare coverage(?:\s|$)/)))};
  }
  if(op==='add') {
    if(!productVisible()||!one(radio(/^No AppleCare coverage(?:\s|$)/)).checked)fail('configuration_not_ready');
    click(one(buttons().filter(e=>name(e)==='Add to Bag')));return {clicked:true};
  }
  if(op==='reviewBag') {const b=buttons().filter(e=>name(e)==='Review Bag');if(b.length!==1)return {ready:false};click(b[0]);return {ready:true};}
  if(op==='checkout'||op==='checkoutReady') {
    verifyBag();let b=buttons().filter(e=>/^Check\s*out with\s*(?:Apple\s*|\uF8FF\s*)?Pay$/i.test(name(e)));
    if(b.length>1)b=b.filter(e=>e.id==='shoppingCart.actions.navApwCheckout');
    if(op==='checkoutReady')return {ready:b.length===1&&enabled(b[0])};
    click(one(b));return {clicked:true};
  }
  if(op==='pickup') {
    const choices=radio(/^I[’']ll pick it up/i);if(choices.length!==1)return {ready:false};return {ready:check(choices[0])};
  }
  if(op==='pickupReady') {
    if(all('img').some(e=>name(e)==='Processing'&&visible(e)))return {ready:false};
    const zip=all('input[role="combobox"]').find(e=>name(e)==='Zip Code or City, State'&&visible(e));
    return {ready:!!(storeList()&&visible(storeList())&&stores().length),zipNeeded:!!zip};
  }
  if(op==='zip') {
    if(!/^\d{5}$/.test(args.zip))fail('pickup_zip_required');
    const input=one(all('input[role="combobox"]').filter(e=>name(e)==='Zip Code or City, State'&&visible(e)));
    set(input,args.zip);click(one(buttons().filter(e=>name(e)==='Apply')));return {applied:true};
  }
  if(op==='stores'||op==='diagnosticState') {
    const zip=all('input[role="combobox"]').find(e=>name(e)==='Zip Code or City, State');
    const zipButton=buttons().map(name).find(s=>/^\d{5}(?:\s|$)/.test(s));
    const rawZip=zip?.value||zipButton?.match(/^\d{5}/)?.[0]||null;
    const pickup_expiry_confirmed=typeof args.product==='string'&&norm(document.body?.textContent).includes(args.product)&&all('h1,h2').some(e=>visible(e)&&/How would you like to get your order\?/i.test(norm(e.textContent)))&&!!storeList()&&visible(storeList())&&stores().length>0&&stores().every(e=>!enabled(e)&&/Currently unavailable|Unavailable for pickup|Not available/i.test(name(e)))&&!window.__duoApplePayRequested&&!document.getElementById('co-options-applePay')&&!all('img,[aria-busy="true"],[role="progressbar"]').some(e=>visible(e)&&(e.tagName!=='IMG'||name(e)==='Processing'));
    return {pickup_expiry_confirmed,page:{origin:u.origin,path:u.pathname,state:u.searchParams.get('_s')},displayed_zip:/^\d{5}$/.test(rawZip||'')?rawZip:null,no_availability:noAvailability(),
      stores:stores().map(e=>{const label=name(e);return {name:label,enabled:enabled(e),visible:visible(Array.from(e.labels||[]).find(visible)||e),store_id:((e.id+' '+e.value).match(/\bR\d{3,4}\b/)||[])[0]||null,availability_text:(label.match(/Currently unavailable|Unavailable for pickup|Not available|unavailable|Available Today|Available Tomorrow|Available for pickup/i)||[])[0]||null};})};
  }
  if(op==='moreStores') {if(noAvailability())return {expanded:false,noAvailability:true};const root=storeList();const b=root?all('button,[role="button"],a',root).filter(e=>visible(e)&&/^Show more stores\b/.test(name(e))):[];if(b.length!==1)return {expanded:false};click(b[0]);return {expanded:true};}
  if(op==='selectStore') {
    const matches=stores().filter(e=>args.store_id?/^R\d{3,4}$/.test(args.store_id)&&((e.id+' '+e.value).match(/\bR\d{3,4}\b/)||[])[0]===args.store_id:name(e)===args.name);
    const target=one(matches),alreadySelected=checked(target);
    window.__duoPickupStoreSelected=true;return {selected:check(target),alreadySelected};
  }
  const dates=()=>{const list=storeList();return list?radio(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s*\d{1,2}$/i,list):[];};
  if(op==='dates')return {dates:dates().map(e=>({name:name(e),enabled:enabled(e),checked:e.checked})),options:slot()?Array.from(slot().options).map(o=>({value:o.value,label:o.label,disabled:o.disabled})):[]};
  if(op==='selectDate'){return {selected:check(one(dates().filter(e=>name(e)===args.name)))};}
  if(op==='times')return {options:slot()?Array.from(slot().options).map(o=>({value:o.value,label:o.label,disabled:o.disabled})):[]};
  if(op==='selectTime'){const e=slot();if(!e||!Array.from(e.options).some(o=>o.value===args.value&&!o.disabled&&/^\d{1,2}:\d{2}\s*[ap]\.?m\.?/i.test(o.label)))fail('time_unavailable');if(e.value!==args.value)set(e,args.value);return {selected:e.value===args.value};}
  if(op==='continuePickup') {
    if(window.__duoPickupContinueRequested)return {clicked:true};
    if(all('img,[aria-busy="true"],[role="progressbar"]').some(e=>visible(e)&&(e.tagName!=='IMG'||name(e)==='Processing')))return {clicked:false};
    if(args.expected_store_id&&!stores().some(e=>checked(e)&&((e.id+' '+e.value).match(/\bR\d{3,4}\b/)||[])[0]===args.expected_store_id))fail('pickup_store_changed');
    if(args.expected_date&&!dates().some(e=>checked(e)&&name(e)===args.expected_date))fail('pickup_date_changed');
    if(args.expected_time){const e=slot(),o=e?.selectedOptions?.[0];if(!e||e.value!==args.expected_time||!o||o.disabled||!/^\d{1,2}:\d{2}\s*[ap]\.?m\.?/i.test(o.label)){
      if(args.allow_time_reselect)return {clicked:false,time_reset:true,options:e?Array.from(e.options).map(o=>({value:o.value,label:o.label,disabled:o.disabled})):[]};
      fail('pickup_time_not_selected');
    }}
    const b=one(buttons().filter(e=>name(e)==='Continue to Pickup Details'));if(!enabled(b))return {clicked:false};window.__duoPickupContinueRequested=true;click(b);return {clicked:true};
  }
  const finalButton=()=>document.getElementById('co-options-applePay');
  if(op==='detailsReady')return {ready:all('h1,h2').some(e=>norm(e.textContent)==='Now fill out your pickup information.')&&!!finalButton()};
  if(op==='fillContact'||op==='prepareContact') {
    if(!all('h1,h2').some(e=>norm(e.textContent)==='Now fill out your pickup information.')){if(op==='prepareContact')return {ready:false};fail('not_pickup_details');}
    if(op==='prepareContact'&&!['First Name','Last Name','Email Address','Phone Number'].every(label=>all('input').filter(e=>name(e)===label&&visible(e)&&enabled(e)).length===1))return {ready:false};
    if(!check(one(radio(/^I[’']ll pick it up$/))))return {filled:false};
    for(const [label,key] of [['First Name','first_name'],['Last Name','last_name'],['Email Address','email'],['Phone Number','phone']]) {
      const e=one(all('input').filter(e=>name(e)===label));
      if(key==='phone'?e.value.replace(/\D/g,'')!==args.contact[key]:e.value!==args.contact[key])set(e,args.contact[key]);
      if(key==='phone'?e.value.replace(/\D/g,'')!==args.contact[key]:e.value!==args.contact[key])fail('contact_not_verified');
    }
    return {filled:true,...(op==='prepareContact'?{ready:visible(finalButton())&&enabled(finalButton())}:{})};
  }
  if(op==='handoffReady')return {ready:visible(finalButton())&&enabled(finalButton()),finalButtonClicked:false};
  if(op==='requestApplePay') {
    if(!all('h1,h2').some(e=>norm(e.textContent)==='Now fill out your pickup information.'))fail('not_pickup_details');
    const button=finalButton();
    if(!button||!/^Continue with (?:Apple\s*|\uF8FF\s*)Pay$/i.test(name(button))||!visible(button)||!enabled(button))fail('apple_pay_handoff_not_ready');
    for(const [label,key] of [['First Name','first_name'],['Last Name','last_name'],['Email Address','email'],['Phone Number','phone']]){
      const e=one(all('input').filter(e=>name(e)===label));
      if(key==='phone'?e.value.replace(/\D/g,'')!==args.contact[key]:e.value!==args.contact[key])fail('contact_not_verified');
    }
    if(window.__duoApplePayRequested)fail('apple_pay_already_requested');
    // Mark BEFORE invoking the button; an uncertain response never permits retry.
    window.__duoApplePayRequested=true;
    click(button);return {requested:true,authenticated:false};
  }
  // No operation for biometric/device authentication, terms or order submission.
  fail('unsupported_safari_operation');
}
