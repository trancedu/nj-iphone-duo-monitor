import http from 'node:http';
import {openReceiverListeners} from './listeners.mjs';
import {readFileSync,mkdirSync,openSync,closeSync,writeFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createReceiver} from './server.mjs';
import {PickupBrowser} from './browser.mjs';
import {SafariPickupBrowser,pollSafariSlots} from './safari/browser.mjs';
import {listSafariWindows} from './safari/shopping.mjs';
import {audioQueueState} from './safari/feedback.mjs';
import {Engine} from './engine.mjs';
import {Stop,productURL,expectedProduct,privateIPv4,fingerprint} from './protocol.mjs';

export class ProfileRouter {
  constructor(config,slots,{onGlobalTimeout}={}){
    this.config=config;this.slots=slots;
    this.onGlobalTimeout=onGlobalTimeout;
    if(config.single_active_request){
      mkdirSync(config.state_dir,{recursive:true,mode:0o700});
      this.globalFile=join(config.state_dir,'global-lock.json');
      this.globalLock=existsSync(this.globalFile)?JSON.parse(readFileSync(this.globalFile)):{event_id:null};
      const active=slots.find(s=>s.engine.state.active);
      if(!this.globalLock.event_id&&active)this.claimGlobal(active.engine.state.active);
      for(const slot of slots)slot.engine.onUnavailableReleased=id=>{
        if(config.release_global_on_unavailable&&this.globalLock.event_id===id){
          this.globalLock={event_id:null,released_at:new Date().toISOString(),reason:'pickup_unavailable_return_to_standby'};
          this.saveGlobal();
          this.dispatchNotBefore=Date.now()+500;
        }
      };
    }
  }
  saveGlobal(){writeFileSync(this.globalFile+'.tmp',JSON.stringify(this.globalLock),{mode:0o600});renameSync(this.globalFile+'.tmp',this.globalFile);}
  claimGlobal(id){if(!this.globalFile||this.globalLock.event_id)return;this.globalLock={event_id:id,claimed_at:new Date().toISOString()};this.saveGlobal();}
  async watchGlobalTimeout(nowMs=Date.now()){
    this.expireWaiting(nowMs);
    if(!this.globalLock?.event_id){this.dispatchWaiting(nowMs);return false;}
    if(this.config.protect_stock_from_timeout!==false&&this.stockProtected())return false;
    const seconds=this.config.global_lock_timeout_seconds||0;
    if(!seconds||!this.globalLock?.event_id||!this.onGlobalTimeout||this.timeoutInFlight||nowMs<(this.timeoutRetryAt||0))return false;
    const claimed=Date.parse(this.globalLock.claimed_at);
    if(!Number.isFinite(claimed)||nowMs-claimed<seconds*1000)return false;
    const id=this.globalLock.event_id;this.timeoutInFlight=true;
    try{await this.onGlobalTimeout(id);return true;}
    catch{
      this.timeoutRetryAt=nowMs+30000;
      if(this.globalLock.event_id===id){this.globalLock.timeout_error_at=new Date().toISOString();this.saveGlobal();}
      return false;
    }finally{this.timeoutInFlight=false;}
  }
  stockProtected(){
    const slot=this.slotForEvent(this.globalLock?.event_id),item=slot?.engine.state.events[this.globalLock.event_id];
    return !!item&&(item.status==='awaiting_user'||['pickup_stock_found_at','store_selected_at','time_selected_at','pickup_time_at','details_navigation_at','contact_verified_at','handoff_at'].some(k=>Object.hasOwn(item.timestamps,k)));
  }
  dropBusyEvents(){return this.config.single_active_request&&this.config.drop_busy_events!==false;}
  waiting(){return this.slots.flatMap(slot=>Object.values(slot.engine.state.events).filter(e=>e.status==='global_waiting').map(item=>({slot,item})));}
  expireWaiting(nowMs=Date.now()){
    const ttl=this.dropBusyEvents()?0:(this.config.recent_request_ttl_seconds||0)*1000;
    for(const {slot,item} of this.waiting())if(!ttl||nowMs-Date.parse(item.timestamps.received_at)>ttl||nowMs-Date.parse(item.detected_at)>ttl){
      item.status='expired';item.reason='recent_request_expired';item.timestamps.finished_at=new Date(nowMs).toISOString();slot.engine.save();
    }
  }
  holdRecent(slot,event){
    this.expireWaiting();
    if(this.dropBusyEvents()){
      if(Object.keys(slot.engine.state.events).length>=4096)return {code:429,body:{event_id:event.event_id,status:'event_capacity_reached'}};
      const at=new Date().toISOString();
      // A terminal rejection is durable: retrying the same ID after unlock must
      // not unexpectedly start a task that arrived while the user was busy.
      const item={...event,fingerprint:fingerprint(event),status:'busy',reason:'busy_event_dropped',
        timestamps:{detected_at:event.detected_at,received_at:at,finished_at:at}};
      slot.engine.state.events[event.event_id]=item;slot.engine.save();slot.engine.log(item,'busy_event_dropped');
      return {code:409,body:{...this.public(item),active_event_id:this.globalLock.event_id}};
    }
    const ttl=this.config.recent_request_ttl_seconds||0;
    if(!ttl)return {code:409,body:{event_id:event.event_id,status:'busy',reason:'global_manual_unlock_required',active_event_id:this.globalLock.event_id}};
    const at=new Date().toISOString(),fresh=Date.now()-Date.parse(event.detected_at)<=ttl*1000&&Date.parse(event.detected_at)<=Date.now()+1000;
    if(Object.keys(slot.engine.state.events).length>=4096||this.waiting().length>=32)return {code:429,body:{event_id:event.event_id,status:'queue_full'}};
    const item={...event,fingerprint:fingerprint(event),status:fresh?'global_waiting':'expired',reason:fresh?'waiting_for_global_slot':'recent_request_expired',timestamps:{detected_at:event.detected_at,received_at:at,...(!fresh?{finished_at:at}:{})}};
    slot.engine.state.events[event.event_id]=item;slot.engine.save();slot.engine.log(item,'global_waiting');
    return {code:202,body:this.public(item)};
  }
  dispatchWaiting(nowMs=Date.now()){
    if(this.dropBusyEvents()){this.expireWaiting(nowMs);return false;}
    if(this.standbyMaintenancePromise||this.globalLock?.event_id||nowMs<(this.dispatchNotBefore||0)||this.slots.some(s=>s.engine.state.active||s.engine.releasing||s.engine.signaling))return false;
    this.expireWaiting(nowMs);
    const next=this.waiting().sort((a,b)=>b.item.timestamps.received_at.localeCompare(a.item.timestamps.received_at))[0];
    if(!next||!next.slot.browser.ready())return false;
    const {slot,item}=next;
    this.claimGlobal(item.event_id);item.status='queued';delete item.reason;
    slot.engine.state.active=item.event_id;slot.engine.save();slot.engine.log(item,'latest_recent_dispatched');
    setImmediate(()=>slot.engine.execute(item));return true;
  }
  blockedGlobally(event){return !!this.globalLock?.event_id&&this.globalLock.event_id!==event.event_id&&!this.slotForEvent(event.event_id);}
  slotForURL(url){return this.slots.find(s=>s.product_url===url||(s.aliases||[]).includes(url));}
  slotForEvent(id){return this.slots.find(s=>Object.hasOwn(s.engine.state.events,id));}
  get state(){return {active:this.slots.find(s=>s.engine.state.active)?.engine.state.active||null,events:Object.assign(Object.create(null),...this.slots.map(s=>s.engine.state.events))};}
  async beforeAccept(event){
    const slot=this.slotForEvent(event.event_id)||this.slotForURL(event.product_url);
    if(!slot)throw new Stop('unsupported_product_url');
    if(this.slotForEvent(event.event_id)||this.blockedGlobally(event))return;
    // Reserve before any asynchronous window check: the first arrival wins.
    this.claimGlobal(event.event_id);
    // Reserve the global gate first, then let at most one in-flight idle
    // refresh finish. No second profile starts maintenance after this claim.
    if(this.standbyMaintenancePromise)await this.standbyMaintenancePromise.catch(()=>{});
    if(this.config.browser_backend==='safari'){
      slot.browser.requestReservations=(slot.browser.requestReservations||0)+1;
      slot.browser.requestReservationsByEvent||=new Map();
      slot.browser.requestReservationsByEvent.set(event.event_id,(slot.browser.requestReservationsByEvent.get(event.event_id)||0)+1);
    }
    if(slot.browser.idleRefreshPromise)return;
    if(!slot.engine.state.active&&(this.config.browser_backend==='safari'||!slot.browser.ready())&&slot.browser.ensurePage)try{await slot.browser.ensurePage();}catch{}
  }
  accept(event){
    const slot=this.slotForEvent(event.event_id)||this.slotForURL(event.product_url);
    if(!slot)throw new Stop('unsupported_product_url');
    const existing=slot.engine.state.events[event.event_id];
    if(existing?.status==='global_waiting'){
      if(existing.fingerprint!==fingerprint(event))return {code:409,body:{event_id:event.event_id,status:'event_id_conflict'}};
      this.expireWaiting();return {code:200,body:this.public(existing)};
    }
    if(this.blockedGlobally(event))return this.holdRecent(slot,event);
    const prior=this.slotForEvent(event.event_id);
    if(!prior)this.claimGlobal(event.event_id);
    try{
      const result=slot.engine.accept(event);
      if(!prior&&this.globalFile&&result.body.status!=='queued'){
        this.globalLock={event_id:null};this.saveGlobal();
      }
      return {...result,body:{...result.body,profile_label:slot.label,product:expectedProduct(event.product_url)}};
    }finally{
      if(this.config.browser_backend==='safari'&&slot.browser.requestReservationsByEvent?.has(event.event_id)){
        const count=slot.browser.requestReservationsByEvent.get(event.event_id)-1;
        if(count)slot.browser.requestReservationsByEvent.set(event.event_id,count);else slot.browser.requestReservationsByEvent.delete(event.event_id);
        slot.browser.requestReservations=Math.max(0,(slot.browser.requestReservations||0)-1);
      }
    }
  }
  public(item){const slot=this.slotForEvent(item.event_id);return {...slot.engine.public(item),...(item.status==='global_waiting'?{status:'held'}:{}),profile_label:slot.label,product:expectedProduct(item.product_url)};}
  async reset(id){
    const slot=this.slotForEvent(id);
    const result=await (this.config.browser_backend==='safari'?this.resetSafari(slot,id):slot?.engine.reset(id)||false);
    if(this.globalFile&&this.globalLock.event_id===id&&(result||slot&&!slot.engine.state.active)){
      this.globalLock={event_id:null};this.saveGlobal();return true;
    }
    return result;
  }
  async resetSafari(slot,id){
    if(!slot||slot.engine.state.active!==id)return false;
    const engine=slot.engine,item=engine.state.events[id];
    if(engine.releasing||engine.signaling||['queued','running'].includes(item.status))throw new Stop('task_still_running');
    engine.releasing=true;
    try{await slot.browser.seedIdle();return engine.reset(id,true);}finally{engine.releasing=false;}
  }
  expireHeld(){for(const s of this.slots)s.engine.expireHeld();this.expireWaiting();}
  async maintainStandby(nowMs=Date.now()){
    if(this.standbyMaintenancePromise||this.slots.some(s=>s.engine.releasing||s.engine.signaling||s.browser.requestReservations||['queued','running'].includes(s.engine.state.events[s.engine.state.active]?.status)))return false;
    const start=this.standbyCursor||0;
    for(let offset=0;offset<this.slots.length;offset++){
      const index=(start+offset)%this.slots.length,slot=this.slots[index];
      const engine=slot.engine,item=engine.state.events[engine.state.active];
      // A reserved event not yet in Engine is about to execute. Yield all I/O.
      if(this.globalLock?.event_id&&!this.slotForEvent(this.globalLock.event_id))return false;
      const onExpired=item?async()=>{
        if(engine.state.active!==item.event_id)throw new Stop('expiry_owner_changed');
        item.status='session_expired_recovering';item.reason='checkout_session_expired';
        if(!item.timestamps.checkout_session_expired_at)engine.stage(item,'checkout_session_expired_at');
        engine.save();
      }:undefined;
      const task=slot.browser.refreshStandby?.(nowMs,{expiredOnly:!!this.globalLock?.event_id||!!item,recovering:item?.status==='session_expired_recovering'&&!!item.timestamps.checkout_session_expired_at,onExpired});
      if(!task)continue;
      this.standbyCursor=(index+1)%this.slots.length;
      const managed=(async()=>{
        const result=await task;
        if(item&&engine.state.active===item.event_id&&item.status==='session_expired_recovering'&&item.timestamps.checkout_session_expired_at&&result?.status==='standby_checkout'){
          item.status='session_expired_returned';item.release_reason='checkout_session_expired_return_to_standby';
          engine.stage(item,'session_recovered_at');engine.reset(item.event_id,true);
          if(this.globalLock?.event_id===item.event_id){
            this.globalLock={event_id:null,released_at:new Date().toISOString(),reason:item.release_reason};this.saveGlobal();this.dispatchNotBefore=Date.now()+500;
          }
        }
        return result;
      })();
      this.standbyMaintenancePromise=managed;
      try{await managed;}finally{this.standbyMaintenancePromise=null;}
      return true;
    }
    return false;
  }
  health(){
    const profiles=this.slots.map(s=>({profile_label:s.label,product_url:s.product_url,aliases:s.aliases||[],...s.engine.health()}));
    this.expireWaiting();
    return {status:'ok',...(this.config.listener_status?{listener_status:this.config.listener_status}:{}),busy_event_policy:this.dropBusyEvents()?'drop':'recent_candidates',recent_waiting:this.waiting().length,stock_page_protected:this.config.protect_stock_from_timeout!==false&&this.stockProtected(),protect_stock_from_timeout:this.config.protect_stock_from_timeout!==false,recent_request_ttl_seconds:this.dropBusyEvents()?0:this.config.recent_request_ttl_seconds||0,...(this.globalFile?{execution_policy:this.config.global_lock_timeout_seconds?'first_arrival_with_timeout':'first_arrival_until_manual_unlock',global_lock_timeout_seconds:this.config.global_lock_timeout_seconds||0,global_locked:!!this.globalLock.event_id,global_event_id:this.globalLock.event_id,...(this.globalLock.event_id?{global_lock_claimed_at:this.globalLock.claimed_at}:{} )}:{}),...(this.config.browser_backend==='safari'?{audio_queue:audioQueueState()}:{}),browser_backend:this.config.browser_backend||'chrome',mode:this.config.dry_run?'dry_run':'live',router:'canonical_url_to_independent_profile',browser_ready:profiles.every(s=>s.browser_ready),ready:profiles.some(s=>s.ready),active_event_id:this.state.active,active_event_ids:profiles.map(s=>s.active_event_id).filter(Boolean),profiles};
  }
}

