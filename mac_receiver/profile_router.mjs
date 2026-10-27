import http from 'node:http';
import {readFileSync,mkdirSync,openSync,closeSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createReceiver} from './server.mjs';
import {PickupBrowser} from './browser.mjs';
import {SafariPickupBrowser,pollSafariSlots} from './safari/browser.mjs';
import {listSafariWindows} from './safari/shopping.mjs';
import {audioQueueState} from './safari/feedback.mjs';
import {Engine} from './engine.mjs';
import {Stop,productURL,expectedProduct,privateIPv4} from './protocol.mjs';

export class ProfileRouter {
  constructor(config,slots){this.config=config;this.slots=slots;}
  slotForURL(url){return this.slots.find(s=>s.product_url===url||(s.aliases||[]).includes(url));}
  slotForEvent(id){return this.slots.find(s=>Object.hasOwn(s.engine.state.events,id));}
  get state(){return {active:this.slots.find(s=>s.engine.state.active)?.engine.state.active||null,events:Object.assign(Object.create(null),...this.slots.map(s=>s.engine.state.events))};}
  async beforeAccept(event){
    const slot=this.slotForEvent(event.event_id)||this.slotForURL(event.product_url);
    if(!slot)throw new Stop('unsupported_product_url');
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
    try{
      const result=slot.engine.accept(event);
      return {...result,body:{...result.body,profile_label:slot.label,product:expectedProduct(event.product_url)}};
    }finally{
      if(this.config.browser_backend==='safari'&&slot.browser.requestReservationsByEvent?.has(event.event_id)){
        const count=slot.browser.requestReservationsByEvent.get(event.event_id)-1;
        if(count)slot.browser.requestReservationsByEvent.set(event.event_id,count);else slot.browser.requestReservationsByEvent.delete(event.event_id);
        slot.browser.requestReservations=Math.max(0,(slot.browser.requestReservations||0)-1);
      }
    }
  }
  public(item){const slot=this.slotForEvent(item.event_id);return {...slot.engine.public(item),profile_label:slot.label,product:expectedProduct(item.product_url)};}
  reset(id){const slot=this.slotForEvent(id);return this.config.browser_backend==='safari'?this.resetSafari(slot,id):slot?.engine.reset(id)||false;}
  async resetSafari(slot,id){
    if(!slot||slot.engine.state.active!==id)return false;
    const engine=slot.engine,item=engine.state.events[id];
    if(engine.releasing||engine.signaling||['queued','running'].includes(item.status))throw new Stop('task_still_running');
    engine.releasing=true;
    try{await slot.browser.seedIdle();return engine.reset(id,true);}finally{engine.releasing=false;}
  }
  expireHeld(){for(const s of this.slots)s.engine.expireHeld();}
  health(){
    const profiles=this.slots.map(s=>({profile_label:s.label,product_url:s.product_url,aliases:s.aliases||[],...s.engine.health()}));
    return {status:'ok',...(this.config.browser_backend==='safari'?{audio_queue:audioQueueState()}:{}),browser_backend:this.config.browser_backend||'chrome',mode:this.config.dry_run?'dry_run':'live',router:'canonical_url_to_independent_profile',browser_ready:profiles.every(s=>s.browser_ready),ready:profiles.some(s=>s.ready),active_event_id:this.state.active,active_event_ids:profiles.map(s=>s.active_event_id).filter(Boolean),profiles};
  }
}

