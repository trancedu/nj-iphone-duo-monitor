// Isolated delivery -> saved payment -> pickup rehearsal. Never submits an order.
import {readFileSync,mkdirSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SafariWindow,listSafariWindows,appleScript,waitFor} from './shopping.mjs';
import {runGuestDOM,readGuestCard,cancelGuestSignIn,prepareGuestStandby,runGuestSignal,testURL} from './guest_checkout.mjs';
import {expectedProduct} from '../protocol.mjs';
import {testConfig} from './regression.mjs';
import {prewarmDOM,prepareGuestPaymentSession} from './guest_setup.mjs';
export {prewarmDOM} from './guest_setup.mjs';
export async function runPrewarmDOM(window,op,args={}){
 if(window.profile!=='PickupTest18Pro')throw Error('isolated_test_profile_required');
 const code='JSON.stringify(('+prewarmDOM.toString()+')('+JSON.stringify({op,...args})+'))';
 const raw=await appleScript(window.script('return do JavaScript '+JSON.stringify(code)+' in tab 1 of w'));
 // Mutation responses can be lost during navigation. Never repeat a click.
 if(!raw&&['shippingContinue','continueShipping','continueSavedShippingCard','changeShipping'].includes(op))return {response_unknown:true};
 if(!raw){const e=Error('safari_navigation_pending');e.code='safari_navigation_pending';throw e;}return JSON.parse(raw);
}
export async function prewarmTest(window,config,shipping,stage=()=>{}){
 if(window.profile!=='PickupTest18Pro')throw Error('isolated_test_profile_required');
 await prepareGuestPaymentSession(window,testURL,config,{shipping,stage});
 return runGuestSignal(window,testURL,{...config,guest_payment_prepared:true},shipping,stage,{mode:'test'});
}
async function main(){
 const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
 if(!args.includes('--config')||!args.includes('--shipping'))throw Error('usage_--config_FILE_--shipping_PRIVATE_FILE');
 const shipping=JSON.parse(readFileSync(resolve(arg('--shipping'))));
 for(const k of ['first_name','last_name','street','zip','city','state','email','phone'])if(typeof shipping[k]!=='string'||!shipping[k].trim())throw Error('shipping_configuration_incomplete');
 const windows=(await listSafariWindows()).filter(w=>w.name.startsWith('PickupTest18Pro — '));
 if(windows.length!==1||windows[0].tabs!==1)throw Error('one_isolated_test_window_required');
 const config=testConfig(JSON.parse(readFileSync(resolve(arg('--config')))),'PickupTest18Pro',testURL);
 const dir=resolve('runtime/safari-regression');mkdirSync(dir,{recursive:true,mode:0o700});
 const lock=resolve(dir,'PickupTest18Pro.lock');closeSync(openSync(lock,'wx',0o600));
 const report={at:new Date().toISOString(),payment_submitted:false,stages:[]},file=resolve(dir,Date.now()+'-prewarm.json');
 try{report.result=await prewarmTest(new SafariWindow(windows[0].id,'PickupTest18Pro'),config,shipping,name=>{report.stages.push({name,at:new Date().toISOString()});console.log(name);});report.status=report.result.status;}
 catch(e){report.status='failed';report.error=e.code||/^[a-z_]+$/.test(e.message)&&e.message||'prewarm_error';process.exitCode=1;}
 finally{writeFileSync(file,JSON.stringify(report,null,2),{mode:0o600});unlinkSync(lock);}
 console.log(JSON.stringify({status:report.status,report:file,to_review_from_refresh_ms:report.result?.to_review_from_refresh_ms,payment_submitted:false,error:report.error}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
