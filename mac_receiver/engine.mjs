import {mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {fingerprint, Stop} from './protocol.mjs';
const now = () => new Date().toISOString();

export class Engine {
  constructor(config, browser) {
    this.config = config; this.browser = browser;
    mkdirSync(config.state_dir,{recursive:true,mode:0o700});
    this.file=join(config.state_dir,'events.json');
    this.state=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{active:null,events:{}};
    this.state.events=Object.assign(Object.create(null),this.state.events);
    for (const item of Object.values(this.state.events)) {
      if(item.status==='held') {item.status='expired';item.reason='receiver_restarted';item.timestamps.finished_at=now();}
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
      status:item.status,stage,timestamps:item.timestamps})+'\n',{mode:0o600});
  }
  health() {
    this.expireHeld();
    return {status:'ok',mode:this.config.dry_run?'dry_run':'live',
      browser_ready:this.browser.ready(),active_event_id:this.state.active,
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
    return {event_id:item.event_id,status:item.status,reason:item.reason,timestamps:item.timestamps,...(item.feedback?{feedback:item.feedback}:{})};
  }
  stage(item,name) {
    item.timestamps[name]=now(); this.save(); this.log(item,name);
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
    try {
      const result=await this.browser.prepare(item,name=>this.stage(item,name));
      item.status=result||'awaiting_user';
    } catch (error) {
      item.status=error instanceof Stop&&error.code==='pickup_unavailable'?'pickup_unavailable':'manual_review';
      item.reason=error instanceof Stop?error.code:error?.name==='TimeoutError'?'timeout':'browser_error';
    }
    // Every live outcome stays locked, including uncertainty/errors and unavailable pickup.
    this.stage(item,'finished_at');
    this.signaling=true;
    try { const feedback=await this.browser.handoff(item.status);if(feedback){item.feedback=feedback;this.stage(item,'feedback_completed_at');} }
    catch { item.reason=item.reason||'attention_signal_failed';this.save();this.log(item,'attention_signal_failed'); }
    finally {this.signaling=false;}
    if(item.status==='pickup_unavailable'&&this.config.auto_release_unavailable) {
      this.releasing=true;
      try {
        await this.browser.seedIdle();
        item.release_reason='pickup_unavailable_return_to_standby';this.reset(item.event_id,true);
      } catch {item.reason='standby_restore_failed';this.save();this.log(item,'standby_restore_failed');}
      finally {this.releasing=false;}
    }
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
