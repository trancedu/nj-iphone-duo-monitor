import test from 'node:test';
import assert from 'node:assert/strict';
import {prewarmDOM,runPrewarmDOM,prewarmTest} from '../safari/guest_prewarm_test.mjs';
import vm from 'node:vm';
test('delivery prewarm rejects every production profile before browser or payment access',async()=>{
 for(const profile of ['Duo256White','Duo512Black','Duo1024White']){
  await assert.rejects(()=>prewarmTest({profile},{},{}),/isolated_test_profile_required/);
  await assert.rejects(()=>runPrewarmDOM({profile},'changeShipping'),/isolated_test_profile_required/);
 }
});
test('prewarm DOM has no operation that can submit an order',()=>{
 const context={location:{href:'https://secure6.store.apple.com/shop/checkout?_s=Review'},URL,document:{},window:{}};
 assert.throws(()=>vm.runInNewContext(`(${prewarmDOM.toString()})({op:'placeOrder'})`,context),/unknown_prewarm_operation/);
});
test('prewarm rejects wrong host and wrong checkout step',()=>{
 const context={location:{href:'https://example.com/shop/checkout?_s=Review'},URL,document:{},window:{}};
 assert.throws(()=>vm.runInNewContext(`(${prewarmDOM.toString()})({op:'changeShipping'})`,context),/guest_checkout_required/);
 context.location.href='https://secure6.store.apple.com/shop/checkout?_s=Billing';
 assert.throws(()=>vm.runInNewContext(`(${prewarmDOM.toString()})({op:'changeShipping'})`,context),/review_required/);
});
test('delivery review can only invoke the exact change-shipping button once',()=>{
 let clicks=0;
 const control={getClientRects:()=>[1],disabled:false,innerText:'Change shipping method',click:()=>clicks++};
 const context={location:{href:'https://secure6.store.apple.com/shop/checkout?_s=Review'},URL,document:{getElementById:id=>id==='checkout.review.fulfillmentReview.reviewGroup-1.edit'?control:null},window:{}};
 vm.runInNewContext(`(${prewarmDOM.toString()})({op:'changeShipping'})`,context);assert.equal(clicks,1);
 assert.throws(()=>vm.runInNewContext(`(${prewarmDOM.toString()})({op:'changeShipping'})`,context),/already_requested/);assert.equal(clicks,1);
});

test('shared production preparation accepts only exact profile and configured product pairs',async()=>{
 const {validateSetupProfile}=await import('../safari/guest_setup.mjs');
 const url='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-1tb-star-white-unlocked';
 assert.equal(validateSetupProfile({profile:'Duo1024White'},url),'iPhone Duo 1TB Star White');
 assert.throws(()=>validateSetupProfile({profile:'Duo1024Black'},url),/profile_product_mismatch/);
 assert.throws(()=>validateSetupProfile({profile:'Main'},url),/profile_not_allowed/);
});

test('unconfirmed native sign-in cancellation warns but does not stop Guest preparation',async()=>{
 const {attemptPreparationSignInCancel}=await import('../safari/guest_setup.mjs');const stages=[];
 const r=await attemptPreparationSignInCancel({},(name,detail)=>stages.push({name,detail}),{cancel:async()=>{throw Error('unknown_guest_sheet_requires_manual_review');}});
 assert.equal(r.confirmed,false);assert.equal(stages[0].name,'setup_native_signin_cancel_unconfirmed');assert.equal(stages[0].detail.error_code,'unknown_guest_sheet_requires_manual_review');
 await assert.rejects(()=>attemptPreparationSignInCancel({},()=>{},{cancel:async()=>{throw Error('native_cancel_requires_guest_signin');}}),/native_cancel_requires_guest_signin/);
});
