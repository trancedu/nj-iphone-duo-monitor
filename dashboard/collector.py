#!/usr/bin/env python3
"""Read-only log/snapshot observer. No Apple, Telegram or browser requests."""
import argparse
import bisect
import collections
import datetime as dt
import fcntl
import html
import json
import os
from pathlib import Path
import sqlite3
import statistics
import sys
import time
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import monitor as monitor
from proxy_monitor import EXPECTED_07094
TZ=ZoneInfo('America/New_York')

def epoch(value):
    return dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()

def clean(value):
    return ' '.join(html.unescape(__import__('re').sub('<[^>]*>',' ',str(value or ''))).split())[:300]

class Collector:
    def __init__(self,root=ROOT):
        self.root=Path(root);self.logs=self.root/'runtime/proxy-monitor';self.output=self.root/'dashboard/site/data.json'
        self.work=self.root/'runtime/dashboard';self.work.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db=sqlite3.connect(self.work/'history.sqlite3');self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,inode INTEGER,offset INTEGER);
          CREATE TABLE IF NOT EXISTS queries(id TEXT PRIMARY KEY,at REAL,finished REAL,result TEXT,duration REAL,offers INTEGER,skus TEXT,covered TEXT,source TEXT);
          CREATE INDEX IF NOT EXISTS query_time ON queries(finished);
          CREATE INDEX IF NOT EXISTS query_empty ON queries(result,offers,finished);
          CREATE TABLE IF NOT EXISTS positives(id TEXT PRIMARY KEY,t REAL,sid TEXT,sku TEXT,pickup_date TEXT,store TEXT,state TEXT,quote TEXT);
          CREATE INDEX IF NOT EXISTS positive_key ON positives(sid,sku,t);
          CREATE TABLE IF NOT EXISTS negatives(id TEXT PRIMARY KEY,t REAL,sid TEXT,sku TEXT,source TEXT);
          CREATE INDEX IF NOT EXISTS negative_key ON negatives(sid,sku,t);
          CREATE TABLE IF NOT EXISTS current(sid TEXT,sku TEXT,t REAL,eligible INTEGER,available INTEGER,pickup_date TEXT,quote TEXT,store TEXT,state TEXT,city TEXT,PRIMARY KEY(sid,sku));
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
        ''')
        self.db.commit();(self.work/'history.sqlite3').chmod(0o600)
        self.config=json.loads((self.root/'config.json').read_text());catalog=self.root/'catalog.json'
        self.products=json.loads(catalog.read_text()) if catalog.exists() else {}
        self.products.update(self.config['products']);self.monitor={};self.last_snapshot=None
        self.report_cache={};self.bad_lines=0
    def load(self,path):
        try:return json.loads(Path(path).read_text())
        except (OSError,ValueError):return None
    def ingest(self,path,kind,max_bytes=4*1024*1024):
        path=Path(path)
        if not path.exists():return
        stat=path.stat();name=str(path.relative_to(self.root));prior=self.db.execute('SELECT inode,offset FROM files WHERE path=?',(name,)).fetchone()
        offset=prior['offset'] if prior and prior['inode']==stat.st_ino and stat.st_size>=prior['offset'] else 0
        if prior and prior["inode"]==stat.st_ino and offset==stat.st_size:return
        begin=offset
        if kind=='query':
            run=str(path.parent);report=self.report_cache.get(run)
            if report is None:
                report=self.load(path.parent/'report.json') or {};self.report_cache[run]=report
        with path.open('rb') as stream:
            stream.seek(offset)
            while stream.tell()-begin<max_bytes:
                position=stream.tell();line=stream.readline()
                if not line or not line.endswith(b'\n'):break
                offset=stream.tell();identifier=f'{name}:{stat.st_ino}:{position}'
                try:
                    item=json.loads(line)
                    if kind=='query':
                        at=epoch(item['at']);finished=epoch(item.get('completed_at',item['at']))
                        covered=EXPECTED_07094 if report.get('zip')=='07094' and item.get('stores')==12 else []
                        self.db.execute('INSERT OR IGNORE INTO queries VALUES (?,?,?,?,?,?,?,?,?)',
                            (identifier,at,finished,item.get('result','unknown'),item.get('elapsed_seconds',0),item.get('eligible_offers'),
                             json.dumps(item.get('skus',[])),json.dumps(covered),item.get('source','primary')))
                    else:
                        if item.get('sku') not in self.products:continue
                        self.db.execute('INSERT OR IGNORE INTO positives VALUES (?,?,?,?,?,?,?,?)',
                            (identifier,epoch(item['observed_at']),item['store_id'],item['sku'],item.get('date'),clean(item.get('store')),item.get('state'),clean(item.get('quote'))))
                except (ValueError,KeyError,TypeError):self.bad_lines+=1
        self.db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?)',(name,stat.st_ino,offset));self.db.commit()
    def snapshot(self):
        current=self.load(self.logs/'current.json')
        if not current:return
        self.monitor=current
        try:
            directory=Path(current['output']).resolve()
            if not directory.is_relative_to(self.logs.resolve()):return
            path=directory/'last-inventory.json';stat=path.stat()
            token=(str(path),stat.st_mtime_ns,stat.st_size)
            if token==self.last_snapshot:return
            raw=self.load(path)
            if not raw:return
            products={sku:self.config['products'][sku] for sku in current.get('monitored_skus',[]) if sku in self.config['products']}
            if not products:return
            observed=stat.st_mtime;today=dt.datetime.fromtimestamp(observed,TZ).date();zipcode=current.get('zip')
            normalized=monitor.regional_payloads(raw,products,None,{'zip':zipcode,'dynamic':True},today)
            eligible={}
            for sku,payload in normalized.items():
                offers,_=monitor.parse_inventory(payload,{sku:products[sku]},today,self.config['max_pickup_days'],None,None)
                for offer in offers:eligible[(offer['store_id'],sku)]=offer
            rows=raw['body']['stores']
            for store in rows:
                sid=store['storeNumber']
                for sku in products:
                    part=store['partsAvailability'][sku];regular=part.get('messageTypes',{}).get('regular',{})
                    available=part.get('pickupDisplay')=='available' and regular.get('storeSelectionEnabled') is True
                    offer=eligible.get((sid,sku));is_eligible=bool(offer)
                    quote=clean(part.get('pickupSearchQuote','')+' / '+regular.get('storePickupQuote',''))
                    date=offer['date'] if offer else None
                    old=self.db.execute('SELECT * FROM current WHERE sid=? AND sku=?',(sid,sku)).fetchone()
                    if old and old['t']>observed:continue
                    if is_eligible and (not old or not old['eligible']):
                        self.db.execute('INSERT OR IGNORE INTO positives VALUES (?,?,?,?,?,?,?,?)',
                            (f'snapshot:{observed}:{sid}:{sku}',observed,sid,sku,date,'Apple '+store['storeName'],store.get('state'),quote))
                    if not is_eligible and (not old or old['eligible']):
                        if old and old['eligible']:
                            self.db.execute('INSERT OR IGNORE INTO positives VALUES (?,?,?,?,?,?,?,?)',
                                (f'last-seen:{old["t"]}:{sid}:{sku}',old['t'],sid,sku,old['pickup_date'],old['store'],old['state'],old['quote']))
                        self.db.execute('INSERT OR IGNORE INTO negatives VALUES (?,?,?,?,?)',
                            (f'snapshot:{observed}:{sid}:{sku}',observed,sid,sku,'snapshot'))
                    self.db.execute('INSERT OR REPLACE INTO current VALUES (?,?,?,?,?,?,?,?,?,?)',
                        (sid,sku,observed,int(is_eligible),int(available),date,quote,'Apple '+store['storeName'],store.get('state'),store.get('city','')))
            self.db.execute("INSERT OR REPLACE INTO meta VALUES ('last_snapshot',?)",(str(observed),));self.db.commit();self.last_snapshot=token
        except (OSError,ValueError,KeyError,TypeError,monitor.QueryError):
            # Roll back the entire observation: partial input cannot close a stock period.
            self.db.rollback()
            return
    def ingest_all(self):
        for path in sorted(self.logs.glob('20*/queries.jsonl')):self.ingest(path,'query')
        self.ingest(self.logs/'availability-events.jsonl','positive')
        self.snapshot()
    def absence_index(self):
        # One indexed history pass replaces thousands of repeated SQLite scans per refresh.
        direct=collections.defaultdict(lambda:{'times':[],'sources':[]})
        for row in self.db.execute('SELECT sid,sku,t,source FROM negatives ORDER BY t'):
            group=direct[(row['sid'],row['sku'])]
            group['times'].append(row['t']);group['sources'].append(row['source'])
        zero={}
        for row in self.db.execute("SELECT at,finished,skus,covered FROM queries WHERE result='http_200' AND offers=0 ORDER BY finished"):
            key=(row['skus'],row['covered'])
            if key not in zero:
                zero[key]={'skus':set(json.loads(row['skus'])),'stores':set(json.loads(row['covered'])),
                           'times':[],'starts':[]}
            group=zero[key];group['times'].append(row['finished']);group['starts'].append(row['at'])
        return direct,list(zero.values())

    def absence(self,sid,sku,after,before,index=None):
        if index is not None:
            direct,zero=index;candidates=[]
            group=direct.get((sid,sku))
            if group:
                position=bisect.bisect_right(group['times'],after)
                if position<len(group['times']) and group['times'][position]<before:
                    candidates.append({'t':group['times'][position],'source':group['sources'][position]})
            for group in zero:
                if sid not in group['stores'] or sku not in group['skus']:continue
                position=bisect.bisect_right(group['times'],after)
                while position<len(group['times']) and group['times'][position]<before:
                    if group['starts'][position]>after:
                        candidates.append({'t':group['times'][position],'source':'query_empty'});break
                    position+=1
            return min(candidates,key=lambda row:row['t']) if candidates else None
        direct=self.db.execute('SELECT t,source FROM negatives WHERE sid=? AND sku=? AND t>? AND t<? ORDER BY t LIMIT 1',(sid,sku,after,before)).fetchone()
        zero=self.db.execute("SELECT finished AS t,'query_empty' AS source FROM queries WHERE result='http_200' AND offers=0 AND at>? AND finished<? AND instr(skus,?)>0 AND instr(covered,?)>0 ORDER BY finished LIMIT 1",(after,before,json.dumps(sku),json.dumps(sid))).fetchone()
        candidates=[dict(row) for row in (direct,zero) if row]
        return min(candidates,key=lambda row:row['t']) if candidates else None
    def periods(self,now):
        index=self.absence_index()
        groups=collections.defaultdict(list)
        for row in self.db.execute('SELECT * FROM positives ORDER BY t'):
            groups[(row['sid'],row['sku'])].append(dict(row))
        current={(row['sid'],row['sku']):dict(row) for row in self.db.execute('SELECT * FROM current')}
        periods=[]
        for (sid,sku),observations in groups.items():
            latest=current.get((sid,sku))
            # Treat the latest positive snapshot as another observation, not an extension
            # across an arbitrary monitoring outage. Historical unknowns stay unknown.
            if latest and latest['eligible'] and latest['t']>observations[-1]['t']:
                observations.append({'t':latest['t'],'store':latest['store'],'state':latest['state'],
                                     'pickup_date':latest['pickup_date']})
            first_seen=observations[0]['t'];active=None;segments=[]
            for point in observations:
                if active:
                    closed=self.absence(sid,sku,active['last_seen'],point['t'],index)
                    if closed:
                        active.update(end=closed['t'],end_evidence=closed['source'],end_reason='confirmed_unavailable')
                        segments.append(active);active=None
                    elif point['t']-active['last_seen']>120:
                        active['end_reason']='observation_gap'
                        segments.append(active);active=None
                if active is None:
                    active={'store_id':sid,'sku':sku,'store':point['store'],'state':point['state'],
                            'start':point['t'],'last_seen':point['t'],'end':None,'end_evidence':None,
                            'end_reason':'unknown','pickup_dates':[],'observations':0}
                active['last_seen']=max(active['last_seen'],point['t']);active['observations']+=1
                if point['pickup_date'] and point['pickup_date'] not in active['pickup_dates']:
                    active['pickup_dates'].append(point['pickup_date'])
            if active:
                closed=self.absence(sid,sku,active['last_seen'],now+1,index)
                if closed:
                    active.update(end=closed['t'],end_evidence=closed['source'],end_reason='confirmed_unavailable')
                segments.append(active)
            for number,segment in enumerate(segments,1):
                segment.update(segment_number=number,historical_first_seen=first_seen,
                    is_current=bool(latest and latest['eligible'] and segment['end'] is None and
                                    segment is segments[-1] and latest['t']>=segment['start']-2),
                    observed_span_seconds=round(segment['last_seen']-segment['start'],3),
                    elapsed_seconds=round(segment['end']-segment['start'],3) if segment['end'] is not None else None)
                periods.append(segment)
        return sorted(periods,key=lambda row:row['start'],reverse=True)

    @staticmethod
    def waves(periods,merge_seconds=120):
        """Presentation grouping only: never erase negatives or claim continuous stock."""
        groups=collections.defaultdict(list)
        for period in sorted(periods,key=lambda row:row['start']):
            groups[(period['store_id'],period['sku'])].append(period)
        waves=[]
        for records in groups.values():
            active=None;number=0
            for period in records:
                merge=bool(active and active['end'] is not None and
                           0<=period['start']-active['last_seen']<=merge_seconds)
                if not merge:
                    if active:waves.append(active)
                    number+=1
                    active={key:period[key] for key in ('store_id','sku','store','state','historical_first_seen')}
                    active.update(wave_number=number,start=period['start'],segments=[],pickup_dates=[],observations=0)
                active['segments'].append(period)
                active.update(last_seen=period['last_seen'],end=period['end'],end_evidence=period['end_evidence'],
                              end_reason=period['end_reason'],is_current=period['is_current'])
                active['observations']+=period['observations']
                for date in period['pickup_dates']:
                    if date not in active['pickup_dates']:active['pickup_dates'].append(date)
                active['elapsed_seconds']=round(active['end']-active['start'],3) if active['end'] is not None else None
                active['observed_span_seconds']=round(active['last_seen']-active['start'],3)
                active['segment_count']=len(active['segments'])
                active['brief_unavailable_count']=len(active['segments'])-1
            if active:waves.append(active)
        return sorted(waves,key=lambda row:row['start'],reverse=True)

    def metrics(self,minutes,now):
        rows=[dict(row) for row in self.db.execute('SELECT * FROM queries WHERE finished>=? ORDER BY finished',(now-minutes*60,))]
        counts=collections.Counter(row['result'] for row in rows);good=[row for row in rows if row['result']=='http_200'];gaps=[b['finished']-a['finished'] for a,b in zip(good,good[1:])]
        latencies=[row['duration'] for row in good]
        def percentile(values):return round(sorted(values)[int((len(values)-1)*.95)],3) if values else None
        return {'queries':len(rows),'success':len(good),'errors':len(rows)-len(good),'counts':dict(counts),
            'success_percent':round(100*len(good)/len(rows),1) if rows else None,
            'mean_latency':round(statistics.mean(latencies),3) if latencies else None,'p95_latency':percentile(latencies),
            'max_latency':round(max((row['duration'] for row in rows),default=0),3),
            'mean_gap':round(statistics.mean(gaps),3) if gaps else None,'p95_gap':percentile(gaps),'max_gap':round(max(gaps),3) if gaps else None}
    def export(self):
        now=time.time();periods=self.periods(now)
        current=[dict(row) for row in self.db.execute('SELECT * FROM current ORDER BY state,store,sku')]
        for row in current:row.update(store_id=row.pop('sid'),observed_at=row.pop('t'))
        queries=[dict(row) for row in self.db.execute('SELECT at,finished,result,duration,offers,source FROM queries ORDER BY finished DESC LIMIT 200')]
        buckets=collections.defaultdict(lambda:{'success':0,'errors':0,'latencies':[]})
        for row in self.db.execute('SELECT finished,result,duration FROM queries WHERE finished>=?',(now-3600,)):
            b=buckets[int(row['finished']//60)*60]
            if row['result']=='http_200':b['success']+=1;b['latencies'].append(row['duration'])
            else:b['errors']+=1
        chart=[{'at':t,'success':v['success'],'errors':v['errors'],'mean_latency':round(statistics.mean(v['latencies']),3) if v['latencies'] else None} for t,v in sorted(buckets.items())]
        safe_monitor={key:self.monitor.get(key) for key in ('status','backend','uses_original_pool','target_start_spacing','workers','zip','last_success_at','last_query_at','telegram_configured','alerts_sent','notification_errors')}
        if not safe_monitor['backend'] and 'unique_exits' in self.monitor:
            safe_monitor['backend']='clash'
            safe_monitor['uses_original_pool']=True
        for key in ('last_success_at','last_query_at'):
            try:safe_monitor[key]=epoch(safe_monitor[key]) if safe_monitor[key] else None
            except (ValueError,TypeError):safe_monitor[key]=None
        result={'generated_at':now,'timezone':'America/New_York','monitor':safe_monitor,
            'metrics':{str(m):self.metrics(m,now) for m in (5,30,60)},'stores':current,'products':self.products,
            'periods':periods,'waves':self.waves(periods),'history_rules':{'merge_seconds':120,'observation_gap_seconds':120},'queries':queries,'chart':chart,'collector':{'last_snapshot':float(self.db.execute("SELECT value FROM meta WHERE key='last_snapshot'").fetchone()[0]) if self.db.execute("SELECT value FROM meta WHERE key='last_snapshot'").fetchone() else None,'bad_lines':self.bad_lines},
            'evidence_notes':['库存范围：可选门店且取货日期在当天至未来三天。','query_empty：历史查询确认当次覆盖范围无符合条件库存，消失时刻为推断上界。','snapshot：独立观察到该门店/规格不再符合条件；查询失败不视为无货。','首次/最后观察不是物理补货/售罄精确时刻；未覆盖的历史结束时间保持未知。']}
        self.output.parent.mkdir(parents=True,exist_ok=True);temp=self.output.with_suffix('.tmp');temp.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')));temp.replace(self.output)
        return result

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--once',action='store_true');p.add_argument('--interval',type=float,default=.5);args=p.parse_args()
    collector=Collector();lock=(collector.work/'collector.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('Dashboard observer already running')
    try:os.nice(10)
    except OSError:pass
    last_export=0
    while True:
        try:
            collector.ingest_all()
            if args.once or time.monotonic()-last_export>=5:collector.export();last_export=time.monotonic()
        except Exception:
            print('dashboard_collection_error; source monitor untouched',flush=True)
            if args.once:raise SystemExit(1)
        if args.once:break
        time.sleep(max(.25,args.interval))

if __name__=='__main__':main()
