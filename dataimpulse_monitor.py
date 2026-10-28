#!/usr/bin/env python3
"""Production DataImpulse-only monitor; shared stock notifications, no old pool."""
import argparse
import collections
import concurrent.futures
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import signal
import time
import urllib.request

import monitor as m
from dataimpulse_client import DataImpulseClient
from proxy_monitor import parse_offers


def inventory(client,products,zipcode):
    started=time.time();clock=time.monotonic()
    result={'at':dt.datetime.now(m.TZ).isoformat(),'source':'dataimpulse','node':'dataimpulse-us-rotating',
        'ip':None,'actual_exit_ip_verified':False,'skus':list(products),'started_epoch':started}
    raw=None
    try:
        raw=client.inventory_region(products,zipcode)
        result['result']='http_200'
    except m.QueryError as error:
        result.update(result=error.code,retry_after=error.retry_after)
    except Exception as error:
        result.update(result='network_error',error_type=type(error).__name__)
    result.update(completed_at=dt.datetime.now(m.TZ).isoformat(),completed_epoch=time.time(),
        elapsed_seconds=round(time.monotonic()-clock,3),response_body_bytes=client.response_bytes)
    return raw,result


def inventory_from_settings(environ,products,zipcode,client_factory):
    # Client construction consults macOS proxy settings and can be nontrivial;
    # keep it off the pacing/notification thread, like the cadence benchmark.
    started=time.time();clock=time.monotonic();at=dt.datetime.now(m.TZ).isoformat()
    try:
        client=client_factory(environ,'us');raw,event=inventory(client,products,zipcode)
    except Exception as error:
        raw=None;event={'source':'dataimpulse','node':'dataimpulse-us-rotating','ip':None,
            'actual_exit_ip_verified':False,'skus':list(products),'result':'network_error',
            'error_type':type(error).__name__,'response_body_bytes':0,
            'completed_at':dt.datetime.now(m.TZ).isoformat(),'completed_epoch':time.time()}
    event.update(at=at,started_epoch=started,elapsed_seconds=round(time.monotonic()-clock,3))
    return raw,event


def health_notice(state,text,now):
    live=state.setdefault('dataimpulse_live',{})
    if now-live.get('last_health_notice_at',0)<600:return False
    live['last_health_notice_at']=now
    try:m.telegram(text);return True
    except Exception:m.LOG.warning('dataimpulse_health_notice_failed');return False


def record_health(state,result,now):
    live=state.setdefault('dataimpulse_live',{})
    if result['result']=='http_200':
        live['consecutive_failures']=0
        live['failure_blocked_until']=0
        state['dataimpulse_live_blocked_until']=live.get('server_blocked_until',0)
        live.pop('outage_active',False)
        if live.pop('outage_notified',False):
            try:m.telegram('✅ DataImpulse 库存监控已恢复成功查询。')
            except Exception:m.LOG.warning('dataimpulse_recovery_notice_failed')
        return
    failures=live.get('consecutive_failures',0)+1;live['consecutive_failures']=failures
    retry=result.get('retry_after',0)
    if result['result']=='http_429' or retry:
        live['server_blocked_until']=max(live.get('server_blocked_until',0),now+max(300,retry))
    if failures>=10:
        live['failure_blocked_until']=max(live.get('failure_blocked_until',0),
            now+min(900,60*2**min(failures-10,4)))
        live['outage_active']=True
        live['outage_notified']=live.get('outage_notified',False) or health_notice(state,'⚠️ DataImpulse 库存监控连续失败，已退避；请检查代理或网络。不会持续弹出提醒。',now)
    state['dataimpulse_live_blocked_until']=max(live.get('server_blocked_until',0),live.get('failure_blocked_until',0))


