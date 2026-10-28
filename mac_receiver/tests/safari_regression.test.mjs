import test from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from '../safari/regression.mjs';
const url='https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked';
test('live regression cannot target production profiles or Duo products',()=>{
 assert.throws(()=>testConfig({},'Duo512Black',url),/isolated_test_profile/);
 assert.throws(()=>testConfig({},'PickupTest18Pro',url.replace('iphone-18-pro','iphone-duo')),/iphone18_test/);
});
test('live regression overrides payment and contact/slot settings without mutating production config',()=>{
 const base={open_apple_pay_sheet:true,handoff_idle_timeout_seconds:600,pickup_details:{preferred_slot:1,first_name:'Test'}};
 const config=testConfig(base,'PickupTest18Pro',url);
 assert.equal(config.open_apple_pay_sheet,false);assert.equal(config.handoff_idle_timeout_seconds,0);
 assert.equal(config.pickup_details.preferred_slot,2);assert.equal(config.pickup_zip,'07094');
 assert.equal(base.open_apple_pay_sheet,true);assert.equal(base.pickup_details.preferred_slot,1);
});
test('simulation payment suppression is explicitly typed and preserved by event validation',async()=>{
 const {validateEvent}=await import('../protocol.mjs');
 const input={event_id:'simulation-test',detected_at:new Date().toISOString(),product_url:url};
 assert.equal(validateEvent({...input,simulation_no_payment:true}).simulation_no_payment,true);
 assert.equal(validateEvent(input).simulation_no_payment,undefined);
 assert.throws(()=>validateEvent({...input,simulation_no_payment:'true'}),/invalid_simulation_flag/);
});
test('active location policy allows only configured ZIP or East Rutherford for 07094',async()=>{
 const {activePickupLocationAccepted:accept}=await import('../safari/shopping.mjs');
 assert.equal(accept({displayed_zip:'07094'},'07094'),true);
 assert.equal(accept({displayed_zip:null,displayed_location:'East Rutherford, NJ'},'07094'),true);
 assert.equal(accept({displayed_zip:null,displayed_location:'East Rutherford'},'07094'),true);
 assert.equal(accept({displayed_zip:null,displayed_location:'East Rutherford, CA'},'07094'),false);
 assert.equal(accept({displayed_zip:null,displayed_location:'Edit Zip Code or City, State, East Rutherford, NJ'},'07094'),true);
 assert.equal(accept({displayed_zip:'10001',displayed_location:'East Rutherford, NJ'},'07094'),false);
 assert.equal(accept({displayed_zip:null,displayed_location:'Brooklyn, NY'},'07094'),false);
 assert.equal(accept({displayed_zip:null},'07094'),false);
 assert.equal(accept({displayed_zip:null,displayed_location:'East Rutherford, NJ'},'10001'),false);
});
