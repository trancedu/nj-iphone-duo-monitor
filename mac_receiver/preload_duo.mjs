import {readFileSync,openSync,closeSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {PickupBrowser} from './browser.mjs';
import {Engine} from './engine.mjs';
import {DUO_VARIANTS,inspectVariantBag} from './variant_bag.mjs';
import {Stop,productPattern} from './protocol.mjs';

const i=process.argv.indexOf('--config');let lock,owned=false;
try {
  if(i<0||!process.argv[i+1]) throw new Stop('config_required');
  const file=resolve(process.argv[i+1]),cfg=JSON.parse(readFileSync(file));cfg.state_dir=resolve(dirname(file),cfg.state_dir);
  if(!cfg.cdp_endpoint||cfg.selectors_verified!==true)throw new Stop('verified_cdp_config_required');
  mkdirSync(cfg.state_dir,{recursive:true,mode:0o700});lock=join(cfg.state_dir,'receiver.lock');
  const fd=openSync(lock,'wx',0o600);owned=true;writeFileSync(fd,String(process.pid));closeSync(fd);
  const browser=new PickupBrowser(cfg);await browser.start();
  const engine=new Engine(cfg,browser);if(engine.state.active)throw new Stop('release_active_event_before_preload');
  await browser.goto('https://www.apple.com/shop/bag');
  let found=await inspectVariantBag(browser);
  for(const url of DUO_VARIANTS.filter(u=>!found.includes(u))) {
    await browser.goto(url);
    if(new URL(browser.page.url()).pathname!==new URL(url).pathname)throw new Stop('configuration_redirect');
    await browser.page.getByText(productPattern(url)).first().waitFor({state:'visible'});
    for(const name of ['No trade-in','Connect to any carrier later']) {
      const choice=browser.page.getByRole('radio',{name:new RegExp('^'+name)});if(await choice.count()===1)await choice.check();
    }
    await browser.page.getByRole('radio',{name:'No AppleCare coverage',exact:true}).check();
    // One Add invocation per missing variant; uncertainty stops, never retries.
    await browser.page.getByRole('button',{name:'Add to Bag',exact:true}).click();
    await browser.page.getByRole('button',{name:'Review Bag',exact:true}).click();
    const updated=await inspectVariantBag(browser);
    if(updated.length!==found.length+1||!updated.includes(url)||found.some(u=>!updated.includes(u)))throw new Stop('preload_result_uncertain');
    found=updated;console.log(JSON.stringify({status:'variant_preloaded',count:found.length,url}));
  }
  if(found.length!==4)throw new Stop('preload_incomplete');
  console.log(JSON.stringify({status:'four_variants_ready',quantities:[1,1,1,1],timing:'excluded_from_signal_benchmark'}));
}catch(e){console.error(JSON.stringify({status:'stopped',reason:e instanceof Stop?e.code:e.name==='TimeoutError'?'timeout':'preload_error'}));process.exitCode=1;}
finally{if(owned)unlinkSync(lock);}
process.exit(process.exitCode||0);
