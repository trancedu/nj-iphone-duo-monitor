import http from 'node:http';
import {readFileSync, mkdirSync, openSync, writeFileSync, closeSync, unlinkSync, existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {authorized,normalizeIP,privateIPv4,validateEvent,Stop} from './protocol.mjs';
import {Engine} from './engine.mjs';
import {PickupBrowser} from './browser.mjs';

export function createReceiver(config,browser,secret,suppliedEngine=null) {
  if(typeof secret!=='string'||secret.length<32) throw new Stop('secret_too_short');
  const allowed=new Set(config.allowed_sources);
  const engine=suppliedEngine||new Engine(config,browser);
  const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
    const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    if(!allowed.has(normalizeIP(req.socket.remoteAddress))) return send(403,{status:'source_forbidden'});
    if(!authorized(req.headers.authorization,secret)) return send(401,{status:'unauthorized'});
    if(req.headers.origin) return send(403,{status:'browser_origin_forbidden'});
    try {
      const url=new URL(req.url,'http://receiver.local');
      if(url.search) return send(400,{status:'invalid_path'});
      if(req.method==='GET'&&url.pathname==='/health') return send(200,engine.health());
      if(req.method==='GET'&&/^\/status\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
        engine.expireHeld();
        const item=engine.state.events[url.pathname.slice(8)];
        return item?send(200,engine.public(item)):send(404,{status:'not_found'});
      }
      if(req.method!=='POST'||!['/prepare','/reset'].includes(url.pathname)) return send(404,{status:'not_found'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) return send(415,{status:'json_required'});
      let body='';
      for await(const chunk of req) {
        body+=chunk;
        if(Buffer.byteLength(body)>8192) return send(413,{status:'body_too_large'});
      }
      let raw;try {raw=JSON.parse(body);} catch {return send(400,{status:'invalid_json'});}
      if(url.pathname==='/reset') {
        if(!['127.0.0.1','::1'].includes(normalizeIP(req.socket.remoteAddress))) return send(403,{status:'local_reset_only'});
        if(raw?.confirm!==true||typeof raw.event_id!=='string') return send(400,{status:'explicit_reset_required'});
        return send(200,{status:await engine.reset(raw.event_id)?'reset':'not_active'});
      }
      const event=validateEvent(raw);
      if(engine.beforeAccept)await engine.beforeAccept(event);
      else if(!config.dry_run&&!engine.state.active&&!browser.ready()&&browser.ensurePage) {
        try {await browser.ensurePage();} catch { /* accept reports browser_not_ready */ }
      }
      const result=engine.accept(event);return send(result.code,result.body);
    } catch(error) {
      return send(error instanceof Stop&&error.code==='task_still_running'?409:400,
          {status:error instanceof Stop?error.code:'request_failed'});
    }
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.timeout=5000;
  return {server,engine};
}

export async function main(argv=process.argv.slice(2)) {
  const i=argv.indexOf('--config');
  if(i<0||!argv[i+1]) throw new Stop('config_required');
  const file=resolve(argv[i+1]),config=JSON.parse(readFileSync(file,'utf8'));
  for(const key of ['state_dir','profile_dir']) config[key]=resolve(dirname(file),config[key]);
  if(!privateIPv4(config.host)||!Number.isInteger(config.port)||config.port<1024||config.port>65535||
     !Array.isArray(config.allowed_sources)||!config.allowed_sources.length||
     config.allowed_sources.some(x=>!privateIPv4(x))||typeof config.dry_run!=='boolean'||
     !config.selectors?.bag_item||!config.selectors?.store_list||!config.selectors?.store_row) throw new Stop('invalid_config');
  const secret=process.env[config.secret_env||'PICKUP_SHARED_SECRET'];
  if(!config.dry_run && config.selectors_verified!==true) throw new Stop('verify_selectors_before_live');
  if(!secret||secret.length<32) throw new Stop('secret_too_short');
  mkdirSync(config.state_dir,{recursive:true,mode:0o700});
  const lock=join(config.state_dir,'receiver.lock');
  if(existsSync(lock)) {
    const pid=Number(readFileSync(lock,'utf8'));
    try {process.kill(pid,0);throw new Stop('receiver_already_running');}
    catch(e) {if(e instanceof Stop||e.code!=='ESRCH') throw e;unlinkSync(lock);}
  }
  const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
  const priorState=join(config.state_dir,'events.json');
  config.preserve_page=existsSync(priorState)&&!!JSON.parse(readFileSync(priorState,'utf8')).active;
  const browser=new PickupBrowser(config);
  let server,local;
  try {
    if(!config.dry_run||config.prewarm_browser) await browser.start();
    ({server}=createReceiver(config,browser,secret));
    await new Promise((ok,bad)=>{server.once('error',bad);server.listen(config.port,config.host,ok);});
    // A loopback listener allows local reset/health when the primary listener binds a LAN IP.
    if(!config.host.startsWith('127.')) {
      local=http.createServer(server.listeners('request')[0]);
      local.headersTimeout=5000;local.requestTimeout=5000;local.timeout=5000;
      await new Promise((ok,bad)=>{local.once('error',bad);local.listen(config.port,'127.0.0.1',ok);});
    }
    console.log(JSON.stringify({status:'listening',mode:config.dry_run?'dry_run':'live',port:config.port}));
    const stop=()=>{
      server.close();local?.close();
      if(existsSync(lock)) unlinkSync(lock);
      // Browser is deliberately left open until process shutdown; no order action is attempted.
      process.exit(0);
    };
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  } catch(error) {
    server?.close();local?.close();
    if(existsSync(lock)) unlinkSync(lock);
    console.error(JSON.stringify({status:'startup_failed',reason:error instanceof Stop?error.code:'startup_error'}));
    process.exitCode=1;
    if(browser.cdpBrowser) await browser.cdpBrowser.close().catch(()=>{});
    else if(browser.context) await browser.context.close().catch(()=>{});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(()=>{console.error('{"status":"startup_failed","reason":"configuration_error"}');process.exitCode=1;});
}
