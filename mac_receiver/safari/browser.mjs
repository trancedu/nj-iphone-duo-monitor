// Production adapter. Engine owns deduplication, held queues and durable locks.
import {SafariWindow,listSafariWindows,prepareSafari,prepareSafariStandby,waitFor} from './shopping.mjs';
import {runGuestSignal,prepareGuestStandby,runGuestDOM} from './guest_checkout.mjs';
import {captureFailureEvidence} from './failure_evidence.mjs';
import {prepareGuestPaymentSession} from './guest_setup.mjs';
import {signalSafari} from './feedback.mjs';
import {appendDiagnostic,safeErrorCode} from './diagnostics.mjs';
import {join} from 'node:path';
import {Stop,expectedProduct} from '../protocol.mjs';
export class SafariPickupBrowser {
  constructor(config,{listWindows=listSafariWindows,Window=SafariWindow,prepare=prepareSafari,standby=prepareSafariStandby,signal=signalSafari}={}) {
    this.config=config;this.listWindows=listWindows;this.Window=Window;this.workflow=config.checkout_method==='guest_credit'?async(w,u,c,opts)=>{const r=await runGuestSignal(w,u,c,c.guest_billing,opts.stage,{mode:c.guest_auto_place_order&&!c.simulation_no_payment?'production':'test',max_total_usd:c.guest_max_total_usd||0,shouldYieldToRecent:opts.shouldYieldToRecent,mayForeground:opts.mayForeground});return {...r,status:r.status==='review_ready_test_stopped'||r.status==='order_requested'||r.status==='order_request_uncertain'?'awaiting_user':r.status};}:prepare;this.standby=config.checkout_method==='guest_credit'?prepareGuestStandby:standby;this.signal=signal;this.connected=false;this.page=null;this.requestReservations=0;this.idleRefreshPromise=null;this.lastIdleRefreshAt=Date.now();
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
    return this.signal(null,{status:'inventory_signal'},{event_id:item.event_id,state_dir:this.config.state_dir,speech_enabled:this.config.speech_enabled,mode:'production',profile:this.config.safari_profile,product:expectedProduct(item.product_url)}).then(receipt=>{
      if(this.eventAlert?.id===item.event_id)this.eventAlert.queued=receipt.audio_queued===true||receipt.sound_played===true;
      return receipt;
    });
  }
  async prepare(event,stage){
    if(this.idleRefreshPromise)await this.idleRefreshPromise.catch(()=>{});
    await this.ensurePage();
    const cfg={...this.config,urgent_same_configuration_retry:event.same_configuration_stall_retry===true,recover_stalled_pickup:this.stalledProfilePending===true,handoff_event_id:event.event_id,pickup_first_available_store:true,test_any_available_store:false,pickup_details:{...this.config.pickup_details}};
    if(event.simulation_no_payment===true){cfg.open_apple_pay_sheet=false;cfg.simulation_no_payment=true;}
    cfg.pickup_zip=process.env.APPLE_PICKUP_ZIP??(this.config.standby_page==='pickup_checkout'?this.config.pickup_zip:event.pickup_zip)??this.config.pickup_zip;
    if(event.store_name)cfg.pickup_details.store_name=/^Apple\s/.test(event.store_name)?event.store_name:'Apple '+event.store_name;
    const context={backend:'safari',profile:this.config.safari_profile,window_id:this.window.id,requested_store_name:cfg.pickup_details.store_name,requested_store_id:event.store_id};
    const observe=(name,detail)=>stage(name,{...detail,...context});
    const metrics=new Map(),previousMetric=this.window.onMetric,previousState=this.window.onGuestState;
    this.window.onMetric=m=>{const op=m.op.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());const v=metrics.get(op)||{count:0,total_ms:0,max_ms:0,dom_ms:0};v.count++;v.total_ms+=m.bridge_ms||0;v.max_ms=Math.max(v.max_ms,m.bridge_ms||0);v.dom_ms+=m.dom_ms||0;metrics.set(op,v);};
    let lastGuestState=null;
    this.window.onGuestState=page=>{if(JSON.stringify(page)!==JSON.stringify(lastGuestState)){lastGuestState=page;observe('guest_page_transition_at',{kind:'guest_page',page});}};
    const guard=()=>{
      const limit=this.config.per_profile_requests?(this.config.global_lock_timeout_seconds||60)*1000:0;
      if(this.abortEventId===event.event_id||(limit&&Date.now()-Date.parse(event.timestamps?.received_at||event.detected_at)>limit))throw new Stop('pickup_task_deadline');
    };
    const guardedWindow=new Proxy(this.window,{get:(target,key)=>{
      if(!['call','goto','reload','foreground'].includes(key))return target[key];
      return async(...args)=>{guard();const result=await target[key](...args);guard();return result;};
    }});