def run(args,client_factory=DataImpulseClient):
    # Notification and proxy settings are deliberately loaded from separate files.
    m.load_env(args.env_file);m.load_env(args.proxy_env_file)
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
    os.environ['NO_PROXY']=os.environ['no_proxy']=''
    environ=dict(os.environ);client_factory(environ,'us')
    config=json.loads((m.ROOT/'config.json').read_text());config['auto_open_product_page']=False
    override=m.environment_region();zipcode=override['zip'] if override else args.zip
    products=m.select_products(config)
    runtime=m.ROOT/'runtime/proxy-monitor';runtime.mkdir(parents=True,exist_ok=True)
    lock=(runtime/'monitor.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:lock.close();raise RuntimeError('monitor_already_running') from None
    state_path=runtime/'state.json';state=json.loads(state_path.read_text()) if state_path.exists() else {}
    state.setdefault('sent',{});state.setdefault('dataimpulse_live',{})
    output=runtime/dt.datetime.now(m.TZ).strftime('%Y%m%d-%H%M%S');output.mkdir()
    counts=collections.Counter();started=time.monotonic();deadline=started+args.duration if args.duration else float('inf')
    report={'pid':os.getpid(),'status':'running','backend':'dataimpulse_only','uses_original_pool':False,
        'started_at':dt.datetime.now(m.TZ).isoformat(),'target_start_spacing':args.spacing,'workers':args.workers,
        'zip':zipcode,'monitored_skus':list(products),'monitored_products':[v['name'] for v in products.values()],
        'counts':{},'queries':0,'alerts_sent':0,'notification_errors':0,'response_body_bytes':0,
        'actual_exit_ip_verified':False,'unique_exits':None,'pool':[],
        'dataimpulse':{'mode':'continuous','country':'us','transport':'urllib','socket_timeout_seconds':12},
        'telegram_configured':bool(os.environ.get('TELEGRAM_BOT_TOKEN') and os.environ.get('TELEGRAM_CHAT_ID')),
        'output':str(output)}
    stop=False
    def stop_requested(*_):
        nonlocal stop
        stop=True
    signal.signal(signal.SIGTERM,stop_requested);signal.signal(signal.SIGINT,stop_requested)
    def save():
        m.atomic_json(state_path,state);m.atomic_json(output/'report.json',report);m.atomic_json(runtime/'current.json',report)
    pending={};next_start=started;save()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor,(output/'queries.jsonl').open('a',buffering=1) as log:
            while pending or (not stop and time.monotonic()<deadline):
                for future in [f for f in pending if f.done()]:
                    pending.pop(future);raw,event=future.result()
                    offers=[]
                    if event['result']=='http_200':
                        try:
                            offers=parse_offers(raw,products,config,zipcode,state,dt.datetime.fromisoformat(event['at']).timestamp())
                            event.update(stores=len(raw['body']['stores']),eligible_offers=len(offers))
                            m.atomic_json(output/'last-inventory.json',raw)
                        except Exception as error:
                            event['result']=error.code if isinstance(error,m.QueryError) else 'invalid_response'
                    if event['result']=='http_200':
                        report['last_success_at']=dt.datetime.now(m.TZ).isoformat()
                        for offer in offers:
                            if stop or time.monotonic()>=deadline:break
                            should_send=m.should_alert(offer,state,time.time())
                            try:
                                m.notify_offer(offer,config,state,runtime,False,set())
                                if should_send:report['alerts_sent']+=1
                            except Exception:report['notification_errors']+=1;m.LOG.warning('dataimpulse_stock_notification_failed')
                    record_health(state,event,time.time())
                    counts[event['result']]+=1;report['counts']=dict(counts)
                    report['counts_by_source']={'dataimpulse':dict(counts)};report['queries']=sum(counts.values())
                    report['response_body_bytes']+=event['response_body_bytes']
                    live=state['dataimpulse_live'];live['total_response_body_bytes']=live.get('total_response_body_bytes',0)+event['response_body_bytes']
                    day=dt.datetime.now(m.TZ).date().isoformat()
                    if live.get('body_date')!=day:live.update(body_date=day,daily_response_body_bytes=0)
                    live['daily_response_body_bytes']+=event['response_body_bytes']
                    report['daily_response_body_bytes']=live['daily_response_body_bytes']
                    report['last_query_at']=event['completed_at'];report['elapsed_seconds']=round(time.monotonic()-started,3)
                    report['dataimpulse']['blocked_until']=state.get('dataimpulse_live_blocked_until',0)
                    log.write(json.dumps(event)+'\n');save()
                now=time.monotonic()
                if not stop and now<deadline and len(pending)<args.workers and now>=next_start and time.time()>=state.get('dataimpulse_live_blocked_until',0):
                    future=executor.submit(inventory_from_settings,environ,products,zipcode,client_factory)
                    pending[future]=True;next_start=time.monotonic()+args.spacing
                time.sleep(.02)
        report['status']='stopped_by_signal' if stop else 'completed'
    except Exception:
        report['status']='failed'
        health_notice(state,'⚠️ DataImpulse 库存监控进程异常退出，请检查本机服务。',time.time())
        raise
    finally:
        report['finished_at']=dt.datetime.now(m.TZ).isoformat();save()
        fcntl.flock(lock,fcntl.LOCK_UN);lock.close()
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file',type=Path,required=True)
    p.add_argument('--proxy-env-file',type=Path,default=Path.home()/'.codex/secrets/dataimpulse.env')
    p.add_argument('--duration',type=int,default=0)
    p.add_argument('--spacing',type=float,default=1)
    p.add_argument('--workers',type=int,default=4)
    p.add_argument('--zip',default='07094')
    args=p.parse_args()
    if args.duration<0 or args.spacing<1 or not 1<=args.workers<=4:p.error('duration >=0, spacing >=1, workers 1–4')
    try:run(args)
    except Exception as error:
        if not (isinstance(error,RuntimeError) and error.args==('monitor_already_running',)):
            try:
                path=m.ROOT/'runtime/proxy-monitor/state.json'
                state=json.loads(path.read_text()) if path.exists() else {}
                health_notice(state,'⚠️ DataImpulse 库存监控无法正常运行，请检查本机服务。',time.time())
                m.atomic_json(path,state)
            except Exception:pass
        print('DataImpulse monitor stopped; credentials and raw exceptions were not logged.',flush=True);return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
