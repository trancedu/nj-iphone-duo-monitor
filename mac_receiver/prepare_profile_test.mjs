import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PickupBrowser} from './browser.mjs';
import {Engine} from './engine.mjs';
import {Stop,expectedProduct} from './protocol.mjs';

const links=[
 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked',
 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-glacier-unlocked',
 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-512gb-burgundy-unlocked',
 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-512gb-glacier-unlocked'
];
const base=JSON.parse(readFileSync('mac_receiver/receiver.cdp.local.json'));
const manifest=JSON.parse(readFileSync('mac_receiver/runtime-cdp/four-profiles.local.json'));
const result=[];
for(let i=0;i<4;i++){
 const s=manifest.profiles[i],state_dir=resolve('mac_receiver/runtime-profiles',s.label);
 const cfg={...base,cdp_endpoint:s.cdp_endpoint,state_dir,warm_product_pages:false,auto_clear_bag:true,queue_while_busy:false,release_on_task_tab_close:false,profile_label:s.label,preseeded_product_url:s.product_url,preseed_on_release:true};delete cfg.bag_strategy;
 mkdirSync(state_dir,{recursive:true,mode:0o700});const lock=join(state_dir,'receiver.lock');const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
 try{
  const browser=new PickupBrowser(cfg);await browser.start();const engine=new Engine(cfg,browser);
  if(engine.state.active){const item=engine.state.events[engine.state.active];if(item.status!=='pickup_unavailable')throw new Stop('active_task_under_user_control');engine.reset(item.event_id);}
  await browser.seedIdle(links[i]);
  if(await browser.bag({product_url:links[i]})!=='same_one')throw new Stop('test_seed_mismatch');
  writeFileSync(`mac_receiver/receiver.profile-${s.label}.local.json`,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
  result.push({label:s.label,product_url:links[i],name:expectedProduct(links[i]),config:`mac_receiver/receiver.profile-${s.label}.local.json`});
  console.log(JSON.stringify({stage:'test_profile_preseeded',...result.at(-1),quantity:1,setup_excluded:true}));
 }finally{unlinkSync(lock);}
}
const router={...base,warm_product_pages:false,auto_clear_bag:true,state_dir:'./runtime-router',slots:manifest.profiles.map((s,i)=>({label:s.label,product_url:s.product_url,aliases:[links[i]],cdp_endpoint:s.cdp_endpoint,state_dir:`./runtime-profiles/${s.label}`}))};delete router.bag_strategy;
writeFileSync('mac_receiver/receiver.router.local.json',JSON.stringify(router,null,2)+'\n',{mode:0o600});
writeFileSync('mac_receiver/runtime-cdp/pro-test-profiles.local.json',JSON.stringify({prepared_at:new Date().toISOString(),setup_excluded:true,profiles:result,duplicate_rule:'none: four unique test URLs'},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({status:'all_four_preseeded',count:4,unique_urls:4,timing:'setup_excluded'}));
process.exit(0);
