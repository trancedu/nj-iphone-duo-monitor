#!/usr/bin/env python3
"""Authenticated LAN smoke-test client. Never prints the shared secret."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sys
import urllib.request
import urllib.error
import uuid
from monitor import load_env
from pickup_bridge import NoRedirect, valid_product_url


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['health', 'make-event', 'prepare', 'status', 'reset'])
    p.add_argument('--config', type=Path, default=Path('pickup_bridge.local.json'))
    p.add_argument('--env-file', type=Path)
    p.add_argument('--endpoint', help='Override base URL, e.g. http://127.0.0.1:8765')
    p.add_argument('--event', type=Path, help='Event JSON; reuse this exact file for duplicate tests')
    p.add_argument('--event-id')
    p.add_argument('--url')
    p.add_argument('--allow-live', action='store_true')
    p.add_argument('--confirm-reset', action='store_true')
    a = p.parse_args()
    if a.action == 'make-event':
        if not a.event or not valid_product_url(a.url): p.error('supply --event and a valid --url')
        value = {'event_id': a.event_id or uuid.uuid4().hex, 'detected_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'product_url': a.url}
        with a.event.open('x') as f: json.dump(value, f, indent=2)
        a.event.chmod(0o600)
        print(json.dumps({'event_id': value['event_id'], 'status': 'event_created'}));return
    if a.env_file: load_env(a.env_file)
    cfg = json.loads(a.config.read_text()) if a.config.exists() else {}
    base = (a.endpoint or cfg.get('endpoint', '')).removesuffix('/prepare').rstrip('/')
    # Reuse sender endpoint validation without creating an outbox or starting a thread.
    import ipaddress
    from urllib.parse import urlsplit
    u = urlsplit(base)
    ip = ipaddress.ip_address(u.hostname)
    if u.scheme not in ('http', 'https') or not ip.is_private or ip.is_unspecified or u.username or u.password or u.query or u.fragment or u.path:
        p.error('endpoint must be a private IP base URL')
    secret = os.environ.get(cfg.get('secret_env', 'PICKUP_SHARED_SECRET'), '')
    if len(secret) < 32: p.error('shared secret missing or too short')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def request(path, body=None):
        req = urllib.request.Request(base+path, data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization':'Bearer '+secret, 'Content-Type':'application/json'}, method='POST' if body is not None else 'GET')
        try:
            with opener.open(req, timeout=5) as r: return json.loads(r.read(32768))
        except urllib.error.HTTPError as e: return json.loads(e.read(32768))
    if a.action == 'health': result = request('/health')
    elif a.action == 'prepare':
        if not a.event: p.error('--event is required')
        health = request('/health')
        if health.get('mode') != 'dry_run' and not a.allow_live: p.error('receiver is not dry-run; live test requires --allow-live')
        result = request('/prepare', json.loads(a.event.read_text()))
    else:
        eid = a.event_id or (json.loads(a.event.read_text())['event_id'] if a.event else '')
        import re
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', eid): p.error('--event-id or --event is required')
        if a.action == 'reset':
            if not a.confirm_reset: p.error('local reset requires --confirm-reset')
            result = request('/reset', {'event_id':eid, 'confirm':True})
        else: result = request('/status/'+eid)
    stamps = result.get('timestamps', {})
    if stamps.get('detected_at'):
        start = dt.datetime.fromisoformat(stamps['detected_at'].replace('Z','+00:00'))
        result['milliseconds_since_detection'] = {k:round((dt.datetime.fromisoformat(v.replace('Z','+00:00'))-start).total_seconds()*1000) for k,v in stamps.items()}
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try: main()
    except Exception:
        print('LAN request failed; check receiver, address, authentication and network. No credentials logged.', file=sys.stderr)
        sys.exit(1)
