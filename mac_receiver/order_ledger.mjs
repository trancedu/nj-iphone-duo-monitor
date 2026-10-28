// Shared by all configurations. Reserve durably before invoking Place Your Order.
import {mkdirSync,existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {Stop} from './protocol.mjs';
export class OrderLedger {
 constructor(dir,{limit=4,allowUnknownRetry=false,timezone='America/New_York',now=()=>Date.now()}={}){
  if(!Number.isInteger(limit)||limit<1||limit>4)throw new Stop('invalid_daily_order_limit');
  this.allowUnknownRetry=allowUnknownRetry;this.limit=limit;this.timezone=timezone;this.now=now;this.formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});mkdirSync(dir,{recursive:true,mode:0o700});this.file=join(dir,'guest-order-ledger.json');
  this.data=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{version:1,orders:{}};
  if(this.data.version!==1||!this.data.orders||Array.isArray(this.data.orders))throw new Stop('order_ledger_invalid');
  this.data.orders=Object.assign(Object.create(null),this.data.orders);
 }
 day(at=this.now()){return this.formatter.format(new Date(at));}
 save(){const fd=openSync(this.file+'.tmp','w',0o600);try{writeFileSync(fd,JSON.stringify(this.data,null,2));fsyncSync(fd);}finally{closeSync(fd);}renameSync(this.file+'.tmp',this.file);}
 unresolved(product){return Object.values(this.data.orders).find(r=>r.product_url===product&&(r.outcome==='reserved'||r.outcome==='submitted'||r.outcome==='unknown'&&!this.allowUnknownRetry));}
 health(){const day=this.day(),orders=Object.values(this.data.orders);const counted=orders.filter(r=>r.day===day&&r.outcome!=='failed'||r.day!==day&&['reserved','submitted','unknown'].includes(r.outcome));return {day,timezone:this.timezone,daily_limit:this.limit,occupied:counted.length,confirmed:orders.filter(r=>r.day===day&&r.outcome==='success').length,unresolved:orders.filter(r=>['reserved','submitted','unknown'].includes(r.outcome)).length,remaining:Math.max(0,this.limit-counted.length)};}
 importExisting(event){
  if(event.simulation_no_payment||!event.timestamps?.guest_order_requested_at||Object.hasOwn(this.data.orders,event.event_id))return;
  const outcome=event.payment_watch?.outcome==='success'||event.status?.startsWith('order_confirmed')?'success':event.payment_watch?.outcome==='failed'?'failed':'unknown';
  this.data.orders[event.event_id]={event_id:event.event_id,product_url:event.product_url,day:this.day(Date.parse(event.timestamps.guest_order_requested_at)),outcome,reserved_at:event.timestamps.guest_order_requested_at};this.save();
 }
 reserve(event){
  if(!event.event_id||!event.product_url||event.simulation_no_payment)throw new Stop('invalid_order_reservation');
  if(Object.hasOwn(this.data.orders,event.event_id))throw new Stop('order_already_reserved');
  if(this.unresolved(event.product_url))throw new Stop('configuration_order_unresolved');
  if(this.health().remaining<1)throw new Stop('daily_order_limit_reached');
  this.data.orders[event.event_id]={event_id:event.event_id,product_url:event.product_url,day:this.day(),outcome:'reserved',reserved_at:new Date(this.now()).toISOString()};this.save();return {reserved:true,day:this.day()};
 }
 settle(id,outcome){
  if(!['submitted','unknown','failed','success'].includes(outcome))throw new Stop('invalid_order_outcome');
  const record=this.data.orders[id];if(!record)return false;
  if(['success','failed'].includes(record.outcome))return record.outcome===outcome;
  record.outcome=outcome;record.updated_at=new Date(this.now()).toISOString();this.save();return true;
 }
}
