import {readFileSync,mkdirSync,openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {PickupBrowser} from './browser.mjs';
import {clearBag} from './clear_bag.mjs';
import {Engine} from './engine.mjs';
import {Stop,productURL,validateEvent} from './protocol.mjs';

const args=process.argv.slice(2),action=args[0];
const value=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
let lock,fd;
try {
  if(!['check','prepare','clear-bag','warm-pages'].includes(action)||!value('--config')) throw new Stop('usage_shopping_action_config_required');
  const file=resolve(value('--config')),config=JSON.parse(readFileSync(file,'utf8'));
  // Durable hold/release dispatch needs the resident server, not a CLI that
  // exits after one task. A CLI invocation reports busy while a task is locked.
  config.queue_while_busy=false;
  if(!config.cdp_endpoint) throw new Stop('cdp_endpoint_required');
  config.state_dir=resolve(dirname(file),config.state_dir);
  mkdirSync(config.state_dir,{recursive:true,mode:0o700});
  // Shares the receiver's exclusive process lock: stop it before maintenance.
  lock=join(config.state_dir,'receiver.lock');
  try {fd=openSync(lock,'wx',0o600);} catch {throw new Stop('receiver_or_cli_running');}
  writeFileSync(fd,String(process.pid));closeSync(fd);
  const browser=new PickupBrowser(config);
  await browser.start();
  if(action==='check') console.log(JSON.stringify({status:'cdp_connected',browser_ready:browser.ready()}));
  else if(action==='warm-pages') {
    if(!config.warm_product_pages||config.selectors_verified!==true)throw new Stop('verified_warm_config_required');
    const engine=new Engine(config,browser);
    if(engine.state.active)throw new Stop('release_active_event_before_warmup');
    console.log(JSON.stringify(await browser.warmIdle()));
  }
  else if(action==='clear-bag') {
    const engine=new Engine(config,browser);
    if(engine.state.active) throw new Stop('reset_active_event_before_clear');
    console.log(JSON.stringify(await clearBag(browser,{confirm:args.includes('--confirm-clear')})));
  } else {
    if(config.selectors_verified!==true) throw new Stop('verify_selectors_before_live');
    const url=productURL(value('--url'));
    config.dry_run=false;
    const engine=new Engine(config,browser);
    let completed;
    const done=new Promise(ok=>{completed=ok;});
    const execute=engine.execute.bind(engine);
    engine.execute=async item=>{try {await execute(item);} finally {completed();}};
    const result=engine.accept(validateEvent({event_id:value('--event-id')||'manual-'+Date.now(),detected_at:new Date().toISOString(),product_url:url}));
    if(result.code===202) await done;
    console.log(JSON.stringify(engine.public(engine.state.events[result.body.event_id])));
  }
} catch(e) {
  console.error(JSON.stringify({status:'stopped',reason:e instanceof Stop?e.code:e.code==='ECONNREFUSED'||e.message?.includes('ECONNREFUSED')?'cdp_not_listening':e.name==='TimeoutError'?'timeout':'browser_or_config_error'}));
  process.exitCode=1;
} finally {
  if(fd!==undefined&&lock) unlinkSync(lock);
}
// Disconnect this CLI process; never close the user's CDP browser or its tabs.
process.exit(process.exitCode||0);
