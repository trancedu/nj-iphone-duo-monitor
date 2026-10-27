#!/usr/bin/env python3
"""Finite isolated DataImpulse inventory benchmark: never notifies or places orders."""
import argparse
import collections
import concurrent.futures
import datetime as dt
import json
import os
from pathlib import Path
import statistics
import time

import monitor as m
from dataimpulse_smoke import DataImpulseClient
from proxy_monitor import parse_offers


def summarize(rows):
    counts = collections.Counter(r['result'] for r in rows)
    good = sorted(r['completed_epoch'] for r in rows if r['result']=='http_200')
    gaps = [b-a for a,b in zip(good,good[1:])]
    durations = sorted(r['elapsed_seconds'] for r in rows)
    starts = sorted(r['started_epoch'] for r in rows)
    def percentile(values,p): return round(sorted(values)[int((len(values)-1)*p)],3) if values else None
    return {'queries':len(rows),'counts':dict(counts),
        'success_percent':round(counts['http_200']/len(rows)*100,2) if rows else None,
        'mean_start_gap_seconds':round((starts[-1]-starts[0])/(len(starts)-1),3) if len(starts)>1 else None,
        'mean_request_seconds':round(statistics.mean(durations),3) if durations else None,
        'p95_request_seconds':percentile(durations,.95),
        'mean_success_gap_seconds':round(statistics.mean(gaps),3) if gaps else None,
        'p95_success_gap_seconds':percentile(gaps,.95),
        'max_success_gap_seconds':round(max(gaps),3) if gaps else None,
        'response_body_bytes':sum(r['response_body_bytes'] for r in rows),
        'positive_queries':sum(r.get('eligible_offers',0)>0 for r in rows)}


def query(environ,config,country,zipcode,client_factory=DataImpulseClient):
    started=time.time();clock=time.monotonic();client=None
    result={'started_at':dt.datetime.now(dt.timezone.utc).isoformat(),'started_epoch':started}
    try:
        client=client_factory(environ,country)
        products=m.select_products(config)
        raw=client.inventory_region(products,zipcode)
        offers=parse_offers(raw,products,config,zipcode)
        result.update(result='http_200',stores=len(raw['body']['stores']),configurations=len(products),eligible_offers=len(offers))
    except m.QueryError as error:
        result.update(result=error.code,retry_after_seconds=error.retry_after)
    except Exception as error:
        result.update(result='request_failed', error_type=type(error).__name__)
    result.update(completed_at=dt.datetime.now(dt.timezone.utc).isoformat(),completed_epoch=time.time(),
        elapsed_seconds=round(time.monotonic()-clock,3),response_body_bytes=client.response_bytes if client else 0)
    return result


def benchmark(environ,config,output,duration=600,spacing=2,workers=4,max_bytes=50*1024*1024,request=query):
    output.mkdir(parents=True,exist_ok=False,mode=0o700)
    rows=[];pending={};start=time.monotonic();end=start+duration;next_start=start;submitted=0
    max_requests=min(300,int(duration/spacing+0.999999));stop_reason=None
    report={'started_at':dt.datetime.now(dt.timezone.utc).isoformat(),'duration_seconds':duration,
        'target_spacing_seconds':spacing,'max_requests':max_requests,'workers':workers,'zip':'07094',
        'country':'us','notifications_enabled':False,'production_changed':False,'max_response_body_bytes':max_bytes,
        'actual_exit_ip_verified':False,'note':'Rotating: each connection may use a different exit. Same-IP 60s spacing cannot be verified. Body bytes exclude billing overhead.'}
    def save(status):
        report.update(status=status,elapsed_seconds=round(time.monotonic()-start,3),submitted=submitted,
            in_flight=len(pending),stop_reason=stop_reason,**summarize(rows))
        m.atomic_json(output/'report.json',report)
    save('running')
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor,(output/'queries.jsonl').open('a',buffering=1) as log:
        while pending or (not stop_reason and time.monotonic()<end and submitted<max_requests):
            for future in [f for f in pending if f.done()]:
                sequence=pending.pop(future);row=future.result();row['sequence']=sequence;rows.append(row)
                log.write(json.dumps(row)+'\n')
                if row['result']=='http_429' or row.get('retry_after_seconds',0):stop_reason='server_backoff'
                elif row['result']=='http_407':stop_reason='proxy_authentication_failed'
                if sum(r['response_body_bytes'] for r in rows)>=max_bytes:stop_reason='body_budget_reached'
                if len(rows)>=10 and all(r['result']!='http_200' for r in rows[-10:]):stop_reason='ten_consecutive_failures'
                save('running')
            now=time.monotonic()
            if not stop_reason and now<end and submitted<max_requests and len(pending)<workers and now>=next_start:
                submitted+=1
                future=executor.submit(request,environ,config,'us','07094')
                pending[future]=submitted;next_start=time.monotonic()+spacing;save('running')
            # No catch-up burst when workers are occupied; drain existing requests at the end.
            time.sleep(.02)
    report['finished_at']=dt.datetime.now(dt.timezone.utc).isoformat();save('completed')
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file',type=Path,default=Path.home()/'.codex/secrets/dataimpulse.env')
    p.add_argument('--duration',type=int,default=600)
    p.add_argument('--spacing',type=float,default=2)
    args=p.parse_args()
    if not 2<=args.duration<=600 or args.spacing<2:p.error('duration 2–600 seconds, spacing >=2 seconds')
    try:
        m.load_env(args.env_file);environ=dict(os.environ);DataImpulseClient(environ,'us')
        config=json.loads((m.ROOT/'config.json').read_text())
        output=m.ROOT/'runtime/dataimpulse-benchmark'/dt.datetime.now(m.TZ).strftime('%Y%m%d-%H%M%S')
        print('Isolated benchmark output:',output,flush=True)
        report=benchmark(environ,config,output,args.duration,args.spacing)
        print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
        return 0 if report['counts'].get('http_200') else 1
    except Exception:
        print('Benchmark stopped; raw exceptions and credentials were not logged.',flush=True);return 1


if __name__=='__main__':raise SystemExit(main())