    try{
      this.lastResult=await this.workflow(guardedWindow,event.product_url,cfg,{stage:observe,shouldYieldToRecent:this.shouldAbandonStall?()=>this.shouldAbandonStall(event.event_id):this.hasRecentCandidate?()=>this.hasRecentCandidate(event.event_id):undefined,tryClaimApplePay:this.tryClaimApplePay?()=>{guard();return this.tryClaimApplePay(event.event_id);}:undefined,mayForeground:()=>this.mayForeground?.(event.event_id)!==false});
      if(this.config.checkout_method==='guest_credit'&&!['awaiting_user','pickup_unavailable'].includes(this.lastResult.status))throw new Stop('guest_payment_manual_review');
      if(this.lastResult.status==='pickup_unavailable')throw new Stop('pickup_unavailable');
      this.stalledProfilePending=false;return this.lastResult.status;
    }catch(error){
      if(error instanceof Stop&&['pickup_stalled_yield','pickup_task_deadline'].includes(error.code)){this.stalledProfilePending=true;this.lastStandbyCheckAt=0;this.lastStandbyReady=false;throw error;}
      if(!(error instanceof Stop&&error.code==='pickup_unavailable')){
        let diagnostic={};try{diagnostic=await this.window.call('diagnosticState',{product:expectedProduct(event.product_url)});}catch{}
        observe('pickup_failure_observed_at',{...diagnostic,kind:'pickup_failure',error_code:safeErrorCode(error)});
        if(error instanceof Stop&&error.code==='safari_step_timeout'&&diagnostic.pickup_expiry_confirmed===true&&['Fulfillment','Fulfillment-init'].includes(diagnostic.page?.state)&&diagnostic.displayed_zip===cfg.pickup_zip){
          observe('pickup_expired_confirmed_at',{...diagnostic,kind:'pickup_failure',error_code:'pickup_expired_after_timeout'});
          this.lastResult={status:'pickup_expired'};return 'pickup_expired';
        }
      }
      throw error;
    }finally{
      this.window.onMetric=previousMetric;this.window.onGuestState=previousState;
      for(const [operation,metric] of metrics)observe('browser_operation_summary_at',{kind:'browser_operation',operation,...metric});
    }
  }
  async manualRetryToPickup(item){
    this.lastStandbyReady=false;await this.ensurePage();
    const product=expectedProduct(item.product_url),state=await this.window.call('standbyState',{product});
    const snapshot=await this.window.call('snapshot'),u=new URL(snapshot.url);
    if(state.expired||u.pathname==='/shop/bag'){
      const result=await this.standby(this.window,item.product_url,{...this.config,open_apple_pay_sheet:false},{activeRequest:true});
      if(result.status!=='standby_checkout')throw new Stop('manual_retry_pickup_not_ready');
    }else{
      try{const r=await this.window.call('manualRetryPickup',{event_id:item.event_id,product,confirm_manual_retry:true});if(!r.returned)throw new Stop('manual_retry_not_returned');}
      catch(error){if(!['safari_script_response_unrecognized','safari_apple_event_failed'].includes(error.code))throw error;}
      await waitFor(async()=>{const s=await this.window.call('standbyState',{product});if(s.checkout&&!s.protection.contact_heading&&!s.pickup_selected)await this.window.call('pickup',{product});return s.pickup_ready&&s.pickup_selected&&!s.protection.payment_requested;},this.config.step_timeout_ms||20000);
      const ready=await this.window.call('armPickupStandby',{product,explicit_test_reset:true});
      if(!ready.ready||ready.protected)throw new Stop('manual_retry_pickup_not_ready');
    }
    this.stalledProfilePending=false;this.lastStandbyReady=true;
    return {status:'standby_checkout'};
  }
  async inspectPaymentFailure(item){
    if(this.config.checkout_method==='guest_credit')return runGuestDOM(this.window,'guestOrderState',{event_id:item.event_id,expected_product:expectedProduct(item.product_url),submission_expected:!!item.timestamps.guest_order_requested_at});
    return this.window.call('paymentFailureState',{event_id:item.event_id,product:expectedProduct(item.product_url)});
  }
  captureFailureEvidence(item){return captureFailureEvidence(this,item);}
  async rearmAfterGuestSuccess(item,stage=()=>{}){
    if(!this.config.guest_auto_rearm)throw new Stop('guest_auto_rearm_disabled');
    this.lastStandbyReady=false;
    await runGuestDOM(this.window,'retireGuestOrderSuccess',{event_id:item.event_id,expected_product:expectedProduct(item.product_url),submission_expected:true});
    const result=await prepareGuestPaymentSession(this.window,item.product_url,this.config,{allowReplenish:true,stage});
    this.lastStandbyReady=true;this.lastStandbyCheckAt=Date.now();this.lastIdleRefreshAt=Date.now();return result;
  }
  async restoreBeforeGuestSubmit(item){
    this.lastStandbyReady=false;
    if(this.config.guest_auto_rearm&&item.reason==='prepared_payment_missing_manual_review'){const r=await prepareGuestPaymentSession(this.window,item.product_url,this.config);this.lastStandbyReady=r.status==='standby_checkout';return r;}
    const r=await runGuestDOM(this.window,'restoreGuestBeforeSubmit',{expected_product:expectedProduct(item.product_url)});
    if(!r.restored&&!r.response_unknown)throw new Stop('pre_submit_restore_not_verified');
    await waitFor(async()=>{const s=await runGuestDOM(this.window,'state');return ['Fulfillment','Fulfillment-init'].includes(s.step);},this.config.step_timeout_ms||20000);
    const result=await this.standby(this.window,item.product_url,this.config,{activeRequest:true});
    this.lastStandbyReady=result.status==='standby_checkout';return result;
  }
  async expirePaymentWindow(item){
    this.lastStandbyReady=false;
    const product=expectedProduct(item.product_url);
    try{
      const r=await this.window.call('expirePaymentWindow',{event_id:item.event_id,product});
      if(!r.returned)throw new Stop('payment_window_owner_changed');
    }catch(error){
      // A navigation can destroy its own reply. Reconcile instead of clicking
      // or navigating twice; preserve all other failures.
      if(!['safari_script_response_unrecognized','safari_apple_event_failed'].includes(error.code))throw error;
    }
    await waitFor(async()=>{const s=await this.window.call('standbyState',{product});return s.pickup_ready&&s.pickup_selected&&!s.protection.payment_requested;},Math.min(this.config.step_timeout_ms||20000,8000));
    const ready=await this.window.call('armPickupStandby',{product,explicit_test_reset:true});
    if(!ready.ready||ready.protected)throw new Stop('payment_window_pickup_not_ready');
    this.stalledProfilePending=false;this.lastStandbyReady=true;
    return {status:'standby_checkout'};
  }
  async recoverPaymentFailure(item){
    if(this.config.checkout_method==='guest_credit'){
      this.lastStandbyReady=false;const product=expectedProduct(item.product_url);
      const result=await runGuestDOM(this.window,'recoverGuestOrderFailure',{event_id:item.event_id,expected_product:product});
      if(!result.recovered&&!result.response_unknown)throw new Stop('guest_failure_no_longer_confirmed');
      await waitFor(async()=>{const s=await this.window.call('standbyState',{product});if(s.checkout&&!s.pickup_selected)await this.window.call('pickup',{product});return s.pickup_ready&&s.pickup_selected;},this.config.step_timeout_ms||20000);
      const ready=await this.window.call('armPickupStandby',{product,explicit_test_reset:true});
      if(!ready.ready||ready.protected)throw new Stop('guest_failure_pickup_not_ready');
      this.stalledProfilePending=false;this.lastStandbyReady=true;return {status:'standby_checkout'};
    }
    this.lastStandbyReady=false;
    const product=expectedProduct(item.product_url);
    const claim=await this.window.call('recoverPaymentFailure',{event_id:item.event_id,product});
    if(!claim.recovered)throw new Stop('payment_failure_no_longer_confirmed');
    // Never rebuild Bag or edit ZIP during a failed-payment handoff. The next
    // fresh same-SKU request performs its usual single refresh from this page.
    await waitFor(async()=>{const s=await this.window.call('standbyState',{product});return s.pickup_ready&&s.pickup_selected&&!s.protection.payment_requested;},Math.max(100,Math.min(8000,Date.parse(item.timestamps.apple_pay_sheet_requested_at)+10000-Date.now())));
    const ready=await this.window.call('armPickupStandby',{product,explicit_test_reset:true});
    if(!ready.ready||ready.protected)throw new Stop('payment_failure_pickup_not_ready');
    this.stalledProfilePending=false;this.lastStandbyReady=true;
    return {status:'standby_checkout'};
  }
  async restoreExpiredPickup(){
    const product=expectedProduct(this.activeProductURL||this.config.preseeded_product_url);
    const zip=process.env.APPLE_PICKUP_ZIP??this.config.pickup_zip;
    const state=await this.window.call('rearmExpiredPickupStandby',{product,zip});
    if(!state.rearmed||!state.ready||state.protected||state.expired||!state.pickup_selected)throw new Stop('pickup_expiry_no_longer_confirmed');
    this.stalledProfilePending=false;this.lastStandbyReady=true;
    return {status:'standby_checkout',product,zip,unchanged:true};
  }
  standbyTrace(){
    return {stage:(stage,detail)=>{
      if(detail?.kind==='pickup_location')console.info(JSON.stringify({event:'standby_location_check',profile:this.config.safari_profile,stage,...detail,at:new Date().toISOString()}));
    }};
  }
  async seedIdle({allowRebuild=true}={}){
    await this.ensurePage();
    let result;
    if(this.config.checkout_method==='guest_credit'){
      const current=await runGuestDOM(this.window,'state');
      if(this.config.guest_auto_rearm&&current.path!=='/shop/checkout'){
        if(!allowRebuild)return {status:'needs_session_setup'};
        result=await prepareGuestPaymentSession(this.window,this.config.preseeded_product_url,this.config,{stage:this.standbyTrace().stage});
      }else result=await this.standby(this.window,this.config.preseeded_product_url,this.config,this.standbyTrace());
      this.lastIdleRefreshAt=Date.now();this.lastStandbyReady=result.status==='standby_checkout';return result;
    }
    if(this.config.standby_page==='pickup_checkout'){
      const product=expectedProduct(this.config.preseeded_product_url),zip=process.env.APPLE_PICKUP_ZIP??this.config.pickup_zip;
      let state=await this.window.call('standbyState',{product});
      if(state.protection?.payment_requested){
        const reconciled=await this.window.call('reconcileReturnedPickup',{product});
        if(reconciled.reconciled)state=reconciled;
      }
      if(state.protected&&!state.abandoned){
        // Idle seeding may adopt an unavailable default selection, but never
        // an available store, contact form or wallet. The DOM rechecks atomically.
        const rearmed=await this.window.call('rearmExpiredPickupStandby',{product,zip});
        if(rearmed.rearmed&&rearmed.ready&&!rearmed.protected&&rearmed.pickup_selected)result={status:'standby_checkout',product,zip};
      }
      // A live same-SKU successor is still active demand, not idle maintenance.
      const activeRequest=!!this.activeTaskId&&this.hasRecentCandidate?.(this.activeTaskId)===true;
      result??=await this.standby(this.window,this.config.preseeded_product_url,this.config,{...this.standbyTrace(),activeRequest});
    }else result=await this.workflow(this.window,this.config.preseeded_product_url,this.config,{seedOnly:true});
    this.lastIdleRefreshAt=Date.now();
    if(result.status==='standby_checkout'){this.stalledProfilePending=false;this.lastStandbyReady=true;}
    return result;
  }
  async handoff(status,reason){
    if(status==='awaiting_user'&&this.config.handoff_idle_timeout_seconds>0)try{await this.window.call('armIdle',{event_id:this.activeTaskId});}catch{}
    return this.signal(this.mayForeground?.(this.activeTaskId)===false?null:this.window,{status,reason},{mute_audio:status==='awaiting_user'&&this.eventAlert?.id===this.activeTaskId&&this.eventAlert.queued,event_id:this.activeTaskId,state_dir:this.config.state_dir,speech_enabled:this.config.speech_enabled,mode:this.config.dry_run?'test':'production',profile:this.config.safari_profile,product:expectedProduct(this.activeProductURL||this.config.preseeded_product_url)});
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
    return this.signal(null,{status:'idle_timeout_returned'},{event_id:item.event_id,state_dir:this.config.state_dir,speech_enabled:this.config.speech_enabled,mode:'production',profile:this.config.safari_profile,product:expectedProduct(item.product_url)});
  }

  refreshIdleBag(now=Date.now()){
    if(this.config.standby_page==='pickup_checkout')return Promise.resolve({status:'skipped'});
    if(this.idleRefreshPromise)return this.idleRefreshPromise;
    const seconds=this.config.idle_bag_refresh_interval_seconds??300;
    if(!seconds||!this.ready()||this.requestReservations||now-this.lastIdleRefreshAt<seconds*1000)return Promise.resolve({status:'skipped'});
    this.lastIdleRefreshAt=now;
    const task=this._refreshIdleBag();this.idleRefreshPromise=task;
    task.finally(()=>{if(this.idleRefreshPromise===task)this.idleRefreshPromise=null;}).catch(()=>{});
    return task;
  }
  refreshStandby(now=Date.now(),{expiredOnly=false,recovering=false,onExpired}={}){
    const seconds=this.config.idle_checkout_refresh_interval_seconds||0;
    const checkSeconds=this.config.checkout_session_check_interval_seconds||60;
    const refreshDue=!expiredOnly&&seconds>0&&now-this.lastIdleRefreshAt>=seconds*1000;
    const checkDue=now-(this.lastStandbyCheckAt??this.lastIdleRefreshAt)>=checkSeconds*1000;
    if(this.config.standby_page!=='pickup_checkout'||!this.ready()||this.requestReservations||this.idleRefreshPromise||(!refreshDue&&!checkDue))return null;
    this.lastStandbyCheckAt=now;
    if(refreshDue)this.lastIdleRefreshAt=now;
    const task=(async()=>{
      try{
        if(this.config.checkout_method==='guest_credit'){const guest=await runGuestDOM(this.window,'state');if(guest.path==='/shop/checkout'&&['PickupContact','PickupContact-init','Billing','Billing-init','Review','Review-init'].includes(guest.step)){this.lastSessionCheck={at:new Date(now).toISOString(),status:'protected'};this.lastStandbyReady=false;return {status:'protected'};}}
        // A selected store, details page or payment sheet is never maintained.
        const product=expectedProduct(this.config.preseeded_product_url);
        let state=await this.window.call('standbyState',{product});
        if(state.protection?.payment_requested){
          const reconciled=await this.window.call('reconcileReturnedPickup',{product});
          if(reconciled.reconciled){
            const result=await this.standby(this.window,this.config.preseeded_product_url,this.config,this.standbyTrace());
            this.stalledProfilePending=false;this.lastStandbyReady=result.status==='standby_checkout';
            this.lastSessionCheck={at:new Date(now).toISOString(),status:'returned_pickup_reconciled'};
            return result;
          }
        }
        this.lastSessionCheck={at:new Date(now).toISOString(),status:state.expired?'expired':state.protected?'protected':state.ready?'ready':'unknown'};
        this.lastStandbyReady=state.ready===true&&state.pickup_selected===true&&!state.session_warning&&!state.abandoned;
        if(this.stalledProfilePending&&this.lastStandbyReady){
          const location=await this.window.call('locationState');
          if(location.displayed_zip===this.config.pickup_zip)this.stalledProfilePending=false;
        }
        if(state.abandoned||this.stalledProfilePending&&!state.protected&&!state.session_warning){
          if(now<(this.nextSessionRecoveryAt||0))return {status:'backoff'};
          this.nextSessionRecoveryAt=now+180000;
          const result=await this.standby(this.window,this.config.preseeded_product_url,this.config,this.standbyTrace());
          if(result.status!=='standby_checkout')throw new Stop('standby_checkout_not_verified');
          this.stalledProfilePending=false;this.lastStandbyReady=true;this.nextSessionRecoveryAt=0;
          this.lastIdleRefreshAt=now;this.lastSessionCheck.status='recovered';
          console.info(JSON.stringify({event:'stalled_checkout_standby_recovered',profile:this.config.safari_profile,at:new Date().toISOString()}));
          return result;
        }
        if(state.session_warning){
          await this.window.call('continueShoppingSession');
          this.lastSessionCheck.status='session_warning';
          try{await waitFor(async()=>!(await this.window.call('standbyState',{product:expectedProduct(this.config.preseeded_product_url)})).session_warning,Math.min(this.config.step_timeout_ms||20000,2000),250);}
          catch(error){
            if(!(error instanceof Stop&&error.code==='safari_step_timeout'))throw error;
            if(state.protected){this.lastSessionCheck.status='protected';return {status:'protected'};}
            if(now<(this.nextSessionRecoveryAt||0))return {status:'backoff'};
            this.nextSessionRecoveryAt=now+180000;
            const result=this.config.checkout_method==='guest_credit'&&this.config.guest_auto_rearm?await prepareGuestPaymentSession(this.window,this.config.preseeded_product_url,this.config,{stage:this.standbyTrace().stage}):await this.standby(this.window,this.config.preseeded_product_url,this.config,{sessionContinuationAttempted:true});
            this.lastIdleRefreshAt=now;this.nextSessionRecoveryAt=0;this.sessionRecoveryPending=false;this.stalledProfilePending=false;this.lastStandbyReady=true;
            this.lastSessionCheck.status='recovered';
            console.info(JSON.stringify({event:'checkout_session_warning_recovery',profile:this.config.safari_profile,status:'recovered',at:new Date().toISOString()}));
            return result;
          }
          this.lastSessionCheck.status='session_continued';this.lastIdleRefreshAt=now;
          console.info(JSON.stringify({event:'checkout_session_continued',profile:this.config.safari_profile,at:new Date().toISOString()}));
          return {status:'session_continued'};
        }
        if(state.protected)return {status:'protected'};
        if(state.ready&&!state.expired)this.sessionRecoveryPending=false;
        const recovery=state.expired||this.sessionRecoveryPending||recovering;
        // Passive checks never refresh healthy pages. A definite expiry is
        // rebuilt through Bag without first reloading the expired URL.
        if(!recovery&&!refreshDue)return {status:'checked'};
        if(now<(this.nextSessionRecoveryAt||0))return {status:'backoff'};
        // Persist a terminal expiry before navigating a protected task away.
        // A regular unavailable page is never enough to retire a task.
        if(onExpired&&state.expired)await onExpired();
        if(recovery)this.sessionRecoveryPending=true;
        this.nextSessionRecoveryAt=now+180000;
        const result=recovery&&this.config.checkout_method==='guest_credit'&&this.config.guest_auto_rearm?await prepareGuestPaymentSession(this.window,this.config.preseeded_product_url,this.config,{stage:this.standbyTrace().stage}):await this.standby(this.window,this.config.preseeded_product_url,this.config,{refresh:!recovery});
        this.lastIdleRefreshAt=now;this.nextSessionRecoveryAt=0;this.sessionRecoveryPending=false;this.stalledProfilePending=false;this.lastStandbyReady=true;
        this.lastSessionCheck.status=recovery?'recovered':'ready';
        console.info(JSON.stringify({event:recovery?'checkout_session_recovery':'idle_checkout_refresh',profile:this.config.safari_profile,status:'refreshed',at:new Date().toISOString()}));
        return result;
      }catch(error){this.lastSessionCheck={at:new Date(now).toISOString(),status:'failed',reason:safeErrorCode(error)};console.info(JSON.stringify({event:'idle_checkout_refresh',profile:this.config.safari_profile,status:'failed',reason:safeErrorCode(error),at:new Date().toISOString()}));return {status:'failed'};}
    })();
    this.idleRefreshPromise=task;
    task.finally(()=>{
      if(this.idleRefreshPromise===task)this.idleRefreshPromise=null;
      if(this.config.state_dir)appendDiagnostic(join(this.config.state_dir,'session-watch.jsonl'),{at:new Date().toISOString(),profile:this.config.safari_profile,window_id:this.window?.id,check_interval_seconds:checkSeconds,refresh_due:refreshDue,expired_only:expiredOnly,elapsed_ms:Date.now()-now,standby_ready:this.lastStandbyReady===true,...this.lastSessionCheck});
    }).catch(()=>{});
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
// A single metadata poll covers all configured profiles. Do not treat a Safari quit,
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
