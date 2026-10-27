#!/usr/bin/env python3
"""Bounded proxy polling, with shared-exit cooldowns and stock-only Telegram alerts."""
import argparse
import collections
import concurrent.futures
from contextlib import contextmanager
import datetime as dt
import fcntl
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

import monitor as m
from proxy_smoke import connectivity_probe

EXPECTED_07094 = ['R755', 'R250', 'R251', 'R095', 'R415', 'R032',
                  'R582', 'R654', 'R594', 'R715', 'R117', 'R612']
DEFAULT_CONFIG = Path.home() / 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml'
DEFAULT_BINARY = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'


def yaml_data(path):
    result = subprocess.run(['ruby', '-ryaml', '-rjson', '-e',
                             'puts JSON.generate(YAML.load_file(ARGV[0]))', str(path)],
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def subscription_paths(config_path, all_subscriptions=False):
    if not all_subscriptions:
        return [Path(config_path)]
    base = Path(config_path).parent
    profiles = yaml_data(base / 'profiles.yaml')
    paths = [base / 'profiles' / item['file'] for item in profiles.get('items', [])
             if item.get('type') == 'remote' and item.get('file')]
    if not paths:
        raise RuntimeError('No remote subscription profiles found')
    return paths


def subscription_nodes(paths):
    """Read locally cached subscriptions; never fetch or log subscription URLs."""
    nodes = []
    for path in paths:
        source = yaml_data(path)
        if source.get('proxy-providers'):
            raise RuntimeError('Provider-only subscriptions need explicit materialization')
        for original in source.get('proxies', []):
            name = original.get('name', '')
            if not original.get('type') or any(word in name.lower() for word in
                    ('剩余流量', '套餐到期', '流量重置', 'expire', 'traffic remaining')):
                continue
            node = dict(original)
            node['name'] = Path(path).stem + '::' + name
            nodes.append(node)
    return nodes


class TimedClient(m.Client):
    def __init__(self, port, timeout=10):
        super().__init__()
        self.timeout = timeout
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({'http': f'http://127.0.0.1:{port}', 'https': f'http://127.0.0.1:{port}'}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.opener.addheaders = m.Client().opener.addheaders

    def get(self, url):
        # Retain the monitor's checked HTTP/error parsing while capping network time.
        opener = self.opener

        class WithTimeout:
            def open(inner, request, timeout=25):
                return opener.open(request, timeout=self.timeout)

        self.opener = WithTimeout()
        try:
            return super().get(url)
        finally:
            self.opener = opener


def node_priority(name):
    name = name.split('::', 1)[-1]
    return 0 if name.startswith('🇺🇸') else 1 if name.startswith('🇬🇧') else 2


@contextmanager
def private_proxy(config_path, binary, output, limit, selected_names=None):
    paths = config_path if isinstance(config_path, list) else [config_path]
    proxies = subscription_nodes(paths)
    if selected_names is not None:
        proxies = [p for p in proxies if p['name'] in selected_names]
    proxies.sort(key=lambda p: node_priority(p['name']))
    proxies = proxies[:limit]
    if not proxies:
        raise RuntimeError('No actual subscription nodes found')
    with tempfile.TemporaryDirectory(prefix='iphone-polling-') as private:
        reserved = []
        try:
            for _ in proxies:
                sock = socket.socket()
                reserved.append(sock)
                sock.bind(('127.0.0.1', 0))
            ports = [sock.getsockname()[1] for sock in reserved]
        finally:
            for sock in reserved:
                sock.close()
        config = {'mode': 'rule', 'log-level': 'info', 'allow-lan': False,
                  'proxies': proxies, 'rules': ['MATCH,REJECT'],
                  'profile': {'store-selected': False},
                  'listeners': [{'name': f'poll-{i}', 'type': 'http', 'listen': '127.0.0.1',
                                 'port': port, 'proxy': proxy['name']}
                                for i, (port, proxy) in enumerate(zip(ports, proxies))]}
        path = Path(private) / 'config.json'
        path.write_text(json.dumps(config, ensure_ascii=False))
        path.chmod(0o600)
        with (output / 'mihomo.log').open('w') as log:
            process = subprocess.Popen([binary, '-d', private, '-f', str(path)], stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        for port in ports:
                            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                                pass
                        break
                    except OSError:
                        if process.poll() is not None or time.monotonic() > deadline:
                            raise RuntimeError('Private proxy failed to start')
                        time.sleep(.1)
                yield [{'node': proxy['name'], 'port': port, 'client': TimedClient(port)}
                       for proxy, port in zip(proxies, ports)]
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def discover_pool(candidates, output):
    """One non-Apple IPv4 probe per node; inventory requests remain sequential."""
    measured = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(connectivity_probe, row['client'].opener,
                                   ['https://api4.ipify.org?format=json']): row for row in candidates}
        for future in concurrent.futures.as_completed(futures):
            row = futures[future]
            probe = future.result()[0]
            public = {'node': row['node'], 'port': row['port'], **probe}
            measured.append(public)
            if probe.get('ip') and probe.get('status') == 200:
                row.update(ip=probe['ip'], probe_seconds=probe['seconds'])
    m.atomic_json(output / 'exit-scan.json', measured)
    # One representative per measured exit, rather than treating names as distinct IPs.
    pool, seen = [], set()
    for row in sorted((r for r in candidates if r.get('ip')),
                      key=lambda r: (node_priority(r['node']), r['probe_seconds'])):
        if row['ip'] in seen:
            continue
        seen.add(row['ip'])
        pool.append(row)
    if not pool:
        raise RuntimeError('No measured proxy exits; no inventory queries performed')
    return pool


def next_ready(pool, state, now, minimum_interval):
    return min(pool, key=lambda row: ready_at(row['ip'], state, minimum_interval))


def ready_at(ip, state, minimum_interval):
    record = state.setdefault('exits', {}).get(ip, {})
    return max(record.get('blocked_until', 0), record.get('last_started_at', 0) + minimum_interval,
               state.get('global_blocked_until', 0))


def record_result(state, ip, now, error=None, cooldown=300):
    record = state.setdefault('exits', {}).setdefault(ip, {})
    if error is None:
        record['consecutive_errors'] = 0
        record['last_success_at'] = now
        record['blocked_until'] = 0
        return
    failures = record.get('consecutive_errors', 0) + 1
    record['consecutive_errors'] = failures
    record['last_error'] = error.code
    # Every query error cools the exit. Blocking responses use 5m, 10m, then 20m...
    base = cooldown if error.code in ('http_403', 'http_429', 'http_541') else 60
    delay = max(error.retry_after, min(3600, base * 2 ** min(failures - 1, 4)))
    record['blocked_until'] = now + delay
    if error.code == 'http_429' or error.retry_after:
        state['global_blocked_until'] = max(state.get('global_blocked_until', 0), now + delay)


def parse_offers(raw, products, config, zipcode):
    override = m.environment_region()
    dynamic = override is not None and override['zip'] == zipcode
    region = override if dynamic else {'zip': zipcode, 'expected_stores': EXPECTED_07094 if zipcode == '07094' else []}
    watched = None if dynamic else config['stores']
    today = dt.datetime.now(m.TZ).date()
    payloads = m.regional_payloads(raw, products, watched, region, today)
    offers = []
    for sku, payload in payloads.items():
        found, _ = m.parse_inventory(payload, {sku: products[sku]}, today,
                                    config['max_pickup_days'], watched,
                                    allowed_states=None if dynamic else ('NJ', 'NY'))
        for offer in found:
            offer['pickup_zip'] = zipcode
        offers.extend(found)
    return offers


class RecoveryPacer:
    """One coalesced failover credit, with a durable rolling-minute budget."""
    def __init__(self, state, limit=12):
        self.state, self.limit, self.pending = state, limit, None
        state.setdefault('recovery_starts', [])

    def failed(self, error, ip):
        if error.code == 'http_429' or error.retry_after:
            self.pending = None
        elif error.code in ('http_541', 'http_403', 'network_error'):
            self.pending = {'result': error.code, 'ip': ip}

    def available(self, now):
        starts = [t for t in self.state.get('recovery_starts', []) if t > now-60]
        self.state['recovery_starts'] = starts
        return bool(self.pending) and len(starts) < self.limit

    def dispatched(self, now, early):
        cause = self.pending if early else None
        if early:
            self.state['recovery_starts'].append(now)
        self.pending = None
        return cause


def ready_recovery_exit(pool, state, now, minimum_interval):
    """Prefer recently successful exits, without bypassing any IP/global wait."""
    ready = [row for row in pool if ready_at(row['ip'], state, minimum_interval) <= now]
    def rank(row):
        record = state['exits'].get(row['ip'], {})
        return (bool(record.get('consecutive_errors', 0)),
                -record.get('last_success_at', 0), row.get('probe_seconds', float('inf')))
    return min(ready, key=rank) if ready else None


def run(args):
    runtime = m.ROOT / 'runtime' / 'proxy-monitor'
    runtime.mkdir(parents=True, exist_ok=True)
    lock = (runtime / 'monitor.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('Proxy monitor is already running') from None
    stop = False

    def stop_requested(signum, frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, stop_requested)
    signal.signal(signal.SIGINT, stop_requested)
    os.environ['no_proxy'] = os.environ['NO_PROXY'] = ''
    # Keep Telegram independent of the rotating inventory exits.
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
    if args.env_file.exists():
        m.load_env(args.env_file)
    override = m.environment_region()
    if override:
        args.zip = override['zip']
    config = json.loads((m.ROOT / 'config.json').read_text())
    config['auto_open_product_page'] = False
    selected = m.select_products(config)
    state_path = runtime / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    state.setdefault('sent', {})
    recovery = RecoveryPacer(state, getattr(args, 'max_recovery_per_minute', 12))
    output = runtime / dt.datetime.now(m.TZ).strftime('%Y%m%d-%H%M%S')
    output.mkdir()
    report = {'pid': os.getpid(), 'preparation_at': dt.datetime.now(m.TZ).isoformat(),
              'duration_seconds': args.duration, 'target_start_spacing': args.spacing,
              'minimum_ip_interval': args.min_ip_interval, 'requested_max_nodes': args.max_nodes,
              'max_recovery_per_minute': recovery.limit, 'recovery_min_start_spacing': .2,
              'recovery_queries': 0,
              'zip': args.zip, 'counts': {}, 'alerts_sent': 0, 'notification_errors': 0,
              'monitored_skus': list(selected),
              'monitored_products': [item['name'] for item in selected.values()],
              'telegram_configured': bool(os.environ.get('TELEGRAM_BOT_TOKEN') and os.environ.get('TELEGRAM_CHAT_ID')),
              'status': 'preparing', 'output': str(output)}

    def save():
        m.atomic_json(state_path, state)
        m.atomic_json(output / 'report.json', report)
        m.atomic_json(runtime / 'current.json', report)

    save()
    started = None
    try:
        paths = subscription_paths(args.clash_config, getattr(args, 'all_subscriptions', False))
        report['subscription_sources'] = [path.stem for path in paths]
        report['workers'] = getattr(args, 'workers', 1)
        with private_proxy(paths, args.mihomo, output, args.max_nodes) as candidates:
            report['actual_nodes'] = len(candidates)
            pool = discover_pool(candidates, output)
            report['unique_exits'] = len(pool)
            report['pool'] = [{k: r[k] for k in ('node', 'ip', 'probe_seconds')} for r in pool]
            started = time.monotonic()
            deadline = started + args.duration if args.duration else float('inf')
            report.update(started_at=dt.datetime.now(m.TZ).isoformat(), status='running')
            next_start = started
            last_start = float('-inf')
            counts = collections.Counter()
            save()
            # Workers only perform network I/O. The main thread owns all mutable
            # state, cooldowns, notification deduplication, and request admission.
            pending = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=report['workers']) as executor, \
                    (output / 'queries.jsonl').open('a', buffering=1) as events:
                while pending or (not stop and time.monotonic() < deadline):
                    for future in [f for f in pending if f.done()]:
                        row, event, products, request_start = pending.pop(future)
                        record = state['exits'][row['ip']]
                        try:
                            raw = future.result()
                            offers = parse_offers(raw, products, config, args.zip)
                            m.atomic_json(output / 'last-inventory.json', raw)
                            record_result(state, row['ip'], time.time())
                            event.update(result='http_200', stores=len(raw['body']['stores']), eligible_offers=len(offers))
                            report['last_success_at'] = dt.datetime.now(m.TZ).isoformat()
                            for offer in offers:
                                if time.monotonic() >= deadline or stop:
                                    continue
                                should_send = m.should_alert(offer, state, time.time())
                                try:
                                    m.notify_offer(offer, config, state, runtime, False, set())
                                    if should_send:
                                        report['alerts_sent'] += 1
                                except m.QueryError:
                                    report['notification_errors'] += 1
                        except m.QueryError as exc:
                            event.update(result=exc.code, retry_after=exc.retry_after)
                            record_result(state, row['ip'], time.time(), exc, args.cooldown)
                            recovery.failed(exc, row['ip'])
                        event['completed_at'] = dt.datetime.now(m.TZ).isoformat()
                        event['elapsed_seconds'] = round(time.monotonic() - request_start, 3)
                        event['blocked_until'] = record.get('blocked_until', 0)
                        counts[event['result']] += 1
                        report['counts'] = dict(counts)
                        report['queries'] = sum(counts.values())
                        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
                        report['last_query_at'] = event['completed_at']
                        events.write(json.dumps(event, ensure_ascii=False) + '\n')
                        save()
                    if stop or time.monotonic() >= deadline:
                        if pending:
                            time.sleep(.02)
                        continue
                    active_ips = {entry[0]['ip'] for entry in pending.values()}
                    eligible = [row for row in pool if row['ip'] not in active_ips]
                    if len(pending) >= report['workers'] or not eligible:
                        time.sleep(.02)
                        continue
                    now = time.time()
                    monotonic_now = time.monotonic()
                    row = None
                    # A failure can advance the next scheduled start; it never
                    # creates parallel work on the failed IP or bypasses Retry-After.
                    if monotonic_now < next_start and recovery.available(now):
                        row = ready_recovery_exit(eligible, state, now, args.min_ip_interval)
                    early = row is not None
                    if row is None:
                        row = next_ready(eligible, state, now, args.min_ip_interval)
                    # Recovery is extra work, not a replacement that postpones
                    # the ordinary two-second cadence after every error.
                    due = max(last_start + min(.2, args.spacing),
                              min(next_start, last_start + .2) if early else next_start)
                    wait = max(0, ready_at(row['ip'], state, args.min_ip_interval) - now,
                               due - time.monotonic())
                    if wait:
                        time.sleep(min(wait, .1, max(0, deadline - time.monotonic())))
                        continue
                    request_start = time.monotonic()
                    wall_start = time.time()
                    early = early and request_start < next_start
                    cause = recovery.dispatched(wall_start, early)
                    state.setdefault('exits', {}).setdefault(row['ip'], {})['last_started_at'] = wall_start
                    last_start = request_start
                    if not early:
                        next_start = request_start + args.spacing
                    products = m.select_products(config)
                    event = {'at': dt.datetime.now(m.TZ).isoformat(), 'node': row['node'], 'ip': row['ip'],
                             'start_seconds': round(request_start - started, 3), 'skus': list(products),
                             'dispatch_reason': 'failure_recovery' if early else 'scheduled'}
                    if cause:
                        event['recovery_from'] = cause
                        report['recovery_queries'] += 1
                    save()
                    row['client'].timeout = min(10, max(.1, deadline - time.monotonic()))
                    future = executor.submit(row['client'].inventory_region, products, args.zip)
                    pending[future] = (row, event, products, request_start)
            report['status'] = 'stopped_by_signal' if stop else 'completed'
    except Exception as exc:
        report.update(status='failed', software_error=type(exc).__name__)
        # Never print arbitrary exceptions that might contain proxy or bot credentials.
        raise
    finally:
        report['finished_at'] = dt.datetime.now(m.TZ).isoformat()
        if started is not None:
            report['elapsed_seconds'] = round(time.monotonic() - started, 3)
        save()
        print(json.dumps(report, ensure_ascii=False), flush=True)
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--duration', type=int, default=600, help='Polling duration; zero runs until stopped')
    parser.add_argument('--max-nodes', type=int, default=256)
    parser.add_argument('--workers', type=int, default=1, help='Bounded in-flight requests; starts still obey spacing')
    parser.add_argument('--all-subscriptions', action='store_true', help='Merge all locally cached remote profiles')
    parser.add_argument('--spacing', type=float, default=2)
    parser.add_argument('--max-recovery-per-minute', type=int, default=12,
                        help='Additional early starts after 541/403/network errors; 0 disables')
    parser.add_argument('--min-ip-interval', type=float, default=60)
    parser.add_argument('--cooldown', type=float, default=300)
    parser.add_argument('--zip', default='07094')
    parser.add_argument('--env-file', type=Path, default=m.ROOT / '.env')
    parser.add_argument('--clash-config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--mihomo', default=DEFAULT_BINARY)
    args = parser.parse_args()
    if args.duration < 0 or not 1 <= args.max_nodes <= 256 or not 1 <= args.workers <= 8 or args.spacing < 2 or args.min_ip_interval < 60 or args.cooldown < 300 or not 0 <= args.max_recovery_per_minute <= 12:
        parser.error('Require duration >=0, nodes 1–256, workers 1–8, spacing >=2s, per-IP interval >=60s, cooldown >=300s, recovery budget 0–12/min')
    try:
        run(args)
    except Exception as exc:
        print('Proxy monitor stopped: ' + type(exc).__name__, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
