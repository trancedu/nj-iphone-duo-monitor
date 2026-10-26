import {mkdirSync,writeFileSync,openSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {DUO_VARIANTS} from './variant_bag.mjs';
import {expectedProduct} from './protocol.mjs';

const root=join(homedir(),'.apple-shopping-profiles');
mkdirSync(root,{recursive:true,mode:0o700});mkdirSync('mac_receiver/runtime-cdp',{recursive:true,mode:0o700});
const suffix=Date.now().toString(36),profiles=[];
for(let i=0;i<4;i++) {
  const port=9223+i;
  try {await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(300)});throw Error(`Port ${port} already in use`);}
  catch(e){if(e.message?.includes('already in use'))throw e;}
  const profile_dir=join(root,`duo-${i+1}-${suffix}`);if(existsSync(profile_dir))throw Error('fresh profile directory required');mkdirSync(profile_dir,{mode:0o700});
  const log=openSync(resolve(`mac_receiver/runtime-cdp/profile-${port}.log`),'a',0o600);
  const proc=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`,`--user-data-dir=${profile_dir}`,'--profile-directory=Default','--no-first-run','--no-default-browser-check','https://www.apple.com/shop/bag'
  ],{detached:true,stdio:['ignore',log,log]});proc.unref();
  profiles.push({label:String.fromCharCode(65+i),name:expectedProduct(DUO_VARIANTS[i]),product_url:DUO_VARIANTS[i],cdp_endpoint:`http://127.0.0.1:${port}`,profile_dir,pid:proc.pid});
}
writeFileSync('mac_receiver/runtime-cdp/four-profiles.local.json',JSON.stringify({profiles},null,2)+'\n',{mode:0o600});
for(const p of profiles) {
  let ready=false;
  for(let n=0;n<100;n++) {
    try{const r=await fetch(p.cdp_endpoint+'/json/version',{signal:AbortSignal.timeout(300)});if(r.ok){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!ready)throw Error(`Profile ${p.label} CDP did not become ready`);
  console.log(JSON.stringify({status:'independent_profile_started',...p}));
}