export async function main() {
  const i=process.argv.indexOf('--config');if(i<0||!process.argv[i+1])throw new Stop('config_required');
  const file=resolve(process.argv[i+1]),cfg=JSON.parse(readFileSync(file));const root=dirname(file);
  if(!privateIPv4(cfg.host)||!Number.isInteger(cfg.port)||cfg.port<1024||cfg.port>65535||!Array.isArray(cfg.allowed_sources)||!cfg.allowed_sources.length||cfg.allowed_sources.some(s=>!privateIPv4(s))||typeof cfg.dry_run!=='boolean'||!Array.isArray(cfg.slots)||cfg.slots.length!==4||!cfg.selectors?.bag_item||!cfg.selectors?.store_list||!cfg.selectors?.store_row)throw new Stop('invalid_router_config');
  if(!cfg.dry_run&&cfg.selectors_verified!==true)throw new Stop('verify_selectors_before_live');
  const secret=process.env[cfg.secret_env||'PICKUP_SHARED_SECRET'];if(!secret||secret.length<32)throw new Stop('secret_too_short');
  if(cfg.handoff_idle_timeout_seconds!==undefined&&(!Number.isInteger(cfg.handoff_idle_timeout_seconds)||cfg.handoff_idle_timeout_seconds<0||cfg.handoff_idle_timeout_seconds>86400))throw new Stop('invalid_handoff_idle_timeout');
  const zipOverride=process.env.APPLE_PICKUP_ZIP;
  if(zipOverride!==undefined){if(!/^\d{5}$/.test(zipOverride))throw new Stop('invalid_pickup_zip');cfg.pickup_zip=zipOverride;}
  if(cfg.pickup_zip!==undefined&&!/^\d{5}$/.test(cfg.pickup_zip))throw new Stop('invalid_pickup_zip');
  if(cfg.idle_bag_refresh_interval_seconds===undefined)cfg.idle_bag_refresh_interval_seconds=300;
  if(!Number.isInteger(cfg.idle_bag_refresh_interval_seconds)||cfg.idle_bag_refresh_interval_seconds<0||cfg.idle_bag_refresh_interval_seconds>86400)throw new Stop('invalid_idle_bag_refresh_interval');
  if(!['chrome','safari'].includes(cfg.browser_backend||'chrome'))throw new Stop('invalid_browser_backend');
  const paths=[];let server,local,pollTimer;
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
      if(!endpoint||!/^[A-D]$/.test(s.label)||labels.has(s.label)||endpoints.has(endpoint)||states.has(state_dir))throw new Stop('duplicate_profile_slot');
      labels.add(s.label);endpoints.add(endpoint);states.add(state_dir);lock(state_dir);
      const c={...cfg,slots:undefined,profile_label:s.label,preseeded_product_url:s.product_url,preseed_on_release:true,warm_product_pages:false,cdp_endpoint:s.cdp_endpoint,safari_profile:s.safari_profile,state_dir};
      const browser=cfg.browser_backend==='safari'?new SafariPickupBrowser(c):new PickupBrowser(c);await browser.start();const engine=new Engine(c,browser);slots.push({...s,browser,engine});
    }
    const router=new ProfileRouter(cfg,slots);
    if(cfg.browser_backend==='safari'){let polling=false;pollTimer=setInterval(async()=>{if(polling)return;polling=true;try{await pollSafariSlots(slots,await listSafariWindows());for(const slot of slots){if(!slot.engine.state.active&&!slot.engine.releasing&&!slot.engine.signaling)slot.browser.refreshIdleBag?.().catch(()=>{});await slot.engine.watchIdle();}}catch{}finally{polling=false;}},2000);pollTimer.unref();}
    ({server}=createReceiver(cfg,{ready:()=>true},secret,router));
    await new Promise((ok,bad)=>{server.once('error',bad);server.listen(cfg.port,cfg.host,ok);});
    if(!cfg.host.startsWith('127.')){local=http.createServer(server.listeners('request')[0]);local.requestTimeout=5000;local.headersTimeout=5000;local.timeout=5000;await new Promise((ok,bad)=>{local.once('error',bad);local.listen(cfg.port,'127.0.0.1',ok);});}
    console.log(JSON.stringify({status:'listening',mode:cfg.dry_run?'dry_run':'live',profiles:slots.map(s=>({label:s.label,product_url:s.product_url,aliases:s.aliases||[]}))}));
    const stop=()=>{clearInterval(pollTimer);server.close();local?.close();for(const p of paths)if(existsSync(p))unlinkSync(p);process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }catch(e){clearInterval(pollTimer);server?.close();local?.close();for(const p of paths)if(existsSync(p))unlinkSync(p);throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(JSON.stringify({status:'stopped',reason:e instanceof Stop?e.code:'router_start_failed'}));process.exit(1);});
