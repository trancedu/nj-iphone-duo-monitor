import {readFileSync,writeFileSync} from 'node:fs';
import {PickupBrowser} from './browser.mjs';
import {productPattern,Stop} from './protocol.mjs';

const manifest=JSON.parse(readFileSync('mac_receiver/runtime-cdp/four-profiles.local.json'));
const base=JSON.parse(readFileSync('mac_receiver/receiver.cdp.local.json'));
const profiles=[];const evidence={scope:'four fresh independent Chrome user-data directories, no Apple login',initial:[],matrix:[],started_at:new Date().toISOString()};
async function snapshot(b) {
  await b.goto('https://www.apple.com/shop/bag');
  const page=b.page,rows=page.locator(b.config.selectors.bag_item),empty=page.getByRole('heading',{name:/^Your bag is empty\.?$/i});
  await Promise.any([empty.waitFor({state:'visible'}),rows.first().waitFor({state:'visible'})]);
  if(await empty.isVisible()){if(await rows.count())throw new Stop('ambiguous_bag');return [];}
  return rows.evaluateAll(es=>es.map(e=>({name:e.querySelector('h2')?.textContent.replace(/\s+/g,' ').trim(),quantity:e.querySelector('select')?.value})));
}
async function addOne(p) {
  const b=p.browser,event={product_url:p.product_url};
  if(await b.bag(event)!=='empty')throw new Stop('fresh_profile_bag_not_empty');
  await b.goto(p.product_url);
  if(new URL(b.page.url()).pathname!==new URL(p.product_url).pathname)throw new Stop('configuration_redirect');
  await b.page.getByText(productPattern(p.product_url)).first().waitFor({state:'visible'});
  for(const name of ['No trade-in','Connect to any carrier later']) {
    const choice=b.page.getByRole('radio',{name:new RegExp('^'+name)});if(await choice.count()===1)await choice.check();
  }
  await b.page.getByRole('radio',{name:'No AppleCare coverage',exact:true}).check();
  await b.page.getByRole('button',{name:'Add to Bag',exact:true}).click();
  await b.page.getByRole('button',{name:'Review Bag',exact:true}).click();
  if(await b.bag(event)!=='same_one')throw new Stop('add_result_uncertain');
}
try {
  for(const p of manifest.profiles) {
    const cfg={...base,cdp_endpoint:p.cdp_endpoint,warm_product_pages:false,auto_clear_bag:false};delete cfg.bag_strategy;
    const browser=new PickupBrowser(cfg);await browser.start();const q={...p,browser};profiles.push(q);
    const bag=await snapshot(browser);if(bag.length)throw new Stop('fresh_profile_bag_not_empty');evidence.initial.push({profile:p.label,bag});
    console.log(JSON.stringify({phase:'initial',profile:p.label,empty:true}));
  }
  for(let i=0;i<profiles.length;i++) {
    await addOne(profiles[i]);const row={after_add:profiles[i].label,bags:[]};
    for(let j=0;j<profiles.length;j++) {
      const p=profiles[j],bag=await snapshot(p.browser);
      const okay=j<=i?bag.length===1&&bag[0].quantity==='1'&&productPattern(p.product_url).test(bag[0].name):bag.length===0;
      row.bags.push({profile:p.label,bag,expected_match:okay});if(!okay)throw new Stop('cross_profile_cart_contamination');
    }
    evidence.matrix.push(row);console.log(JSON.stringify({phase:'isolation_matrix',...row}));
    writeFileSync('mac_receiver/runtime-cdp/profile-isolation-result.local.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  }
  evidence.result='PASS';evidence.finished_at=new Date().toISOString();
  writeFileSync('mac_receiver/runtime-cdp/profile-isolation-result.local.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({result:'PASS',profiles:4,initially_empty:true,independent_bags:true,quantities:[1,1,1,1]}));
}catch(e){evidence.result='STOPPED';evidence.reason=e instanceof Stop?e.code:e.name==='TimeoutError'?'timeout':'isolation_error';writeFileSync('mac_receiver/runtime-cdp/profile-isolation-result.local.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.error(JSON.stringify({result:evidence.result,reason:evidence.reason}));process.exitCode=1;}
process.exit(process.exitCode||0);
