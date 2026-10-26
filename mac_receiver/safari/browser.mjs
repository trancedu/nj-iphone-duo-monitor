// Production adapter. Engine owns deduplication, held queues and durable locks.
import {SafariWindow,listSafariWindows,prepareSafari} from './shopping.mjs';
import {signalSafari} from './feedback.mjs';
import {Stop,expectedProduct} from '../protocol.mjs';
export class SafariPickupBrowser {
  constructor(config,{listWindows=listSafariWindows,Window=SafariWindow,prepare=prepareSafari,signal=signalSafari}={}) {
    this.config=config;this.listWindows=listWindows;this.Window=Window;this.workflow=prepare;this.signal=signal;this.connected=false;this.page=null;
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
      if(this.page?.id!==w.id)this.page={id:w.id,closed:false};
      this.window=window;this.connected=true;
    }catch(e){this.connected=false;throw e;}
  }
  async prepare(event,stage){
    await this.ensurePage();
    const cfg={...this.config,test_any_available_store:false,pickup_details:{...this.config.pickup_details}};
    if(event.store_name)cfg.pickup_details.store_name=/^Apple\s/.test(event.store_name)?event.store_name:'Apple '+event.store_name;
    this.lastResult=await this.workflow(this.window,event.product_url,cfg,{stage});
    if(this.lastResult.status==='pickup_unavailable')throw new Stop('pickup_unavailable');
    return this.lastResult.status;
  }
  async seedIdle(){
    await this.ensurePage();
    return this.workflow(this.window,this.config.preseeded_product_url,this.config,{seedOnly:true});
  }
  async handoff(status){
    return this.signal(this.window,{status},{mode:this.config.dry_run?'test':'production',profile:this.config.safari_profile,product:expectedProduct(this.activeProductURL||this.config.preseeded_product_url)});
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
