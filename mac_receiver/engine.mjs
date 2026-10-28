import {mkdirSync, readFileSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fingerprint, Stop} from './protocol.mjs';
import {sanitizeObservation,appendDiagnostic,safeErrorCode} from './safari/diagnostics.mjs';
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
        if(item.timestamps.guest_order_requested_at)item.status='awaiting_user';
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
    const at=now(),ms=Date.parse(at),age=t=>Number.isFinite(Date.parse(t))?ms-Date.parse(t):null;
    const trace={sequence:(item.trace_sequence||0)+1,previous_stage:item.trace_last_stage||null,since_previous_stage_ms:age(item.trace_last_at),since_received_ms:age(item.timestamps?.received_at),since_execution_ms:age(item.timestamps?.execution_started_at),signal_age_ms:age(item.timestamps?.detected_at),active_event_id:this.state.active,lock_owned:this.state.active===item.event_id,checkout_method:this.config.checkout_method||'apple_pay',simulation_no_payment:item.simulation_no_payment===true};
    item.trace_sequence=trace.sequence;item.trace_last_stage=stage;item.trace_last_at=at;
    appendDiagnostic(join(this.config.state_dir,'events.jsonl'),{schema_version:2,at,event_id:item.event_id,...trace,
      status:item.status,reason:item.reason,idle_watch_state:item.idle_watch_state,last_user_activity_at:item.last_user_activity_at,release_reason:item.release_reason,payment_watch:item.payment_watch,payment_failure_retry_of:item.payment_failure_retry_of,product_url:item.product_url,store_id:item.store_id,store_name:item.store_name,profile_label:this.config.profile_label,browser_backend:this.config.browser_backend||'chrome',stage,timestamps:item.timestamps});
  }
  health() {
    this.expireHeld();
    return {status:'ok',mode:this.config.dry_run?'dry_run':'live',
      browser_ready:this.browser.ready(),retry_unknown_orders:this.config.guest_retry_unknown_orders===true,recovery_pending:this.state.recovery_pending||null,recovery_retry_at:this.state.recovery_retry_at||null,automation_blocked:this.browser.automationBlocked===true,active_event_id:this.state.active,...(this.config.handoff_idle_timeout_seconds?{handoff_idle_timeout_seconds:this.config.handoff_idle_timeout_seconds}:{}),
      ...(this.config.idle_bag_refresh_interval_seconds?{idle_bag_refresh_interval_seconds:this.config.idle_bag_refresh_interval_seconds}:{}),
      ...(this.config.standby_page?{standby_page:this.config.standby_page,idle_checkout_refresh_interval_seconds:this.config.idle_checkout_refresh_interval_seconds,checkout_session_check_interval_seconds:this.config.checkout_session_check_interval_seconds||60,pickup_zip:this.config.pickup_zip}:{}),
      ...(this.browser.lastSessionCheck?{checkout_session_watch:this.browser.lastSessionCheck}:{}),
      ready:this.config.dry_run||this.browser.ready(),...(this.config.standby_page?{standby_page_verified:!this.state.active&&this.browser.lastStandbyReady===true}:{}),pending_events:Object.values(this.state.events).filter(x=>x.status==='held').length,apple_pay_verified:'manual_verification_required'};
  }
  async retryPendingRecovery(nowMs=Date.now()){
    const id=this.state.recovery_pending,item=this.state.events[id];
    if(!item||this.state.active||this.releasing||this.signaling||nowMs<(this.state.recovery_retry_at||0))return false;
    this.releasing=true;this.stage(item,'automatic_recovery_retry_started_at');
    try{
      if(item.recovery_after_unknown){
        const result=await this.browser.rearmAfterUnknownOrder(item,(name,detail)=>this.stage(item,name,detail));if(result?.observed_success){this.onGuestOutcome?.(item,'success');item.late_order_confirmed=true;}
      }else if(item.recovery_after_success){
        await this.browser.rearmAfterGuestSuccess(item,(name,detail)=>this.stage(item,name,detail),{confirmedRecovery:true});item.rearm_pending=false;
      }else if(item.recovery_after_confirmed_failure){
        const state=await this.browser.inspectPaymentFailure(item);
        if(state.recoverable)await this.browser.recoverPaymentFailure(item);
        else await this.browser.restoreBeforeGuestSubmit(item);
      }else await this.browser.restoreBeforeGuestSubmit(item);
      item.status=item.recovery_after_success||item.late_order_confirmed?'order_confirmed':item.recovery_after_unknown?'order_result_unknown_released':'recovered_waiting_for_signal';delete this.state.recovery_pending;delete this.state.recovery_retry_at;delete this.state.recovery_attempts;
      this.stage(item,'automatic_recovery_pickup_ready_at');return true;
    }catch(error){
      item.reason=safeErrorCode(error,'recovery_retry_failed');this.state.recovery_attempts=(this.state.recovery_attempts||0)+1;
      // Retrying page preparation is rate-limited, never a repeated purchase.
      this.state.recovery_retry_at=nowMs+Math.min(180000,10000*2**Math.min(5,this.state.recovery_attempts));
      this.stage(item,'automatic_recovery_retry_failed_at',{kind:'guest_recovery',error_code:item.reason});return false;
    }finally{this.releasing=false;this.onProfileReleased?.(item.event_id);}
  }
  pruneHistory(max=2048){
    const records=Object.values(this.state.events);if(records.length<=max)return;
    const removable=records.filter(e=>e.event_id!==this.state.active&&!['queued','running','held','global_waiting','order_result_unknown'].includes(e.status)&&!e.rearm_pending&&Date.now()-Date.parse(e.timestamps?.received_at)>600000).sort((a,b)=>a.timestamps.received_at.localeCompare(b.timestamps.received_at));
    let removed=0,remaining=records.length;for(const e of removable){if(remaining<=max)break;delete this.state.events[e.event_id];remaining--;removed++;}
    if(removed){appendDiagnostic(join(this.config.state_dir,'events.jsonl'),{at:now(),stage:'terminal_history_compacted',removed});this.save();}
  }
  accept(event) {
    this.expireHeld();
    const prior=Object.hasOwn(this.state.events,event.event_id)?this.state.events[event.event_id]:null;
    if (prior) {
      if (prior.fingerprint!==fingerprint(event)) {this.log(prior,'duplicate_event_conflict');return {code:409,body:{event_id:event.event_id,status:'event_id_conflict'}};}
      this.log(prior,'duplicate_event_ignored');return {code:200,body:this.public(prior)};
    }
    if(Object.keys(this.state.events).length>=4096)this.pruneHistory();
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
    return {event_id:item.event_id,status:item.status,reason:item.reason,timestamps:item.timestamps,...(item.restore_result?{restore_result:item.restore_result}:{}),...(item.feedback?{feedback:item.feedback}:{}),...(item.signal_feedback?{signal_feedback:item.signal_feedback}:{}),...(item.last_observation?{last_observation:item.last_observation,diagnostic_count:item.diagnostic_count}:{}),...(item.payment_watch?{payment_watch:item.payment_watch}:{}),...(item.idle_watch_state?{idle_watch_state:item.idle_watch_state,last_user_activity_at:item.last_user_activity_at}:{}),...(item.release_reason?{release_reason:item.release_reason,reset_at:item.reset_at}:{})};
  }
  stage(item,name,detail) {
    if(name==='guest_order_requested_at'&&this.beforeGuestSubmission)this.beforeGuestSubmission(item);
    if(name==='guest_order_click_returned_at')this.onGuestOutcome?.(item,'submitted');
    item.timestamps[name]=now();
    if(detail){const observation=sanitizeObservation(detail);appendDiagnostic(join(this.config.state_dir,'diagnostics.jsonl'),{at:item.timestamps[name],event_id:item.event_id,stage:name,...observation});item.last_observation=observation;item.diagnostic_count=(item.diagnostic_count||0)+1;}
    this.save(); this.log(item,name);
    if(name==='apple_pay_sheet_requested_at')this.armPaymentDeadline(item);
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
      item.reason=error instanceof Stop?error.code:error?.name==='TimeoutError'?'timeout':/^[a-z][a-z0-9_]{1,79}$/.test(error?.message||'')?error.message:'browser_error';
      this.stage(item,'execution_error_at',{kind:'execution_error',error_code:error instanceof Stop?error.code:/^[a-z][a-z0-9_]{1,79}$/.test(error?.message||'')?error.message:item.reason});
    }
    if(this.config.checkout_method==='guest_credit'&&item.timestamps.guest_order_requested_at&&item.status!=='awaiting_user'){item.status='awaiting_user';item.reason='guest_submission_result_pending';}
    // Once stock was found or checkout progressed, never navigate back even if
    // a later error is mislabeled as unavailable. Preserve the user's page.
    const progressed=['pickup_stock_found_at','store_selected_at','time_selected_at','pickup_time_at','details_navigation_at','details_page_ready_at','contact_verified_at','pickup_details_at','handoff_at'].some(key=>Object.hasOwn(item.timestamps,key));
    if(item.status==='pickup_unavailable'&&progressed){item.status='manual_review';item.reason='pickup_unavailable_after_selection_preserved';}
    this.stage(item,'finished_at');
    if(item.reason&&item.status!=='pickup_unavailable')void this.browser.captureFailureEvidence?.(item)?.catch(()=>{});
    if(item.timestamps.apple_pay_sheet_requested_at&&Date.now()-Date.parse(item.timestamps.apple_pay_sheet_requested_at)>=10000&&this.browser.expirePaymentWindow){
      await this.watchPaymentDeadline();
      if(this.state.active!==item.event_id)return;
    }
    if(item.status==='superseded'||item.status==='lock_timeout'){
      item.release_reason=item.status==='superseded'?'stalled_pickup_handoff':'profile_deadline';this.stage(item,'stalled_released_at');
      this.reset(item.event_id,true);
      if(item.status==='superseded')this.onStalledReleased?.(item.event_id);else this.onProfileReleased?.(item.event_id);
      return; // The old workflow has unwound; never run its remaining steps or restore its page.
    }
    if(this.config.checkout_method==='guest_credit'&&item.status==='manual_review'&&!item.timestamps.guest_order_requested_at&&this.browser.restoreBeforeGuestSubmit){
      this.releasing=true;
      try{
        item.status='pre_submit_failed';item.release_reason=item.reason;this.reset(item.event_id,true);
        if(item.reason!=='daily_order_limit_reached')await this.browser.restoreBeforeGuestSubmit(item);
        this.stage(item,'pre_submit_pickup_restored_at');
      }catch(error){item.status='recovery_pending';item.reason=safeErrorCode(error,'pre_submit_restore_failed');this.state.recovery_pending=item.event_id;this.state.recovery_retry_at=Date.now()+10000;this.stage(item,'pre_submit_restore_failed_at',{kind:'guest_recovery',error_code:item.reason});}
      finally{this.releasing=false;this.onProfileReleased?.(item.event_id);}
      return;
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
  armPaymentDeadline(item){
    if(!this.browser.expirePaymentWindow)return;
    clearTimeout(this.paymentDeadlineTimer);
    const remaining=Date.parse(item.timestamps.apple_pay_sheet_requested_at)+10000-Date.now();
    this.paymentDeadlineTimer=setTimeout(()=>{this.watchPaymentDeadline().catch(()=>{});},Math.max(0,remaining));
    this.paymentDeadlineTimer.unref();
  }
  async watchPaymentDeadline(nowMs=Date.now()){
    const item=this.state.events[this.state.active],requested=item?.timestamps.apple_pay_sheet_requested_at;
    if(!requested||!this.browser.expirePaymentWindow||nowMs-Date.parse(requested)<10000||this.releasing||this.signaling)return false;
    if(['queued','running'].includes(item.status)){this.browser.abortEventId=item.event_id;return false;}
    this.releasing=true;
    try{
      item.status='payment_window_expired';item.release_reason='payment_window_10_seconds';
      this.stage(item,'payment_window_released_at');
      this.reset(item.event_id,true); // The ordinary SKU lock ends at the deadline.
      await this.browser.expirePaymentWindow(item);
      this.stage(item,'payment_window_pickup_restored_at');return true;
    }catch{
      item.reason='payment_window_restore_failed';this.save();this.log(item,'payment_window_restore_failed');return false;
    }finally{
      this.releasing=false;this.onProfileReleased?.(item.event_id);
    }
  }
  async watchGuestOrder(item,state,nowMs){
    if(state.outcome==='success'&&state.observed===true){
      this.onGuestOutcome?.(item,'success');
      this.releasing=true;
      try{
        item.status='order_confirmed';item.reason=null;item.release_reason='confirmed_order_success';item.rearm_pending=this.config.guest_auto_rearm===true;
        this.stage(item,'guest_order_confirmed_at');this.reset(item.event_id,true);
        if(item.rearm_pending){
          this.stage(item,'post_order_setup_started_at');
          await this.browser.rearmAfterGuestSuccess(item,(n,d)=>this.stage(item,n,d));
          item.rearm_pending=false;this.stage(item,'post_order_pickup_ready_at');
        }
        return true;
      }catch(error){item.status='order_confirmed_rearm_waiting';item.reason=safeErrorCode(error,'post_order_setup_failed');item.recovery_after_success=true;this.state.recovery_pending=item.event_id;this.state.recovery_retry_at=Date.now()+10000;this.stage(item,'post_order_setup_failed_at',{kind:'guest_recovery',error_code:item.reason});return false;}
      finally{this.releasing=false;this.onProfileReleased?.(item.event_id);}
    }
    if(state.outcome==='failed'&&state.recoverable===true){this.onGuestOutcome?.(item,'failed');return null;}
    if(nowMs-Date.parse(item.timestamps.guest_order_requested_at)>=Math.min(this.config.guest_order_result_timeout_seconds||10,10)*1000&&(item.status!=='order_result_unknown'||this.config.guest_retry_unknown_orders===true)){
      this.onGuestOutcome?.(item,'unknown');item.status='order_result_unknown';item.reason='order_result_not_confirmed_after_deadline';
      this.stage(item,'guest_order_result_unknown_at');void this.browser.captureFailureEvidence?.(item)?.catch(()=>{});
      if(this.config.guest_retry_unknown_orders===true){
        this.releasing=true;
        try{
          item.status='order_result_unknown_released';item.release_reason='user_accepts_duplicate_order_risk';item.recovery_after_unknown=true;this.reset(item.event_id,true);
          const restored=await this.browser.rearmAfterUnknownOrder(item,(name,detail)=>this.stage(item,name,detail));
          if(restored?.observed_success){this.onGuestOutcome?.(item,'success');item.status='order_confirmed';item.late_order_confirmed=true;}
          this.stage(item,'unknown_order_pickup_restored_at');return true;
        }catch(error){item.reason=safeErrorCode(error,'unknown_order_rearm_failed');this.state.recovery_pending=item.event_id;this.state.recovery_retry_at=Date.now()+10000;this.stage(item,'unknown_order_rearm_failed_at',{kind:'guest_recovery',error_code:item.reason});return false;}
        finally{this.releasing=false;this.onProfileReleased?.(item.event_id);}
      }

    }
    return false;
  }
  async watchPaymentFailure(nowMs=Date.now()){
    const item=this.state.events[this.state.active];
    if(!item||!['awaiting_user','manual_review','order_result_unknown'].includes(item.status)||(!item.timestamps.apple_pay_sheet_requested_at&&!item.timestamps.payment_observer_armed_at&&!item.timestamps.guest_order_requested_at)||this.releasing||this.signaling||!this.browser.inspectPaymentFailure)return false;
    if(nowMs<(this.nextPaymentPoll||0))return false;
    this.nextPaymentPoll=nowMs+1000;
    let state;try{state=await this.browser.inspectPaymentFailure(item);}catch{state={outcome:'unknown',observed:false,phase:'observation_failed'};}
    if(this.state.active!==item.event_id)return false;
    if(!item.timestamps.guest_order_requested_at&&!item.timestamps.apple_pay_sheet_requested_at&&state.observed===true&&Number.isFinite(Date.parse(state.requested_at))){
      item.timestamps.apple_pay_sheet_requested_at=state.requested_at;
      this.save();this.log(item,'manual_apple_pay_open_observed');this.armPaymentDeadline(item);
      this.onPaymentWindowObserved?.(item.event_id,state.requested_at);
    }
    const observation={phase:state.phase||'unknown',outcome:state.outcome||'unknown',closed:state.closed===true,observed:state.observed===true};
    if(JSON.stringify(item.payment_watch)!==JSON.stringify(observation)){item.payment_watch=observation;this.save();this.log(item,'payment_result_observed');}
    if(item.timestamps.guest_order_requested_at&&this.config.checkout_method==='guest_credit'){const handled=await this.watchGuestOrder(item,state,nowMs);if(handled!==null)return handled;}
    if(!state.recoverable||state.outcome!=='failed'||this.state.active!==item.event_id||this.releasing||this.signaling)return false;
    this.releasing=true;let released=false;
    try{
      this.stage(item,'payment_failure_detected_at');
      item.status='payment_failed_recovering';item.release_reason='confirmed_payment_failure';
      this.stage(item,'payment_failure_released_at');this.reset(item.event_id,true);
      await this.browser.recoverPaymentFailure(item);
      item.status='payment_failed_returned';this.stage(item,'payment_failure_pickup_restored_at');released=true;return true;
    }catch{
      item.status=this.config.checkout_method==='guest_credit'?'recovery_pending':'manual_review';item.reason='payment_failure_restore_failed';if(this.config.checkout_method==='guest_credit'){this.state.recovery_pending=item.event_id;this.state.recovery_retry_at=Date.now()+10000;item.recovery_after_confirmed_failure=true;}this.save();this.log(item,'payment_failure_restore_failed');return false;
    }finally{this.releasing=false;if(released)(this.onPaymentFailureReleased||this.onProfileReleased)?.(item.event_id);else if(this.state.active!==item.event_id)this.onProfileReleased?.(item.event_id);}
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
    item.reset_at=now(); this.state.active=null;this.log(item,'configuration_lock_released');this.save();this.dispatch();return true;
  }
  expireHeld() {
    let changed=false;
    const ttl=Math.min(600,Math.max(1,this.config.held_event_ttl_seconds||180))*1000;
    for(const item of Object.values(this.state.events)) if(item.status==='held'&&Date.now()-Date.parse(item.detected_at)>ttl) {
      item.status='expired';item.reason='held_event_expired';item.timestamps.finished_at=now();this.log(item,'held_event_expired');changed=true;
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
