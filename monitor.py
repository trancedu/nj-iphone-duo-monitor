#!/usr/bin/env python3
"""Apple pickup monitor. Only verified, near-date Duo availability is alertable."""
import argparse
import datetime as dt
import fcntl
import html
import http.cookiejar
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import random
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
TZ = ZoneInfo('America/New_York')
LOG = logging.getLogger('pickup')
BASE = 'https://www.apple.com'

class QueryError(Exception):
    def __init__(self, code, retry_after=0):
        self.code, self.retry_after = str(code), retry_after
        super().__init__(self.code)

def load_env(path):
    for line in Path(path).read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip().strip('\"\''))

def atomic_json(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(path)

def pickup_date(quote, today):
    """Fail closed on vague availability; date ranges use the last date."""
    text = html.unescape(re.sub('<[^>]+>', ' ', quote)).lower()
    if re.search(r'\b(unavailable|not available|check back)\b', text):
        return None
    if 'tomorrow' in text:
        return today + dt.timedelta(days=1)
    if 'today' in text:
        return today
    dates = []
    for value in re.findall(r'\b\d{4}-\d{2}-\d{2}\b', text):
        try: dates.append(dt.date.fromisoformat(value))
        except ValueError: pass
    pattern = r'\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?(?:,?\s+(20\d{2}))?'
    for month, day, last, year in re.findall(pattern, text):
        try:
            month_n = dt.datetime.strptime(month[:3], '%b').month
            date = dt.date(int(year or today.year), month_n, int(last or day))
            if not year and (date - today).days < -180:
                date = date.replace(year=date.year + 1)
            dates.append(date)
        except ValueError: pass
    return max(dates) if dates else None

def parse_inventory(payload, products, today, max_days=3, requested_stores=None, allowed_states=('NJ', 'NY')):
    try: records = payload['body']['content']
    except (KeyError, TypeError): raise QueryError('invalid_pickup_schema')
    if not isinstance(records, list) or not records:
        raise QueryError('empty_store_response')
    if len(products) != 1: raise QueryError('expected_single_sku')
    sku, product = next(iter(products.items()))
    offers, observed = [], 0
    seen = set()
    for item in records:
        sid = item.get('storeId')
        if not sid or sid in seen or (requested_stores and sid not in requested_stores):
            raise QueryError('unexpected_store_response')
        seen.add(sid)
        state = item.get('state', '')
        if allowed_states is not None:
            if state not in allowed_states: continue
        elif not re.fullmatch(r'[A-Z]{2}', state):
            raise QueryError('invalid_store_state')
        if not isinstance(item.get('storeSelectionEnabled'), bool):
            raise QueryError('missing_availability_flag')
        observed += 1
        if not item['storeSelectionEnabled']: continue
        quotes = [item.get('pickupSearchQuote', ''),item.get('storePickupQuote', '')]
        if any(re.search(r'\b(unavailable|not available|check back)\b', q, re.I) for q in quotes):
            continue
        encoded = item.get('pickupEncodedUpperDateString')
        if not encoded: continue
        try: date = dt.datetime.strptime(encoded,'%Y%m%d').date()
        except (ValueError,TypeError): raise QueryError('invalid_pickup_date')
        dates = [pickup_date(q,today) for q in quotes if q]
        dates = [d for d in dates if d is not None]
        if dates and any(d != date for d in dates):
            raise QueryError('conflicting_pickup_dates')
        if not 0 <= (date-today).days <= max_days: continue
        offers.append({'sku':sku,'name':product['name'],'url':product['url'],
                       'store':item.get('address',{}).get('address',sid),
                       'store_id':sid,'state':state,'date':date.isoformat(),
                       'quote':' / '.join(q for q in quotes if q)})
    if not observed: raise QueryError('no_requested_state_observations' if allowed_states is None else 'no_nj_ny_observations')
    return sorted(offers,key=lambda x:(x['date'],x['state'] != 'NJ',x['store'])), observed

class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.opener.addheaders = [('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'), ('Referer', BASE+'/shop/buy-iphone/iphone-duo')]

    def get(self, url):
        try:
            with self.opener.open(url, timeout=25) as response:
                return response.read().decode()
        except urllib.error.HTTPError as exc:
            retry = exc.headers.get('Retry-After', '')
            seconds = int(retry) if retry.isdigit() else 0
            if retry and not seconds:
                try:
                    import email.utils
                    seconds = max(0, int(email.utils.parsedate_to_datetime(retry).timestamp()-time.time()))
                except (ValueError, TypeError): pass
            raise QueryError('http_'+str(exc.code), seconds) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise QueryError('network_error') from None

    def inventory(self, sku, stores):
        params = {'product':sku}
        for i, store_id in enumerate(stores):
            params['stores.'+str(i)] = store_id
        raw = self.get(BASE+'/shop/sba/pickup-detail?'+urllib.parse.urlencode(params))
        try: return json.loads(raw)
        except ValueError: raise QueryError('non_json_response') from None

    def inventory_region(self, products, zipcode):
        params={'pl':'true','location':zipcode}
        params.update({'parts.'+str(i):sku for i,sku in enumerate(products)})
        raw=self.get(BASE+'/shop/retail/pickup-message?'+urllib.parse.urlencode(params))
        try: return json.loads(raw)
        except ValueError: raise QueryError('non_json_response') from None

    def catalog(self, family='iphone-duo'):
        text = self.get(BASE+'/shop/buy-iphone/'+family)
        pattern = r'\{"sku":"[^"]+","partNumber":"([^"]+)","price":\{[^}]*\},"category":"iphone","name":"([^"]+)"\}'
        products = {}
        links = re.findall(r'href="(https://www.apple.com/shop/buy-iphone/'+re.escape(family)+r'/[^"]+-unlocked)"', text)
        for sku, raw_name in re.findall(pattern, text):
            name = ' '.join(html.unescape(raw_name).split())
            prefix = 'iPhone Duo ' if family == 'iphone-duo' else 'iPhone 18 Pro Max '
            if not name.startswith(prefix): continue
            label = name[len(prefix):].lower().replace(' ', '-')
            link = next((u for u in links if u.endswith('-'+label+'-unlocked')), None)
            if not link: raise QueryError('missing_product_link')
            products[sku] = {'name':name,'url':link}
        if not products or (family == 'iphone-duo' and len(products) != 8):
            raise QueryError('unexpected_catalog')
        return products

def telegram(message):
    token, chat = os.environ.get('TELEGRAM_BOT_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID')
    if not token or not chat: raise QueryError('missing_telegram_credentials')
    data = urllib.parse.urlencode({'chat_id':chat,'text':message,'disable_web_page_preview':'true'}).encode()
    req = urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage', data=data)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            result = json.load(response)
        if not result.get('ok'): raise QueryError('telegram_rejected')
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        # Never log URLs/exceptions containing Telegram credentials.
        raise QueryError('telegram_send_failed') from None

def offer_key(offer):
    return '|'.join(offer[k] for k in ('store_id','sku','date'))

def track_stock_episodes(state, offers, observed_pairs, observed_at=None):
    """Advance only validated store/SKU observations; errors and missing pairs do nothing."""
    episodes = state.setdefault('stock_episodes', {})
    stamp = observed_at or time.time()
    accepted = set()
    for sid, sku in observed_pairs:
        pair = sid+'|'+sku
        prior = episodes.get(pair, {})
        if stamp < prior.get('observed_at', 0):
            continue  # An older concurrent response must not rewind newer stock state.
        matching = [o for o in offers if o['store_id']==sid and o['sku']==sku]
        current = {offer_key(o) for o in matching}
        ids = {key: prior.get('active', {}).get(key) or uuid.uuid4().hex for key in current}
        episodes[pair] = {'observed_at': stamp, 'active': ids}
        for offer in matching:
            offer['stock_event_id'] = ids[offer_key(offer)]
            accepted.add(id(offer))
    return [o for o in offers if id(o) in accepted]


def should_alert(offer, state, now):
    if not offer['name'].startswith('iPhone Duo '): return False
    key = offer.get('stock_event_id', offer_key(offer))
    return key not in state.get('sent_episodes', {})

def select_products(config):
    products = config['products']
    selection = config.get('selection')
    if not selection:
        return products
    if 'skus' in selection:
        skus = selection['skus']
        if (not isinstance(skus, list) or not skus or
                any(not isinstance(sku, str) or sku not in products for sku in skus) or
                len(set(skus)) != len(skus)):
            raise QueryError('invalid_product_selection')
        return {sku: products[sku] for sku in skus}
    fixed = selection['fixed_sku']
    others = [sku for sku in products if sku != fixed]
    if fixed not in products or not others:
        raise QueryError('invalid_product_selection')
    # Legacy selection mode: always include the priority variant and sample one other.
    extra = random.choice(others)
    return {sku:products[sku] for sku in (fixed,extra)}

def polling_interval(config, at=None):
    at = at or dt.datetime.now(TZ)
    peak = config.get('morning_peak',{})
    local = at.astimezone(TZ)
    minute = local.hour*60+local.minute
    def minutes(value):
        hour,minute = map(int,value.split(':'))
        return hour*60+minute
    if peak and minutes(peak['start']) <= minute < minutes(peak['end']):
        return peak['interval_seconds']
    return config['interval_seconds']

def open_product_page(url):
    if not url.startswith(BASE+'/shop/buy-iphone/iphone-duo/'):
        LOG.warning('browser open refused unexpected product URL'); return
    try:
        result=subprocess.run(['/usr/bin/open',url],capture_output=True,timeout=10)
        if result.returncode: LOG.warning('browser open failed: exit %s',result.returncode)
    except (OSError,subprocess.TimeoutExpired) as exc:
        LOG.warning('browser open failed: %s',type(exc).__name__)

def notify_offer(offer,config,state,runtime,dry_run,opened):
    now=time.time()
    # Keep a durable observation trail; raw per-SKU snapshots are overwritten later.
    event={'observed_at':dt.datetime.now(TZ).isoformat(),**offer}
    with (runtime/'availability-events.jsonl').open('a') as output:
        output.write(json.dumps(event,ensure_ascii=False)+'\n')
    # Independent durable outbox: network retries never run on the polling thread.
    # Its event ID/deduplication survives Telegram failures and process restarts.
    forward_skus=config.get('mac_forward_skus')
    if (not dry_run and offer['name'].startswith('iPhone Duo ') and
            (forward_skus is None or offer['sku'] in forward_skus)):
        try:
            from pickup_bridge import enqueue_confirmed_offer
            enqueue_confirmed_offer(event, runtime, telegram)
        except Exception:
            LOG.error('pickup bridge unavailable; stock alert continues')
    if not should_alert(offer,state,now): return
    message=('📱 iPhone Duo 可 Pickup\n'+offer['name']+'\n'+offer['state']+' · '+offer['store']+
             '\n取货日期：'+offer['date']+'（美东）\n发现时间：'+dt.datetime.now(TZ).strftime('%H:%M:%S')+
             '（美东）\n'+offer['quote']+'\n'+offer['url']+'\n请按此颜色、容量选择门店并确认库存。')
    if dry_run: LOG.info('dry-run offer %s %s %s',offer['sku'],offer['store'],offer['date']); return
    telegram(message)
    state.setdefault('sent_episodes',{})[offer.get('stock_event_id',offer_key(offer))]=now
    state.setdefault('sent',{})[offer_key(offer)]=now
    atomic_json(runtime/'state.json',state)
    LOG.info('stock alert sent: %s %s %s',offer['sku'],offer['store_id'],offer['date'])
    if config.get('auto_open_product_page') and offer['sku'] not in opened:
        opened.add(offer['sku'])
        open_product_page(offer['url'])

def environment_region():
    zipcode=os.environ.get('APPLE_PICKUP_ZIP')
    if zipcode is None: return None
    if not re.fullmatch(r'[0-9]{5}',zipcode): raise QueryError('invalid_pickup_zip')
    return {'name':'environment-zip','zip':zipcode,'dynamic':True}

def select_regions(config, state):
    override=environment_region()
    if override: return [override]
    chosen=[]
    for tier in ('primary','secondary'):
        group=[r for r in config['regions'] if r['tier']==tier]
        if not group: raise QueryError('missing_region_tier')
        key=tier+'_region_cursor'
        cursor=state.get(key,0)
        chosen.append(group[cursor % len(group)])
        state[key]=cursor+1
    return chosen

def regional_payloads(payload, products, watched, region, today):
    body=payload.get('body',{})
    rows=body.get('stores')
    if not isinstance(rows,list) or not rows: raise QueryError('invalid_regional_store_schema')
    if body.get('location') != region['zip']: raise QueryError('wrong_response_location')
    ids=[r.get('storeNumber') for r in rows]
    if None in ids or len(set(ids)) != len(ids): raise QueryError('invalid_regional_store_ids')
    if set(region.get('expected_stores',[]))-set(ids): raise QueryError('regional_store_coverage_missing')
    result={sku:{'body':{'content':[]}} for sku in products}
    for row in rows:
        sid=row['storeNumber']
        if watched is not None and sid not in watched: continue
        state=row.get('state',row.get('address',{}).get('state'))
        if region.get('dynamic'):
            if not isinstance(state,str) or not re.fullmatch(r'[A-Z]{2}',state): raise QueryError('invalid_store_state')
        elif state not in ('NJ','NY'):
            raise QueryError('wrong_store_state')
        for sku in products:
            part=row.get('partsAvailability',{}).get(sku)
            if not isinstance(part,dict): raise QueryError('missing_sku_in_regional_response')
            regular=part.get('messageTypes',{}).get('regular',{})
            enabled=regular.get('storeSelectionEnabled')
            if not isinstance(enabled,bool): raise QueryError('missing_regional_availability_flag')
            if part.get('pickupDisplay') not in ('available','unavailable'):
                raise QueryError('unknown_pickup_display')
            enabled=enabled and part['pickupDisplay']=='available'
            record={'storeId':sid,'state':state,'address':{'address':'Apple '+row['storeName']},
                    'storeSelectionEnabled':enabled,'pickupSearchQuote':part.get('pickupSearchQuote',''),
                    'storePickupQuote':regular.get('storePickupQuote','')}
            encoded=part.get('pickupEncodedUpperDateString') or regular.get('pickupEncodedUpperDateString')
            if not encoded and enabled:
                dates=[pickup_date(record[k],today) for k in ('pickupSearchQuote','storePickupQuote')]
                dates=[date for date in dates if date]
                if not dates: raise QueryError('available_without_pickup_date')
                encoded=max(dates).strftime('%Y%m%d')
            if encoded: record['pickupEncodedUpperDateString']=encoded
            result[sku]['body']['content'].append(record)
    return result

def run_cycle(client, config, state, runtime, dry_run=False):
    now = time.time()
    today = dt.datetime.now(TZ).date()
    products = select_products(config)
    state['selected_skus'] = list(products)
    LOG.info('cycle selected: %s', ', '.join(p['name'] for p in products.values()))
    all_offers = {}
    errors = []
    coverage = {}
    opened = set()
    if config.get('regions') or os.environ.get('APPLE_PICKUP_ZIP') is not None:
        regions=select_regions(config,state)
        batches=[(region['zip'],products,region) for region in regions]
        state['regions_checked']=[r['zip'] for r in regions]
        state['endpoint']='/shop/retail/pickup-message'
    else:
        batches=[(sku,{sku:product},None) for sku,product in products.items()]
    records_by_sku={sku:{} for sku in products}
    history=state.setdefault('coverage_history',{})
    for index,(batch_id,batch_products,region) in enumerate(batches):
        if index: time.sleep(config['request_gap_seconds'])
        try:
            if region:
                raw=client.inventory_region(batch_products,region['zip'])
                atomic_json(runtime/('region-'+region['zip']+'.json'),raw)
                watched=None if region.get('dynamic') else config['stores']
                payloads=regional_payloads(raw,batch_products,watched,region,today)
            else:
                sku=next(iter(batch_products))
                payloads={sku:client.inventory(sku,config['stores'])}
            for sku,payload in payloads.items():
                requested_stores=None if region and region.get('dynamic') else config['stores']
                allowed_states=None if region and region.get('dynamic') else ('NJ','NY')
                offers,observed=parse_inventory(payload,{sku:products[sku]},today,config['max_pickup_days'],requested_stores,allowed_states)
                if region:
                    for offer in offers: offer['pickup_zip']=region['zip']
                checked=time.time()
                for record in payload['body']['content']:
                    sid=record['storeId'];records_by_sku[sku][sid]=record
                    history.setdefault(sku,{})[sid]={'checked_at':checked,'quote':record.get('pickupSearchQuote'),
                        'pickup_enabled':record['storeSelectionEnabled'],'pickup_date':record.get('pickupEncodedUpperDateString')}
                records=list(records_by_sku[sku].values());returned=set(records_by_sku[sku])
                atomic_json(runtime/('pickup-'+sku.split('/')[0]+'.json'),{'body':{'content':records}})
                coverage[sku]={'checked_at':checked,'observations':len(returned),'returned_stores':sorted(returned),
                               'unreported_stores':sorted(set(config['stores'])-returned),
                               'states':sorted({r['state'] for r in records})}
                offers=track_stock_episodes(state,offers,[(r['storeId'],sku) for r in payload['body']['content']])
                for offer in offers:
                    all_offers[offer_key(offer)]=offer
                    notify_offer(offer,config,state,runtime,dry_run,opened)
            if region:
                observed_ids={r['storeNumber'] for r in raw['body']['stores']}
                if not region.get('dynamic'): observed_ids &= set(config['stores'])
                state.setdefault('coverage_by_region',{})[region['zip']]={
                    'checked_at':time.time(),'skus':list(batch_products),
                    'returned_stores':sorted(observed_ids)}
        except QueryError as exc:
            # Notification failures are retried by the outer handler; do not mark as sold out.
            if exc.code.startswith('telegram_'): raise
            errors.append(exc)
            break
    state['fresh_coverage_counts']={sku:sum(time.time()-entry['checked_at'] <= 600 for entry in stores.values())
                                   for sku,stores in history.items()}
    state['coverage'] = coverage
    pending = sorted(all_offers.values(),key=lambda x:(x['date'],x['state'] != 'NJ',x['store']))
    state['last_cycle_at'] = now
    state['eligible_offers'] = len(pending)
    state['status'] = 'degraded' if errors else 'healthy'
    if errors:
        state['failures'] = state.get('failures',0)+1
        delay = min(3600, 300 * 2**min(state['failures']-1,4))
        delay = max(delay, max(e.retry_after for e in errors))
        LOG.warning('query failed: %s; next check in %ss',errors[0].code,delay)
    else:
        delay = polling_interval(config)
        state['failures'] = 0
        state['last_success_at'] = now
        LOG.info('cycle healthy; %s eligible offers',len(pending))
    state['sent'] = {k:v for k,v in state.get('sent',{}).items() if now-v < 86400*7}
    state['next_check_at'] = time.time()+max(1,delay-(time.time()-now))
    atomic_json(runtime/'state.json',state)
    return max(1,delay-(time.time()-now))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default=str(ROOT/'config.json'))
    parser.add_argument('--env-file', default='/Users/codex/.codex/secrets/market-radar.env')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--discover', action='store_true')
    parser.add_argument('--smoke-test', action='store_true')
    parser.add_argument('--notify-test', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    runtime = ROOT/'runtime'; runtime.mkdir(exist_ok=True)
    handler = RotatingFileHandler(runtime/'monitor.log',maxBytes=2_000_000,backupCount=3)
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    LOG.addHandler(handler)
    if Path(args.env_file).exists(): load_env(args.env_file)
    client = Client()
    if args.discover:
        atomic_json(ROOT/'catalog.json',client.catalog()); return 0
    if args.notify_test:
        telegram('🧪 iPhone Duo 监控 Telegram 通道测试成功。这是测试消息，不是有货提醒。'); return 0
    config = json.loads(Path(args.config).read_text())
    if config['interval_seconds'] < 60 or config['request_gap_seconds'] < 3:
        parser.error('minimum regular interval 60s, request gap 3s')
    peak=config.get('morning_peak',{})
    if peak and peak.get('interval_seconds',0) < 20:
        parser.error('minimum peak interval 20s')
    if args.smoke_test:
        # Diagnostics never call Telegram and never enter production alert state.
        override=environment_region()
        if config.get('regions') or override:
            result={};covered=set();products=select_products(config)
            for index,region in enumerate([override] if override else config['regions']):
                if index: time.sleep(10)
                try:
                    raw=client.inventory_region(products,region['zip'])
                    watched=None if region.get('dynamic') else config['stores']
                    payloads=regional_payloads(raw,products,watched,region,dt.datetime.now(TZ).date())
                    observed=set()
                    for sku,payload in payloads.items():
                        parse_inventory(payload,{sku:products[sku]},dt.datetime.now(TZ).date(),requested_stores=watched,allowed_states=None if region.get('dynamic') else ('NJ','NY'))
                        observed.update(row['storeId'] for row in payload['body']['content'])
                    covered.update(observed)
                    result[region['zip']]={'ok':True,'stores':sorted(observed)}
                except QueryError as exc:
                    result[region['zip']]={'ok':False,'error':exc.code};break
            expected=covered if override else set(config['stores'])
            result['coverage']={'ok':bool(covered) and covered>=expected,'count':len(covered),'missing':sorted(expected-covered)}
            atomic_json(runtime/'smoke-result.json',result)
            print(json.dumps(result,indent=2));return int(not all(v['ok'] for v in result.values()))
        result = {}
        for family in ['iphone-18-pro','iphone-duo']:
            catalog = client.catalog(family)
            test_sku = 'MJW54LL/A' if family == 'iphone-18-pro' else next(iter(catalog))
            products = {test_sku:catalog[test_sku]}
            sku, product = next(iter(products.items()))
            try:
                payload = client.inventory(sku,config['stores'])
                atomic_json(runtime/('smoke-'+family+'.json'),payload)
                offers, observations = parse_inventory(payload,products,dt.datetime.now(TZ).date(),requested_stores=config['stores'])
                records = payload['body']['content']
                for region in ['NJ','NY']:
                    regional = [r for r in records if r['state']==region]
                    result[family+'-'+region] = {'ok':bool(regional),'observations':len(regional),'eligible':len([o for o in offers if o['state']==region]),'quotes':sorted({r['pickupSearchQuote'] for r in regional})}
            except QueryError as exc:
                result[family] = {'ok':False,'error':exc.code}
            time.sleep(5)
        atomic_json(runtime/'smoke-result.json',result)
        print(json.dumps(result,indent=2)); return int(not all(v['ok'] for v in result.values()))
    lock = (runtime/'monitor.lock').open('w')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: LOG.error('monitor already running'); return 2
    state_path = runtime/'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if not args.once:
        # Preserve backoff across supervised restarts.
        time.sleep(max(0,state.get('next_check_at',0)-time.time()))
    while True:
        try:
            delay = run_cycle(client,config,state,runtime,args.dry_run)
        except Exception as exc:
            error = exc.code if isinstance(exc,QueryError) else type(exc).__name__
            LOG.error('cycle or notification failure: %s',error)
            state['status']='degraded'; state['last_error']=error
            delay=300
            state['next_check_at']=time.time()+delay
            atomic_json(state_path,state)
        if args.once: return 0 if state.get('status') == 'healthy' else 1
        jitter = 2 if polling_interval(config) < 60 else 10
        time.sleep(delay+random.uniform(0,jitter))

if __name__ == '__main__':
    raise SystemExit(main())
