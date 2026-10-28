// Shared, bounded DOM inspection. No network calls, payment or store selection.
export function pickupLocationDOM({open=false}={}) {
  if(location.protocol!=='https:'||!(location.hostname==='www.apple.com'||/^secure\d*\.store\.apple\.com$/.test(location.hostname)))throw Error('unexpected_navigation');
  const norm=s=>(s||'').replace(/\s+/g,' ').trim();
  const visible=e=>!!e&&!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
  const label=e=>norm(e.getAttribute('aria-label')||(e.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ')||Array.from(e.labels||[]).map(l=>l.textContent).join(' ')||e.textContent);
  if(!/^\/(?:shop\/(?:apw\/)?)?checkout(?:\/|$)/.test(location.pathname))return {displayed_zip:null,editable:false,opened:false};
  const inputs=Array.from(document.querySelectorAll('input[role="combobox"]')).filter(e=>visible(e)&&/^Zip Code or City, State$/i.test(label(e)));
  if(inputs.length>1)throw Error('pickup_location_ambiguous');
  if(inputs.length===1){const value=norm(inputs[0].value);return {displayed_zip:/^\d{5}$/.test(value)?value:null,displayed_location:value.slice(0,100),editable:true,opened:false};}
  const controls=Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(e=>visible(e)&&(/^(?:\d{5})(?:\s|$)/.test(label(e))||/^East Rutherford(?:,?\s+NJ)?$/i.test(label(e))||/^(?:(?:Change|Edit)\s+(?:pickup\s+)?(?:location|zip code)|Zip Code or City, State)(?:\s|$)/i.test(label(e))));
  const zips=[...new Set(controls.map(e=>label(e).match(/\b(\d{5})\b/)?.[1]).filter(Boolean))];
  if(open){
    if(controls.length!==1)throw Error(controls.length?'pickup_location_ambiguous':'pickup_location_editor_missing');
    const control=controls[0];if(control.disabled||control.getAttribute('aria-disabled')==='true')throw Error('pickup_location_disabled');
    control.click();return {displayed_zip:zips.length===1?zips[0]:null,editable:false,opened:true};
  }
  return {displayed_zip:zips.length===1?zips[0]:null,displayed_location:controls.length===1?label(controls[0]).slice(0,100):null,editable:false,opened:false,editor_available:controls.length===1};
}
