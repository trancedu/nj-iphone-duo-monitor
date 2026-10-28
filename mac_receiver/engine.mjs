import {mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {fingerprint, Stop} from './protocol.mjs';
import {sanitizeObservation,appendDiagnostic} from './safari/diagnostics.mjs';
const now = () => new Date().toISOString();

export class Engine {
  constructor(config, browser) {
    this.config = config; this.browser = browser;
    mkdirSync(config.state_dir,{recursive:true,mode:0o700});
    this.file=join(config.state_dir,'events.json');
    this.state=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{active:null,events:{}};
    this.state.events=Object.assign(Object.create(null),this.state.events);
    for (const item of Object.values(this.state.events)) {
      if(['held','global_waiting'].includes(item.status)) {item.status='expired';item.reason='receiver_restarted';item.timestamps.finished_at=now();}
      if (['queued','running'].includes(item.status)) {
        item.status='interrupted'; item.reason='receiver_restarted'; item.timestamps.finished_at=now();
        this.state.active=item.event_id;
      }
    }
    browser.onTaskTabClosed=page=>this.tabClosed(page).catch(()=>{});
    this.save();
  }
  save() {
    writeFileSync(this.file+'.tmp',JSON.stringify(this.state,null,2),{mode:0o600});
    renameSync(this.file+'.tmp',this.file);
  }
  log(item,stage) {
    appendFileSync(join(this.config.state_dir,'events.jsonl'),JSON.stringify({at:now(),event_id:item.event_id,
      status:item.status,reason:item.reason,idle_watch_state:item.idle_watch_state,last_user_activity_at:item.last_user_activity_at,release_reason:item.release_reason,product_url:item.product_url,store_id:item.store_id,store_name:item.store_name,profile_label:this.config.profile_label,browser_backend:this.config.browser_backend||'chrome',stage,timestamps:item.timestamps})+'\n',{mode:0o600});
  }
  health() {
    this.expireHeld();
    return {status:'ok',mode:this.config.dry_run?'dry_run':'live',
      browser_ready:this.browser.ready(),active_event_id:this.state.active,...(this.config.handoff_idle_timeout_seconds?{handoff_idle_timeout_seconds:this.config.handoff_idle_timeout_seconds}:{}),
      ...(this.config.idle_bag_refresh_interval_seconds?{idle_bag_refresh_interval_seconds:this.config.idle_bag_refresh_interval_seconds}:{}),
      ...(this.config.standby_page?{standby_page:this.config.standby_page,idle_checkout_refresh_interval_seconds:this.config.idle_checkout_refresh_interval_seconds,checkout_session_check_interval_seconds:this.config.checkout_session_check_interval_seconds||60,pickup_zip:this.config.pickup_zip}:{}),
      ...(this.browser.lastSessionCheck?{checkout_session_watch:this.browser.lastSessionCheck}:{}),
      ready:this.config.dry_run||this.browser.ready(),pending_events:Object.values(this.state.events).filter(x=>x.status==='held').length,apple_pay_verified:'manual_verification_required'};
  }
  accept(event) {
    this.expireHeld();
    const prior=Object.hasOwn(this.state.events,event.event_id)?this.state.events[event.event_id]:null;
    if (prior) {
      if (prior.fingerprint!==fingerprint(event)) return {code:409,body:{event_id:event.event_id,status:'event_id_conflict'}};
      return {code:200,body:this.public(prior)};
    }
    if(Object.keys(this.state.events).length>=4096) return {code:429,body:{event_id:event.event_id,status:'event_capacity_reached'}};
    let status='queued';
    if (this.state.active) status=this.config.queue_while_busy?Object.values(this.state.events).filter(x=>x.status==='held').length<(this.config.max_pending_events||8)?'held':'queue_full':'busy';
    else if (!this.config.dry_run&&!this.browser.ready()) status=this.config.queue_when_browser_not_ready?'held':'browser_not_ready';
    const item={...event,fingerprint:fingerprint(event),status,timestamps:{detected_at:event.detected_at,received_at:now()}};
    this.state.events[event.event_id]=item;
    if (status==='queued') this.state.active=event.event_id;
    this.save(); this.log(item,'received');
    if (status==='queued') setImmediate(()=>this.execute(item));
    return {code:status==='busy'?409:status==='queue_full'?429:status==='browser_not_ready'?503:202,body:this.public(item)};
  }
  public(item) {
    return {event_id:item.event_id,status:item.status,reason:item.reason,timestamps:item.timestamps,...(item.feedback?{feedback:item.feedback}:{}),...(item.signal_feedback?{signal_feedback:item.signal_feedback}:{}),...(item.last_observation?{last_observation:item.last_observation,diagnostic_count:item.diagnostic_count}:{}),...(item.idle_watch_state?{idle_watch_state:item.idle_watch_state,last_user_activity_at:item.last_user_activity_at}:{}),...(item.release_reason?{release_reason:item.release_reason,reset_at:item.reset_at}:{})};
  }
  stage(item,name,detail) {
    item.timestamps[name]=now();
    if(detail){const observation=sanitizeObservation(detail);appendDiagnostic(join(this.config.state_dir,'diagnostics.jsonl'),{at:item.timestamps[name],event_id:item.event_id,stage:name,...observation});item.last_observation=observation;item.diagnostic_count=(item.diagnostic_count||0)+1;}
    this.save(); this.log(item,name);
  }
  async execute(item) {
    this.browser.activeTaskId=item.event_id;
    this.browser.activeProductURL=item.product_url;
    this.browser.requestedStore=item.store_name||null;
    item.status='running';this.save();
    this.stage(item,'execution_started_at');
    if (this.config.dry_run) {
      item.status='dry_run_completed';this.stage(item,'finished_at');this.state.active=null;this.save();this.dispatch();return;
    }
    if(this.browser.onEventStarted)try{
      Promise.resolve(this.browser.onEventStarted(item)).then(feedback=>{item.signal_feedback=feedback;this.stage(item,'signal_alert_dispatched_at');}).catch(()=>this.stage(item,'signal_alert_failed_at'));
    }catch{this.stage(item,'signal_alert_failed_at');}
    try {
      const result=await this.browser.prepare(item,(name,detail)=>this.stage(item,name,detail));
      item.status=result||'awaiting_user';
      if(item.status==='pickup_expired')item.reason='pickup_expired_after_timeout';
    } catch (error) {
      item.status=error instanceof Stop&&error.code==='pickup_task_deadline'?'lock_timeout':error instanceof Stop&&error.code==='pickup_stalled_yield'?'superseded':error instanceof Stop&&error.code==='pickup_unavailable'?'pickup_unavailable':'manual_review';
      item.reason=error instanceof Stop?error.code:error?.name==='TimeoutError'?'timeout':'browser_error';
    }
    // Once stock was found or checkout progressed, never navigate back even if
    // a later error is mislabeled as unavailable. Preserve the user's page.
    const progressed=['pickup_stock_found_at','store_selected_at','time_selected_at','pickup_time_at','details_navigation_at','details_page_ready_at','contact_verified_at','pickup_details_at','handoff_at'].some(key=>Object.hasOwn(item.timestamps,key));
    if(item.status==='pickup_unavailable'&&progressed){item.status='manual_review';item.reason='pickup_unavailable_after_selection_preserved';}
    this.stage(item,'finished_at');
    if(item.status==='superseded'||item.status==='lock_timeout'){
      item.release_reason=item.status==='superseded'?'stalled_pickup_handoff':'profile_deadline';this.stage(item,'stalled_released_at');
      this.reset(item.event_id,true);
      if(item.status==='superseded')this.onStalledReleased?.(item.event_id);else this.onProfileReleased?.(item.event_id);
      return; // The old workflow has unwound; never run its remaining steps or restore its page.
    }
    this.signaling=true;
    try { const feedback=await this.browser.handoff(item.status,item.reason);if(feedback){item.feedback=feedback;this.stage(item,feedback.audio_queued!==undefined?'feedback_dispatched_at':'feedback_completed_at');} }
    catch { item.reason=item.reason||'attention_signal_failed';this.save();this.log(item,'attention_signal_failed'); }
    finally {this.signaling=false;}
    if(['pickup_unavailable','pickup_expired'].includes(item.status)&&this.config.auto_release_unavailable) {
      this.releasing=true;
      try {
        if(item.status==='pickup_expired'){
          if(!this.browser.restoreExpiredPickup)throw new Stop('expiry_restore_unsupported');
          await this.browser.restoreExpiredPickup();
        }else await this.browser.seedIdle();
        item.release_reason='pickup_unavailable_return_to_standby';this.reset(item.event_id,true);
      } catch {item.reason='standby_restore_failed';this.save();this.log(item,'standby_restore_failed');}
      finally {this.releasing=false;}
      if(item.release_reason==='pickup_unavailable_return_to_standby'&&!this.state.active){
        this.onUnavailableReleased?.(item.event_id);
      }
    }
  }
  async watchIdle(nowMs=Date.now()) {
    const seconds=this.config.handoff_idle_timeout_seconds||0,item=this.state.events[this.state.active];
    if(!seconds||!item||item.status!=='awaiting_user'||this.releasing||this.signaling||!this.browser.inspectIdle)return false;
    if(this.nextIdlePoll&&nowMs<this.nextIdlePoll)return false;
    this.nextIdlePoll=nowMs+5000;
    let state;
    try{state=await this.browser.inspectIdle(item);}catch{state={status:'unreadable'};}
    const changed=item.idle_watch_state!==state.status||item.last_user_activity_at!==state.last_activity_at;
    item.idle_watch_state=state.status;
    if(state.last_activity_at)item.last_user_activity_at=state.last_activity_at;
    if(changed){this.save();this.log(item,'handoff_idle_watch');}
    if(this.state.active!==item.event_id||item.status!=='awaiting_user'||this.releasing||this.signaling)return false;
    if(state.status!=='tracking'||!Number.isFinite(state.idle_ms)||state.idle_ms<seconds*1000)return false;
    this.releasing=true;
    try{
      const claim=await this.browser.returnIfIdle(item,seconds*1000);
      if(!claim.claimed){item.idle_watch_state=claim.status;this.save();this.log(item,'idle_return_cancelled');return false;}
      await this.browser.seedIdle();
      item.status='idle_timeout_returned';item.release_reason='handoff_idle_timeout';
      this.stage(item,'idle_returned_at');
      try{item.idle_feedback=await this.browser.notifyIdleReturn?.(item);}catch{item.idle_feedback={notification_submitted:false};}
      return this.reset(item.event_id,true);
    }catch{
      item.status='manual_review';item.reason='idle_restore_failed';this.save();this.log(item,'idle_restore_failed');try{item.idle_feedback=await this.browser.handoff('manual_review','idle_restore_failed');this.save();}catch{}return false;
    }finally{this.releasing=false;}
  }
  reset(eventId,internalRelease=false) {
    if(this.signaling||this.releasing&&!internalRelease)throw new Stop('task_still_running');
    const item=this.state.events[eventId];
    if (!item || this.state.active!==eventId) return false;
    if (['queued','running'].includes(item.status)) throw new Stop('task_still_running');
    item.reset_at=now(); this.state.active=null;this.save();this.dispatch();return true;
  }
  expireHeld() {
    let changed=false;
    const ttl=Math.min(600,Math.max(1,this.config.held_event_ttl_seconds||180))*1000;
    for(const item of Object.values(this.state.events)) if(item.status==='held'&&Date.now()-Date.parse(item.detected_at)>ttl) {
      item.status='expired';item.reason='held_event_expired';item.timestamps.finished_at=now();changed=true;
    }
    if(changed) this.save();
  }
  dispatch() {
    if(this.state.active) return;
    this.expireHeld();
    const next=Object.values(this.state.events).filter(x=>x.status==='held').sort((a,b)=>a.timestamps.received_at.localeCompare(b.timestamps.received_at))[0];
    if(!next||!this.config.dry_run&&!this.browser.ready()) return;
    next.status='queued';this.state.active=next.event_id;this.save();this.log(next,'released_from_hold');
    setImmediate(()=>this.execute(next));
  }
  async tabClosed(page) {
    if(this.signaling||this.releasing||!this.config.release_on_task_tab_close||page!==this.browser.page) return;
    const item=this.state.events[this.state.active];
    if(!item||['queued','running'].includes(item.status)) return;
    // Only a live browser connection can release on a tab-close gesture.
    // ensurePage fails on browser disconnect; then the old lock stays intact.
    this.releasing=true;
    try {
      await this.browser.ensurePage();
      if(this.config.warm_product_pages)await this.browser.warmIdle();
      else if(this.config.preseed_on_release)await this.browser.seedIdle();
      item.release_reason='task_tab_closed';this.reset(item.event_id,true);
    } finally {this.releasing=false;}
  }
}
