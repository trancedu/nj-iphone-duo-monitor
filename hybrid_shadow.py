#!/usr/bin/env python3
"""Finite shadow hedge driven by existing production freshness; never notifies."""
import argparse
import collections
import concurrent.futures
import datetime as dt
import json
from pathlib import Path
import time
import monitor as m
from dataimpulse_fallback import FreshnessHedge,load_settings
from dataimpulse_benchmark import summarize
from proxy_monitor import parse_offers


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--duration',type=int,default=180)
    args=parser.parse_args()
    if not 10<=args.duration<=600:parser.error('duration must be 10–600 seconds')
    cfg,client=load_settings(args.config);state={};start=time.time();end=start+args.duration
    hedge=FreshnessHedge(cfg,state,start);config=json.loads((m.ROOT/'config.json').read_text());products=m.select_products(config)
    output=m.ROOT/'runtime/hybrid-shadow'/dt.datetime.now(m.TZ).strftime('%Y%m%d-%H%M%S');output.mkdir(parents=True,mode=0o700)
    primary_root=m.ROOT/'runtime/proxy-monitor';pending={};rows=[]
    def query(client):
        before=client.response_bytes;begin=time.time();clock=time.monotonic();row={'started_epoch':begin,'started_at':dt.datetime.now(dt.timezone.utc).isoformat()}
        try:
            raw=client.inventory_region(products,'07094');offers=parse_offers(raw,products,config,'07094')
            row.update(result='http_200',eligible_offers=len(offers))
        except m.QueryError as e:row.update(result=e.code,retry_after_seconds=e.retry_after)
        except Exception as e:row.update(result='request_failed',error_type=type(e).__name__)
        row.update(completed_epoch=time.time(),completed_at=dt.datetime.now(dt.timezone.utc).isoformat(),elapsed_seconds=round(time.monotonic()-clock,3),response_body_bytes=client.response_bytes-before)
        return row
    report={'started_at':dt.datetime.now(dt.timezone.utc).isoformat(),'production_changed':False,'notifications_enabled':False,'stale_after_seconds':cfg.get('stale_after_seconds',2)}
    def save(status):
        report.update(status=status,elapsed_seconds=round(time.time()-start,2),**summarize(rows));m.atomic_json(output/'report.json',report)
    print('Shadow output:',output,flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=cfg.get('max_in_flight',1)) as executor,(output/'queries.jsonl').open('a',buffering=1) as log:
        while time.time()<end or pending:
            now=time.time()
            for future in [f for f in pending if f.done()]:
                row=future.result();pending.pop(future);rows.append(row);log.write(json.dumps(row)+'\n')
                ok=row['result']=='http_200';hedge.finished(now,ok,row['response_body_bytes'],row.get('retry_after_seconds',0))
                if row['result']=='http_429':hedge.state['retry_at']=max(hedge.state['retry_at'],now+300)
                save('running')
            try:
                current=json.loads((primary_root/'current.json').read_text());primary=json.loads((primary_root/'state.json').read_text())
                stamp=current.get('last_success_at')
                if stamp:hedge.last_success=max(hedge.last_success,dt.datetime.fromisoformat(stamp).timestamp())
                block=primary.get('global_blocked_until',0)
            except (OSError,ValueError):block=now+1
            if now<end and hedge.reason_not_ready(now,len(pending),block,now-min(pending.values()) if pending else None) is None:
                hedge.dispatched(now);future=executor.submit(query,client.clone());pending[future]=now;save('running')
            time.sleep(.1)
    save('completed');report['finished_at']=dt.datetime.now(dt.timezone.utc).isoformat()
    # Rebuild primary completions for the same interval; no primary files are modified.
    primary_rows=[]
    for file in primary_root.glob('20*/queries.jsonl'):
        for line in file.read_text().splitlines():
            try:
                q=json.loads(line);finished=dt.datetime.fromisoformat(q['completed_at']).timestamp()
                if start<=finished<=time.time():
                    q.update(started_epoch=dt.datetime.fromisoformat(q['at']).timestamp(),completed_epoch=finished,response_body_bytes=0);primary_rows.append(q)
            except (ValueError,KeyError):pass
    report['primary']=summarize(primary_rows);report['combined']=summarize(primary_rows+rows);report['fallback']=summarize(rows)
    m.atomic_json(output/'report.json',report);print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)


if __name__=='__main__':
    try:main()
    except Exception:print('Shadow test stopped; credentials and raw exceptions were not logged.');raise SystemExit(1)
