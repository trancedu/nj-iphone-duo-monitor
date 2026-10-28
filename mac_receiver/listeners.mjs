import http from 'node:http';
function listen(server,port,host){
 return new Promise((resolve,reject)=>{
  const clean=()=>{server.off('error',bad);server.off('listening',ok);};
  const bad=error=>{clean();reject(error);};const ok=()=>{clean();resolve();};
  server.once('error',bad);server.once('listening',ok);server.listen(port,host);
 });
}
// The same authenticated request handler and source allowlist serve both listeners.
export async function openReceiverListeners(server,{host,port},{retryMs=5000,onStatus=()=>{},listenOn=listen,makeServer=handler=>http.createServer(handler)}={}){
 let lan=null,loopback=null,timer=null,closed=false,retrying=false;
 const state={configured_host:host,lan_available:false,loopback_available:false,last_error:null};
 const publish=()=>{try{onStatus({...state});}catch{}};
 const clone=()=>{const s=makeServer(server.listeners('request')[0]);s.requestTimeout=5000;s.headersTimeout=5000;s.timeout=5000;return s;};
 const close=()=>{closed=true;clearInterval(timer);for(const s of new Set([server,lan,loopback]))if(s?.listening)s.close();};
 const retry=async()=>{
  if(closed||retrying||state.lan_available)return;
  retrying=true;const candidate=clone();
  try{
   await listenOn(candidate,port,host);
   if(closed){if(candidate.listening)candidate.close();return;}
   lan=candidate;state.lan_available=true;state.last_error=null;clearInterval(timer);publish();
  }catch(error){if(candidate.listening)candidate.close();state.last_error=error.code||'listen_failed';}
  finally{retrying=false;}
 };
 try{
  try{await listenOn(server,port,host);if(host.startsWith('127.')){loopback=server;state.loopback_available=true;}else{lan=server;state.lan_available=true;}}
  catch(error){if(error.code!=='EADDRNOTAVAIL'||host.startsWith('127.'))throw error;state.last_error=error.code;}
  if(!state.loopback_available){
   loopback=clone();await listenOn(loopback,port,'127.0.0.1');state.loopback_available=true;
  }
  if(!host.startsWith('127.')&&!state.lan_available){timer=setInterval(()=>retry().catch(()=>{}),retryMs);timer.unref();}
  publish();return {state,retry,close};
 }catch(error){close();throw error;}
}
