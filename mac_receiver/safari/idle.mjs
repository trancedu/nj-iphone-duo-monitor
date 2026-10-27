// Injected into the exact handoff tab. Records only event ID and timestamps.
export function handoffActivity({op,args={}}) {
  const u=new URL(location.href),key='__iphoneDuoHandoffActivityV1';
  const allowed=u.protocol==='https:'&&(u.hostname==='www.apple.com'||/^secure\d*\.store\.apple\.com$/.test(u.hostname));
  const eligible=allowed&&!!document.getElementById('co-options-applePay')&&Array.from(document.querySelectorAll('h1,h2')).some(e=>e.textContent.replace(/\s+/g,' ').trim()==='Now fill out your pickup information.');
  if(!eligible)return {status:'page_changed',claimed:false};
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(args.event_id||''))return {status:'invalid_event',claimed:false};
  let tracker=window[key];
  if(!tracker&&op==='armIdle') {
    let lastAt=Date.now(),lastTick=performance.now(),paymentStarted=document.activeElement===document.getElementById('co-options-applePay'),claimed=false;
    const activity=event=>{
      if(!event.isTrusted)return;
      if(claimed){event.preventDefault();event.stopImmediatePropagation();return;}
      lastAt=Date.now();lastTick=performance.now();
      const target=event.target instanceof Element?event.target:null;
      const pay=target?.closest('#co-options-applePay');
      if(event.type==='submit')paymentStarted=true;
      if(pay&&(event.type==='pointerdown'||event.type==='click'||event.type==='keydown'&&['Enter',' '].includes(event.key)))paymentStarted=true;
    };
    for(const type of ['pointerdown','pointermove','click','keydown','input','change','wheel','touchstart','submit'])document.addEventListener(type,activity,{capture:true,passive:false});
    tracker=Object.freeze({eventId:args.event_id,read:()=>({status:paymentStarted?'payment_started':claimed?'return_started':'tracking',last_activity_at:new Date(lastAt).toISOString(),idle_ms:Math.max(0,performance.now()-lastTick),claimed:false}),claim:timeout=>{
      const state=tracker.read();
      if(paymentStarted||claimed||state.idle_ms<timeout)return state;
      claimed=true;
      document.getElementById('co-options-applePay').disabled=true;
      // Check and navigation share one JS task: a user action cannot slip
      // between the final idle check and the decision to leave this page.
      location.assign('https://www.apple.com/shop/bag');
      return {...state,status:'return_started',claimed:true};
    }});
    Object.defineProperty(window,key,{value:tracker,configurable:false,writable:false});
  }
  if(!tracker)return {status:'unarmed',claimed:false};
  if(tracker.eventId!==args.event_id)return {status:'wrong_event',claimed:false};
  if(op==='claimIdleReturn') {
    if(!Number.isInteger(args.timeout_ms)||args.timeout_ms<1000)return {status:'invalid_timeout',claimed:false};
    return tracker.claim(args.timeout_ms);
  }
  return tracker.read();
}
