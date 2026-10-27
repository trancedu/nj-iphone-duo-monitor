// Production adapter. Engine owns deduplication, held queues and durable locks.
import {SafariWindow,listSafariWindows,prepareSafari,waitFor} from './shopping.mjs';
import {signalSafari} from './feedback.mjs';
import {Stop,expectedProduct} from '../protocol.mjs';
export class SafariPickupBrowser {
  constructor(config,{listWindows=listSafariWindows,Window=SafariWindow,prepare=prepareSafari,signal=signalSafari}={}) {
    this.config=config;this.listWindows=listWindows;this.Window=Window;this.workflow=prepare;this.signal=signal;this.connected=false;this.page=null;this.requestReservations=0;this.idleRefreshPromise=null;this.lastIdleRefreshAt=Date.now();
  }
  ready(){return this.connected&&!!this.page&&!this.page.closed;}
  async start(){await this.ensurePage();}
  async ensurePage(){
    try {
      const matches=(await this.listWindows()).filter(w=>w.name.startsWith(this.config.safari_profile+' — '));
      if(matches.length!==1)throw new Stop(matches.length?'safari_profile_window_ambiguous':'safari_profile_window_missing');
      const w=matches[0];if(w.tabs!==1)throw new Stop('safari_single_test_tab_required');
      const window=new this.Window(w.id,this.config.safari_profile);
      await window.call('snapshot');
      if(this.page?.id!==w.id){this.page={id:w.id,closed:false};this.lastIdleRefreshAt=Date.now();}
      this.window=window;this.connected=true;
    }catch(e){this.connected=false;throw e;}
  }
  onEventStarted(item){
    this.eventAlert={id:item.event_id,queued:false};
    return this.signal(null,{status:'inventory_signal'},{event_id:item.event_id,state_dir:this.config.state_dir,mode:'production',profile:this.config.safari_profile,product:expectedProduct(item.product_url)}).then(receipt=>{
      if(this.eventAlert?.id===item.event_id)this.eventAlert.queued=receipt.audio_queued===true||receipt.sound_played===true;
      return receipt;
    });
  }
  async prepare(event,stage){
    if(this.idleRefreshPromise)await this.idleRefreshPromise.catch(()=>{});
    await this.ensurePage();
    const cfg={...this.config,handoff_event_id:event.event_id,test_any_available_store:false,pickup_details:{...this.config.pickup_details}};
    cfg.pickup_zip=process.env.APPLE_PICKUP_ZIP??event.pickup_zip??this.config.pickup_zip;
    if(event.store_name)cfg.pickup_details.store_name=/^Apple\s/.test(event.store_name)?event.store_name:'Apple '+event.store_name;
    const context={backend:'safari',profile:this.config.safari_profile,window_id:this.window.id,requested_store_name:cfg.pickup_details.store_name,requested_store_id:event.store_id};
    const observe=(name,detail)=>stage(name,detail?{...detail,...context}:undefined);
    try{
      this.lastResult=await this.workflow(this.window,event.product_url,cfg,{stage:observe});
      if(this.lastResult.status==='pickup_unavailable')throw new Stop('pickup_unavailable');
      return this.lastResult.status;
    }catch(error){
      if(!(error instanceof Stop&&error.code==='pickup_unavailable')){
        let diagnostic={};try{diagnostic=await this.window.call('diagnosticState');}catch{}
        observe('pickup_failure_observed_at',{...diagnostic,kind:'pickup_failure',error_code:error instanceof Stop?error.code:'browser_error'});
      }
      throw error;
    }
  }
  async seedIdle(){
    await this.ensurePage();
    const result=await this.workflow(this.window,this.config.preseeded_product_url,this.config,{seedOnly:true});
    this.lastIdleRefreshAt=Date.now();
    return result;
  }
  async handoff(status,reason){
    if(status==='awaiting_user'&&this.config.handoff_idle_timeout_seconds>0)try{await this.window.call('armIdle',{event_id:this.activeTaskId});}catch{}
    return this.signal(this.window,{status,reason},{mute_audio:status==='awaiting_user'&&this.eventAlert?.id===this.activeTaskId&&this.eventAlert.queued,event_id:this.activeTaskId,state_dir:this.config.state_dir,mode:this.config.dry_run?'test':'production',profile:this.config.safari_profile,product:expectedProduct(this.activeProductURL||this.config.preseeded_product_url)});
  }
  async inspectIdle(item){
    if(!this.ready())return {status:'browser_not_ready'};
    let state=await this.window.call('idleState',{event_id:item.event_id});
    if(state.status==='unarmed')state={status:'tracking_lost'};
    return state;
  }
  async returnIfIdle(item,timeoutMs){
    const result=await this.window.call('claimIdleReturn',{event_id:item.event_id,timeout_ms:timeoutMs});
    if(result.claimed)await waitFor(async()=>{const s=await this.window.call('snapshot');return new URL(s.url).pathname==='/shop/bag'&&(s.empty||s.bag.length);},this.config.step_timeout_ms||20000);
    return result;
  }
  async notifyIdleReturn(item){
    return this.signal(null,{status:'idle_timeout_returned'},{event_id:item.event_id,state_dir:this.config.state_dir,mode:'production',profile:this.config.safari_profile,product:expectedProduct(item.product_url)});
  }

