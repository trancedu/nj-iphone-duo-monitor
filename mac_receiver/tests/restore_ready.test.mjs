import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreGuestReady} from '../safari/guest_restore.mjs';
import {chooseLabels} from '../restore_ready.mjs';
const url='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked';
function fixture(){
 let step='Fulfillment',path='/shop/checkout',zip='07094',editable=false,selected=true;const mutations=[];
 const w={profile:'Duo256White',call:async(op,args)=>{
  if(op==='standbyState')return {pickup_selected:selected,expired:false,session_warning:false};
  if(op==='locationState')return {displayed_zip:zip,editable};
  if(op==='openLocation'){mutations.push(op);editable=true;return {};}
  if(op==='zip'){mutations.push(op);zip=args.zip;return {};}
  if(op==='pickup'){mutations.push(op);selected=true;return {ready:true};}
  if(op==='pickupReady')return {ready:true};
  throw Error('unexpected_'+op);
 }};
 const read=async(w,op)=>{if(op==='restoreGuestBeforeSubmit'){mutations.push(op);step='Fulfillment';return {restored:true};}return {path,step};};
 return {w,read,mutations,config:{pickup_zip:'07094'},setZip:v=>zip=v,setStep:v=>step=v,setPath:v=>path=v};
}
test('already selected pickup and exact ZIP is enough: no payment inspection, mutation or rebuild',async()=>{
 const f=fixture();const result=await restoreGuestReady(f.w,url,f.config,{read:f.read,rebuild:()=>{throw Error('must_not_rebuild');}});
 assert.equal(result.unchanged,true);assert.equal(result.mode,'already_ready');assert.deepEqual(f.mutations,[]);
});
test('wrong ZIP corrects only location and never rebuilds a valid session',async()=>{
 const f=fixture();f.setZip('10001');const result=await restoreGuestReady(f.w,url,f.config,{read:f.read,rebuild:()=>{throw Error('must_not_rebuild');}});
 assert.equal(result.mode,'pickup_corrected');assert.deepEqual(f.mutations,['openLocation','zip']);
});
test('expired session does a single full preparation and verifies the final pickup location',async()=>{
 const f=fixture();f.setPath('/shop/sorry/session_expired');let count=0;
 const result=await restoreGuestReady(f.w,url,f.config,{read:f.read,rebuild:async(w,u,c,opts)=>{count++;assert.equal(opts.allowReplenish,true);f.setPath('/shop/checkout');}});
 assert.equal(count,1);assert.equal(result.mode,'session_rebuilt');
});
test('contact/review without a financial submit returns through the same Guest session',async()=>{
 const f=fixture();f.setStep('Review');const result=await restoreGuestReady(f.w,url,f.config,{read:f.read,rebuild:()=>{throw Error('must_not_rebuild');}});
 assert.equal(result.status,'standby_checkout');assert.equal(result.unchanged,false);assert.deepEqual(f.mutations,['restoreGuestBeforeSubmit']);
});
test('failed rebuild cannot claim success solely from its return status',async()=>{
 const f=fixture();f.setPath('/shop/sorry/session_expired');
 await assert.rejects(()=>restoreGuestReady(f.w,url,f.config,{read:f.read,rebuild:async()=>({status:'standby_checkout'})}),/restored_pickup_not_verified/);
});
test('desktop selection accepts all six or exactly one configured profile',()=>{
 assert.deepEqual(chooseLabels('all'),['A','B','C','D','E','F']);assert.deepEqual(chooseLabels('512 黑'),['D']);assert.deepEqual(chooseLabels('E'),['E']);assert.throws(()=>chooseLabels('unknown'),/invalid_restore_selection/);
});
