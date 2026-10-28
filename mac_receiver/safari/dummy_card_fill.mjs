// Fill-only helper for the isolated test profile; shares the full Guest flow's
// billing logic, including separate City/State and ZIP lookup verification.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {listSafariWindows,SafariWindow,waitFor} from './shopping.mjs';
import {runGuestDOM,sampleBilling,readGuestCard} from './guest_checkout.mjs';
export async function runDummyCardFill(){
 const candidates=(await listSafariWindows()).filter(w=>w.name.startsWith('PickupTest18Pro — ')&&w.tabs===1);
 if(candidates.length!==1)throw Error('one_PickupTest18Pro_window_required');
 const w=new SafariWindow(candidates[0].id,'PickupTest18Pro'),start=performance.now(),card=readGuestCard();
 await waitFor(async()=>(await runGuestDOM(w,'creditReady')).ready);
 await runGuestDOM(w,'selectCredit');
 await waitFor(async()=>(await runGuestDOM(w,'billingReady',{billing:sampleBilling,card})).ready);
 const fill=await runGuestDOM(w,'fillBilling',{billing:sampleBilling,card});
 await waitFor(async()=>(await runGuestDOM(w,'settleCityState',{billing:sampleBilling,card})).ready);
 const verification=await runGuestDOM(w,'verifyBilling',{billing:sampleBilling,card});
 if(!verification.ready)throw Error('dummy_billing_not_verified');
 return {...fill,verification,bridge_and_fill_ms:performance.now()-start,submitted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await runDummyCardFill(),null,2));