  refreshIdleBag(now=Date.now()){
    if(this.idleRefreshPromise)return this.idleRefreshPromise;
    const seconds=this.config.idle_bag_refresh_interval_seconds??300;
    if(!seconds||!this.ready()||this.requestReservations||now-this.lastIdleRefreshAt<seconds*1000)return Promise.resolve({status:'skipped'});
    this.lastIdleRefreshAt=now;
    const task=this._refreshIdleBag();this.idleRefreshPromise=task;
    task.finally(()=>{if(this.idleRefreshPromise===task)this.idleRefreshPromise=null;}).catch(()=>{});
    return task;
  }
  async _refreshIdleBag(){
    const product=expectedProduct(this.config.preseeded_product_url);
    const valid=s=>{try{return !s.focused&&new URL(s.url).origin==='https://www.apple.com'&&new URL(s.url).pathname==='/shop/bag'&&s.ready==='complete'&&s.bag.length===1&&s.bag[0].title===product&&s.bag[0].quantity==='1';}catch{return false;}};
    try{
      const before=await this.window.call('snapshot');
      if(!valid(before))return {status:'skipped'};
      await this.window.reload();
      await waitFor(async()=>{const s=await this.window.call('snapshot');return s.document_time_origin!==before.document_time_origin&&valid(s)?s:null;},this.config.step_timeout_ms||20000,500);
      console.info(JSON.stringify({event:'idle_bag_refresh',profile:this.config.safari_profile,status:'refreshed',at:new Date().toISOString()}));
      return {status:'refreshed'};
    }catch(error){
      console.info(JSON.stringify({event:'idle_bag_refresh',profile:this.config.safari_profile,status:'failed',reason:error instanceof Stop?error.code:'browser_error',at:new Date().toISOString()}));
      return {status:'failed'};
    }
  }

}
// A single metadata poll covers all four profiles. Do not treat a Safari quit,
// restart, or loss of ALL known windows as the user's per-task close gesture.
export async function pollSafariSlots(slots,windows){
  const ids=new Set(windows.map(w=>w.id));
  const anyKnown=slots.some(s=>s.browser.page&&ids.has(s.browser.page.id));
  for(const s of slots){
    const b=s.browser,page=b.page;
    if(page&&!ids.has(page.id)){
      b.connected=false;
      if(anyKnown){page.closed=true;if(s.engine.state.active)await s.engine.tabClosed(page).catch(()=>{});}
    }
    // An idle missing profile can hold an incoming event until its window is
    // reopened. A locked active task is never released by a Safari restart.
    if(!s.engine.state.active){
      if(!b.ready()&&windows.some(w=>w.name?.startsWith(b.config.safari_profile+' — ')))try{await b.ensurePage();}catch{}
      if(b.ready())s.engine.dispatch?.();
    }
  }
}
