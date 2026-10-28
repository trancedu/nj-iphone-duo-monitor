import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {openReceiverListeners} from '../listeners.mjs';
test('missing LAN address keeps authenticated handler reachable over loopback',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(req.headers.authorization==='Bearer test-secret'?200:401);res.end('ok');});
 let fallback;const c=await openReceiverListeners(server,{host:'192.0.2.99',port:0},{makeServer:h=>(fallback=http.createServer(h))});t.after(()=>c.close());
 assert.equal(c.state.lan_available,false);assert.equal(c.state.loopback_available,true);assert.equal(c.state.last_error,'EADDRNOTAVAIL');
 // The fallback must use the original request handler, never a public bypass.
 assert.equal(server.listeners('request').length,1);
 const base='http://127.0.0.1:'+fallback.address().port;
 assert.equal((await fetch(base,{headers:{connection:'close'}})).status,401);
 assert.equal((await fetch(base,{headers:{authorization:'Bearer test-secret',connection:'close'}})).status,200);
});
test('LAN reconnect attaches only the configured address with the same handler and stops retrying',async()=>{
 const handler=()=>{},calls=[];let available=false;
 class Server extends EventEmitter{constructor(h){super();this.on('request',h);this.listening=false;}close(){this.listening=false;}}
 const original=new Server(handler);
 const c=await openReceiverListeners(original,{host:'192.0.2.99',port:8765},{makeServer:h=>{assert.equal(h,handler);return new Server(h);},listenOn:async(s,p,h)=>{calls.push(h);if(h==='192.0.2.99'&&!available)throw Object.assign(Error(),{code:'EADDRNOTAVAIL'});s.listening=true;}});
 assert.deepEqual(calls,['192.0.2.99','127.0.0.1']);
 available=true;await c.retry();assert.equal(c.state.lan_available,true);assert.equal(c.state.last_error,null);assert.equal(calls.at(-1),'192.0.2.99');
 c.close();await c.retry();assert.equal(calls.length,3);
});
test('address conflicts remain explicit errors rather than silently binding elsewhere',async()=>{
 const s=new EventEmitter();s.close=()=>{};
 await assert.rejects(()=>openReceiverListeners(s,{host:'192.0.2.99',port:8765},{listenOn:async()=>{throw Object.assign(Error(),{code:'EADDRINUSE'});}}),e=>e.code==='EADDRINUSE');
});
