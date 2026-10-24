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

def parse_inventory(payload, products, today, max_days=3, requested_stores=None):
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
        if state not in ('NJ', 'NY'): continue
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
    if not observed: raise QueryError('no_nj_ny_observations')
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

def should_alert(offer, state, now):
    # Model guard is independent of catalog discovery, including in test mode.
    if not offer['name'].startswith('iPhone Duo '): return False
    return now - state.get('sent', {}).get(offer_key(offer), 0) >= 1800

def select_products(config):
    products = config['products']
    selection = config.get('selection')
    if not selection:
        return products
    fixed = selection['fixed_sku']
    others = [sku for sku in products if sku != fixed]
    if fixed not in products or not others:
        raise QueryError('invalid_product_selection')
    # Keep the priority variant first; the second request samples the other variants.
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
    if not should_alert(offer,state,now): return
    message=('📱 iPhone Duo 可 Pickup\n'+offer['name']+'\n'+offer['state']+' · '+offer['store']+
             '\n取货日期：'+offer['date']+'（美东）\n发现时间：'+dt.datetime.now(TZ).strftime('%H:%M:%S')+
             '（美东）\n'+offer['quote']+'\n'+offer['url']+'\n请按此颜色、容量选择门店并确认库存。')
    if dry_run: LOG.info('dry-run offer %s %s %s',offer['sku'],offer['store'],offer['date']); return
    telegram(message)
    state.setdefault('sent',{})[offer_key(offer)]=now
    atomic_json(runtime/'state.json',state)
    LOG.info('stock alert sent: %s %s %s',offer['sku'],offer['store_id'],offer['date'])
    if config.get('auto_open_product_page') and offer['sku'] not in opened:
        opened.add(offer['sku'])
        open_product_page(offer['url'])

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
    for index, (sku, product) in enumerate(products.items()):
        if index: time.sleep(config['request_gap_seconds'])
        try:
            payload = client.inventory(sku,config['stores'])
            atomic_json(runtime/('pickup-'+sku.split('/')[0]+'.json'),payload)
            offers, observed = parse_inventory(payload,{sku:product},today,config['max_pickup_days'],config['stores'])
            records = payload['body']['content']
            returned = {item['storeId'] for item in records}
            coverage[sku] = {'checked_at':time.time(),'observations':observed,
                             'returned_stores':sorted(returned),
                             'unreported_stores':sorted(set(config['stores'])-returned),
                             'states':sorted({item['state'] for item in records})}
            for offer in offers: all_offers[offer_key(offer)] = offer
        except QueryError as exc:
            errors.append(exc)
            break
        # Notify immediately after each successful SKU query, before the next request.
        for offer in offers:
            notify_offer(offer,config,state,runtime,dry_run,opened)
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
