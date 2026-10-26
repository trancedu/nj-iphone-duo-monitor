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
      if (['queued','running'].includes(item.status)) {
        item.status='interrupted'; item.reason='receiver_restarted'; item.timestamps.finished_at=now();
        this.state.active=item.event_id;
      }
    }
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
    return {status:'ok',mode:this.config.dry_run?'dry_run':'live',
      browser_ready:this.browser.ready(),active_event_id:this.state.active,
      ready:this.config.dry_run||this.browser.ready(),apple_pay_verified:'manual_verification_required'};
  }
  accept(event) {
    const prior=Object.hasOwn(this.state.events,event.event_id)?this.state.events[event.event_id]:null;
    if (prior) {
      if (prior.fingerprint!==fingerprint(event)) return {code:409,body:{event_id:event.event_id,status:'event_id_conflict'}};
      return {code:200,body:this.public(prior)};
    }
    if(Object.keys(this.state.events).length>=4096) return {code:429,body:{event_id:event.event_id,status:'event_capacity_reached'}};
    let status='queued';
    if (this.state.active) status='busy';
    else if (!this.config.dry_run&&!this.browser.ready()) status='browser_not_ready';
    const item={...event,fingerprint:fingerprint(event),status,timestamps:{detected_at:event.detected_at,received_at:now()}};
    this.state.events[event.event_id]=item;
    if (status==='queued') this.state.active=event.event_id;
    this.save(); this.log(item,'received');
    if (status==='queued') setImmediate(()=>this.execute(item));
    return {code:status==='busy'?409:status==='browser_not_ready'?503:202,body:this.public(item)};
  }
  public(item) {
    return {event_id:item.event_id,status:item.status,reason:item.reason,timestamps:item.timestamps};
  }
  stage(item,name) {
    item.timestamps[name]=now(); this.save(); this.log(item,name);
  }
  async execute(item) {
    item.status='running';this.save();
    if (this.config.dry_run) {
      item.status='dry_run_completed';this.stage(item,'finished_at');this.state.active=null;this.save();return;
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
    try { await this.browser.handoff(); }
    catch { item.reason=item.reason||'attention_signal_failed';this.save();this.log(item,'attention_signal_failed'); }
  }
  reset(eventId) {
    const item=this.state.events[eventId];
    if (!item || this.state.active!==eventId) return false;
    if (['queued','running'].includes(item.status)) throw new Stop('task_still_running');
    item.reset_at=now(); this.state.active=null;this.save();return true;
  }
}
