"""Opt-in, asynchronous, durable LAN delivery of confirmed stock events."""
import datetime as dt
import hashlib
import ipaddress
import json
import logging
import os
from pathlib import Path
import queue
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager

LOG = logging.getLogger('pickup.bridge')


def valid_product_url(value):
    try:
        u = urllib.parse.urlsplit(value)
        return (u.scheme == 'https' and u.netloc == 'www.apple.com' and
                u.path.startswith('/shop/buy-iphone/') and len(u.path.split('/')) >= 5 and
                not u.query and not u.fragment and '%' not in u.path and '\\' not in value)
    except (ValueError, TypeError):
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class Bridge:
    def __init__(self, config, secret, runtime, notify, autostart=True):
        u = urllib.parse.urlsplit(config['endpoint'])
        host = ipaddress.ip_address(u.hostname)
        lan = any(host in ipaddress.ip_network(cidr) for cidr in ('127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')) if host.version == 4 else False
        if (u.scheme not in ('http', 'https') or not lan or
                host.is_unspecified or u.username or u.password or u.query or u.fragment or u.path != '/prepare'):
            raise ValueError('invalid_bridge_endpoint')
        if len(secret) < 32:
            raise ValueError('bridge_secret_too_short')
        self.config, self.secret, self.notify = config, secret, notify
        self.timeout = min(5, max(.1, float(config.get('timeout_seconds', 1))))
        self.max_attempts = min(5, max(1, int(config.get('max_attempts', 3))))
        self.retry_delays = config.get('retry_delays_seconds', [.5, 1])
        if not self.retry_delays or any(not isinstance(x, (int, float)) or not 0 <= x <= 10 for x in self.retry_delays):
            raise ValueError('invalid_bridge_retry_delays')
        self.root = Path(runtime) / 'pickup-bridge'
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.db = self.root / 'outbox.sqlite3'
        with self.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, dedup TEXT, created REAL, payload TEXT, phase TEXT, attempts INTEGER, due REAL, deadline REAL, result TEXT)')
            c.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value REAL)')
        self.db.chmod(0o600)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.incoming = queue.Queue(maxsize=128)
        self.stop = threading.Event()
        if autostart:
            threading.Thread(target=self.run, name='pickup-lan-outbox', daemon=True).start()

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.db, timeout=.2)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def log(self, event_id, **data):
        row = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'event_id': event_id, **data}
        with (self.root / 'delivery.jsonl').open('a') as f:
            f.write(json.dumps(row) + '\n')

    def submit(self, offer):
        if not valid_product_url(offer.get('url')):
            return False
        try:
            self.incoming.put_nowait(dict(offer))
            return True
        except queue.Full:
            LOG.error('bridge_queue_full')
            return False

    def persist(self, offer, now):
        dedup = hashlib.sha256('|'.join(str(offer.get(k, '')) for k in ('store_id', 'sku', 'date')).encode()).hexdigest()
        with self.connect() as c:
            prior = c.execute('SELECT id FROM events WHERE dedup=? AND created>? ORDER BY created DESC LIMIT 1', (dedup, now-1800)).fetchone()
            if prior:
                return prior[0]
            event_id = uuid.uuid4().hex
            payload = {'event_id': event_id, 'detected_at': offer['observed_at'], 'product_url': offer['url'],
                       'store_id': offer.get('store_id'), 'store_name': offer.get('store')}
            c.execute('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)',
                      (event_id, dedup, now, json.dumps(payload), 'pending', 0, now, now+180, ''))
        self.log(event_id, phase='queued', detected_at=payload['detected_at'])
        return event_id

    def warning(self, event_id, code, now):
        with self.connect() as c:
            last = c.execute("SELECT value FROM meta WHERE key='last_notice'").fetchone()
            if last and now-last[0] < 600:
                return
            c.execute("INSERT OR REPLACE INTO meta VALUES ('last_notice',?)", (now,))
        try:
            self.notify('⚠️ 到货浏览器自动准备未完成：'+code+'。请查看 Mac 或手动打开商品链接。事件 '+event_id)
        except Exception:
            LOG.warning('bridge_telegram_notice_failed')

    def request(self, method, event_id, payload=None):
        url = self.config['endpoint'] if method == 'POST' else self.config['endpoint'].removesuffix('/prepare')+'/status/'+event_id
        request = urllib.request.Request(url, data=json.dumps(payload).encode() if payload else None,
                headers={'Authorization': 'Bearer '+self.secret, 'Content-Type': 'application/json'}, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return response.status, json.loads(response.read(32768))
        except urllib.error.HTTPError as exc:
            try:
                result = json.loads(exc.read(32768))
            except (ValueError, OSError):
                result = {}
            return exc.code, result

    def tick(self, now=None):
        now = time.time() if now is None else now
        # Bound work per tick so queued events do not starve due retries/status checks.
        for _ in range(32):
            try:
                self.persist(self.incoming.get_nowait(), now)
            except queue.Empty:
                break
        with self.connect() as c:
            row = c.execute("SELECT id,payload,phase,attempts,deadline FROM events WHERE phase IN ('pending','watching') AND due<=? ORDER BY due LIMIT 1", (now,)).fetchone()
        if not row:
            return
        event_id, body, phase, attempts, deadline = row
        if phase == 'pending' and now > deadline:
            with self.connect() as c:
                c.execute("UPDATE events SET phase='failed',result='expired_before_delivery' WHERE id=?", (event_id,))
            self.log(event_id, phase='expired_before_delivery')
            self.warning(event_id, '过期事件未自动操作', now)
            return
        method = 'POST' if phase == 'pending' else 'GET'
        self.log(event_id, phase='sending' if phase == 'pending' else 'status_check', method=method)
        try:
            code, reply = self.request(method, event_id, json.loads(body) if phase == 'pending' else None)
            status = reply.get('status', 'invalid_response')
            if reply.get('event_id') != event_id:
                raise ValueError('invalid_receiver_event')
            accepted = code in (200, 202) and status != 'invalid_response'
            if not accepted and not (code == 409 and status == 'busy'):
                raise ValueError('receiver_rejected')
        except Exception:
            attempts += 1
            exhausted = (phase == 'pending' and attempts >= self.max_attempts) or (phase == 'watching' and now >= deadline)
            delay = self.retry_delays[min(attempts-1, len(self.retry_delays)-1)] if phase == 'pending' else 5
            with self.connect() as c:
                c.execute('UPDATE events SET phase=?,attempts=?,due=?,result=? WHERE id=?',
                          ('failed' if exhausted else phase, attempts, now+delay, 'delivery_failed', event_id))
            self.log(event_id, phase='failed' if exhausted else 'retry_scheduled', attempt=attempts)
            if exhausted:
                self.warning(event_id, 'Mac 不在线、未就绪或接收失败', now)
            return
        running = status in ('queued', 'running')
        new_phase = 'watching' if running and now < deadline else 'done'
        outcome = 'receiver_timeout' if running and now >= deadline else status
        with self.connect() as c:
            c.execute('UPDATE events SET phase=?,attempts=0,due=?,result=? WHERE id=?', (new_phase, now+5, outcome, event_id))
        # Only stage timestamps and status are retained, never arbitrary response/error text.
        timestamps = {k:v for k,v in reply.get('timestamps', {}).items() if k in
                      ('received_at','opened_at','bag_ready_at','apple_pay_at','handoff_at','finished_at') and isinstance(v,str)}
        self.log(event_id, phase='received', receiver_status=outcome, timestamps=timestamps)
        if outcome in ('busy','manual_review','pickup_unavailable','interrupted','receiver_timeout','browser_not_ready'):
            self.warning(event_id, outcome, now)

    def run(self):
        while not self.stop.is_set():
            try:
                self.tick()
            except Exception:
                LOG.error('bridge_worker_error')
            self.stop.wait(.1)


_instances = {}
_guard = threading.Lock()


def enqueue_confirmed_offer(offer, runtime, notify):
    """Opt in via PICKUP_MAC_CONFIG; no network or disk I/O on the hot path after setup."""
    path = os.environ.get('PICKUP_MAC_CONFIG')
    if not path:
        return False
    try:
        with _guard:
            key = (str(runtime), path)
            if key not in _instances:
                config = json.loads(Path(path).read_text())
                _instances[key] = Bridge(config, os.environ.get(config.get('secret_env', 'PICKUP_SHARED_SECRET'), ''), runtime, notify) if config.get('enabled') else None
            bridge = _instances[key]
        return bridge.submit(offer) if bridge else False
    except Exception:
        LOG.error('bridge_configuration_error')
        return False