export async function main() {
  const i=process.argv.indexOf('--config');if(i<0||!process.argv[i+1])throw new Stop('config_required');
  const file=resolve(process.argv[i+1]),cfg=JSON.parse(readFileSync(file));const root=dirname(file);
  cfg.state_dir=resolve(root,cfg.state_dir);
  if(!privateIPv4(cfg.host)||!Number.isInteger(cfg.port)||cfg.port<1024||cfg.port>65535||!Array.isArray(cfg.allowed_sources)||!cfg.allowed_sources.length||cfg.allowed_sources.some(s=>!privateIPv4(s))||typeof cfg.dry_run!=='boolean'||!Array.isArray(cfg.slots)||(cfg.slots.length<1||cfg.slots.length>6)||!cfg.selectors?.bag_item||!cfg.selectors?.store_list||!cfg.selectors?.store_row)throw new Stop('invalid_router_config');
  if(!cfg.dry_run&&cfg.selectors_verified!==true)throw new Stop('verify_selectors_before_live');
  const secret=process.env[cfg.secret_env||'PICKUP_SHARED_SECRET'];if(!secret||secret.length<32)throw new Stop('secret_too_short');
  if(cfg.handoff_idle_timeout_seconds!==undefined&&(!Number.isInteger(cfg.handoff_idle_timeout_seconds)||cfg.handoff_idle_timeout_seconds<0||cfg.handoff_idle_timeout_seconds>86400))throw new Stop('invalid_handoff_idle_timeout');
  const zipOverride=process.env.APPLE_PICKUP_ZIP;
  if(zipOverride!==undefined){if(!/^\d{5}$/.test(zipOverride))throw new Stop('invalid_pickup_zip');cfg.pickup_zip=zipOverride;}
  if(cfg.pickup_zip!==undefined&&!/^\d{5}$/.test(cfg.pickup_zip))throw new Stop('invalid_pickup_zip');
  if(cfg.idle_bag_refresh_interval_seconds===undefined)cfg.idle_bag_refresh_interval_seconds=300;
  if(!Number.isInteger(cfg.idle_bag_refresh_interval_seconds)||cfg.idle_bag_refresh_interval_seconds<0||cfg.idle_bag_refresh_interval_seconds>86400)throw new Stop('invalid_idle_bag_refresh_interval');
  if(!['chrome','safari'].includes(cfg.browser_backend||'chrome'))throw new Stop('invalid_browser_backend');
  if(cfg.standby_page!==undefined&&cfg.standby_page!=='pickup_checkout')throw new Stop('invalid_standby_page');
  if(cfg.standby_page==='pickup_checkout'&&cfg.browser_backend!=='safari')throw new Stop('checkout_standby_requires_safari');
  if(cfg.idle_checkout_refresh_interval_seconds!==undefined&&(!Number.isInteger(cfg.idle_checkout_refresh_interval_seconds)||cfg.idle_checkout_refresh_interval_seconds<60||cfg.idle_checkout_refresh_interval_seconds>86400))throw new Stop('invalid_checkout_refresh_interval');
  if(cfg.checkout_session_check_interval_seconds!==undefined&&(!Number.isInteger(cfg.checkout_session_check_interval_seconds)||cfg.checkout_session_check_interval_seconds<30||cfg.checkout_session_check_interval_seconds>3600))throw new Stop('invalid_session_check_interval');
  if(cfg.single_active_request!==undefined&&typeof cfg.single_active_request!=='boolean')throw new Stop('invalid_execution_policy');
  if(cfg.protect_stock_from_timeout!==undefined&&typeof cfg.protect_stock_from_timeout!=='boolean')throw new Stop('invalid_stock_timeout_policy');
  if(cfg.release_global_on_unavailable!==undefined&&typeof cfg.release_global_on_unavailable!=='boolean')throw new Stop('invalid_unavailable_release_policy');
  if(cfg.drop_busy_events!==undefined&&typeof cfg.drop_busy_events!=='boolean')throw new Stop('invalid_busy_event_policy');
  if(cfg.recent_request_ttl_seconds!==undefined&&(!Number.isInteger(cfg.recent_request_ttl_seconds)||cfg.recent_request_ttl_seconds<0||cfg.recent_request_ttl_seconds>10))throw new Stop('invalid_recent_request_ttl');
  if(cfg.global_lock_timeout_seconds!==undefined&&(!Number.isInteger(cfg.global_lock_timeout_seconds)||cfg.global_lock_timeout_seconds<0||cfg.global_lock_timeout_seconds>86400))throw new Stop('invalid_global_lock_timeout');
  if(cfg.global_lock_timeout_seconds&&(!cfg.single_active_request||!cfg.global_timeout_python||!cfg.global_timeout_unlock_script||!existsSync(cfg.global_timeout_python)||!existsSync(cfg.global_timeout_unlock_script)))throw new Stop('global_timeout_helper_required');
  const paths=[];let server,local,pollTimer,timeoutTimer,listeners;
  function lock(dir){
    mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,'receiver.lock');
    if(existsSync(path)){const pid=Number(readFileSync(path));try{process.kill(pid,0);throw new Stop('profile_already_running');}catch(e){if(e instanceof Stop||e.code!=='ESRCH')throw e;unlinkSync(path);}}
    const fd=openSync(path,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);paths.push(path);
  }
  try{
    lock(resolve(root,cfg.state_dir));const slots=[];const labels=new Set(),endpoints=new Set(),states=new Set();
    for(const s of cfg.slots){
      productURL(s.product_url);for(const u of s.aliases||[])productURL(u);
      const state_dir=resolve(root,s.state_dir);
      const endpoint=cfg.browser_backend==='safari'?s.safari_profile:s.cdp_endpoint;
      if(!endpoint||!/^[A-F]$/.test(s.label)||labels.has(s.label)||endpoints.has(endpoint)||states.has(state_dir))throw new Stop('duplicate_profile_slot');
      labels.add(s.label);endpoints.add(endpoint);states.add(state_dir);lock(state_dir);
      const c={...cfg,slots:undefined,profile_label:s.label,preseeded_product_url:s.product_url,preseed_on_release:true,warm_product_pages:false,cdp_endpoint:s.cdp_endpoint,safari_profile:s.safari_profile,state_dir};
      if(cfg.single_active_request)Object.assign(c,{queue_while_busy:false,queue_when_browser_not_ready:false,auto_release_unavailable:cfg.release_global_on_unavailable===true,release_on_task_tab_close:false,handoff_idle_timeout_seconds:0,idle_bag_refresh_interval_seconds:0});
      const browser=cfg.browser_backend==='safari'?new SafariPickupBrowser(c):new PickupBrowser(c);await browser.start();const engine=new Engine(c,browser);slots.push({...s,browser,engine});
    }
    const router=new ProfileRouter(cfg,slots);
    // Inspect restored locks promptly after a restart; this is a read-only
    // first check unless the page explicitly proves its session has expired.
    if(cfg.standby_page==='pickup_checkout'&&router.globalLock?.event_id)for(const slot of slots)slot.browser.lastStandbyCheckAt=Date.now()-60000;
    if(cfg.standby_page==='pickup_checkout'&&!router.globalLock?.event_id&&!slots.some(s=>s.engine.state.active)){
      for(const [index,slot] of slots.entries()){
        try{const prepared=await slot.browser.seedIdle();slot.browser.lastIdleRefreshAt=Date.now()+index*10000;console.info(JSON.stringify({event:'standby_checkout_startup',profile:slot.label,status:prepared.status,zip:prepared.zip}));}
        catch(error){console.info(JSON.stringify({event:'standby_checkout_startup',profile:slot.label,status:'failed',reason:error.code||'browser_error'}));}
      }
    }
    if(cfg.global_lock_timeout_seconds){
      router.onGlobalTimeout=async id=>{
        const {spawn}=await import('node:child_process');
        // A separate process stops this controller before returning the one
        // expired profile to Bag. Its old Playwright work cannot resume later.
        await new Promise((ok,bad)=>{
          mkdirSync(join(root,'logs'),{recursive:true,mode:0o700});
          const output=openSync(join(root,'logs/auto-unlock.log'),'a',0o600);
          let child;
          try{child=spawn(cfg.global_timeout_python,[cfg.global_timeout_unlock_script,'--expired-event',id],{detached:true,stdio:['ignore',output,output]});}finally{closeSync(output);}
          child.once('error',bad);child.once('exit',code=>code===0?ok():bad(new Stop('global_timeout_helper_failed')));child.unref();
        });
      };
      timeoutTimer=setInterval(()=>router.watchGlobalTimeout().catch(()=>{}),1000);timeoutTimer.unref();
    }
    if(cfg.browser_backend==='safari'){let polling=false;pollTimer=setInterval(async()=>{if(polling)return;polling=true;try{await pollSafariSlots(slots,await listSafariWindows());await router.maintainStandby();for(const slot of slots){if(!slot.engine.state.active&&!slot.engine.releasing&&!slot.engine.signaling)slot.browser.refreshIdleBag?.().catch(()=>{});await slot.engine.watchIdle();}}catch{}finally{polling=false;}},2000);pollTimer.unref();}
    ({server}=createReceiver(cfg,{ready:()=>true},secret,router));
    listeners=await openReceiverListeners(server,cfg,{onStatus:state=>console.info(JSON.stringify({event:'receiver_listener_status',...state,at:new Date().toISOString()}))});
    cfg.listener_status=listeners.state;
    console.log(JSON.stringify({status:'listening',mode:cfg.dry_run?'dry_run':'live',profiles:slots.map(s=>({label:s.label,product_url:s.product_url,aliases:s.aliases||[]}))}));
    const stop=()=>{clearInterval(pollTimer);clearInterval(timeoutTimer);listeners?.close();server.close();local?.close();for(const p of paths)if(existsSync(p))unlinkSync(p);process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }catch(e){clearInterval(pollTimer);clearInterval(timeoutTimer);listeners?.close();server?.close();local?.close();for(const p of paths)if(existsSync(p))unlinkSync(p);throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(JSON.stringify({status:'stopped',reason:e instanceof Stop?e.code:'router_start_failed',error_code:typeof e.code==='string'?e.code:null,error_type:e.name}));process.exit(1);});
