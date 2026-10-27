#!/usr/bin/env python3
"""Bounded DataImpulse smoke test; never enables polling or stock notifications."""
import argparse
import datetime as dt
import ipaddress
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

import monitor as m
from pickup_bridge import NoRedirect
from proxy_monitor import parse_offers


class DataImpulseClient(m.Client):
    def __init__(self, environ, country=None):
        super().__init__()
        values = {key: environ.get('DATAIMPULSE_PROXY_'+key, '').strip() for key in ('USERNAME', 'PASSWORD', 'HOST', 'PORT')}
        if not all(values.values()): raise ValueError('missing_proxy_configuration')
        host = values['HOST'].lower()
        if not re.fullmatch(r'[a-z0-9.-]+', host) or not host.endswith('.dataimpulse.com'):
            raise ValueError('invalid_proxy_host')
        if not values['PORT'].isdigit() or not 1 <= int(values['PORT']) <= 65535:
            raise ValueError('invalid_proxy_port')
        self.country = country
        if country:
            if not re.fullmatch(r'[a-z]{2}', country): raise ValueError('invalid_country')
            login, _, options = values['USERNAME'].partition('__')
            parameters = [v for v in options.split(';') if v and not v.startswith('cr.')]
            values['USERNAME'] = login+'__'+';'.join(['cr.'+country, *parameters])
        url = 'http://'+urllib.parse.quote(values['USERNAME'], safe='')+':'+urllib.parse.quote(values['PASSWORD'], safe='')+'@'+host+':'+values['PORT']
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({'http': url, 'https': url}), NoRedirect())
        self.opener.addheaders = m.Client().opener.addheaders
        self.response_bytes = 0

    def read(self, url):
        with self.opener.open(url, timeout=12) as response:
            data = response.read(262144)
            self.response_bytes += len(data)
            return data.decode('utf-8')

    def get(self, url):
        # Inventory errors are reduced to safe codes by Client.get, preserving
        # its existing status/error parsing while imposing a shorter timeout.
        opener = self.opener
        class WithTimeout:
            def open(inner, request, timeout=25): return opener.open(request, timeout=12)
        self.opener = WithTimeout()
        try:
            body = super().get(url)
            self.response_bytes += len(body.encode())
            return body
        finally:
            self.opener = opener


def run(client, config, probes=3, inventory=False):
    report = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'production_enabled': False,
              'requested_country': getattr(client, 'country', None), 'probes': []}
    for i in range(probes):
        started = time.monotonic()
        try:
            # These requests each use a new connection. A rotating gateway may
            # assign a different exit to the subsequent Apple request.
            if i == probes-1:
                data = dict(line.split('=', 1) for line in client.read('https://www.cloudflare.com/cdn-cgi/trace').splitlines() if '=' in line)
                ip, country = str(ipaddress.ip_address(data['ip'])), data.get('loc')
            else:
                ip = str(ipaddress.ip_address(json.loads(client.read('https://api4.ipify.org?format=json'))['ip']))
                country = None
            result = {'status': 'ok', 'ip': ip, 'country': country}
        except Exception:
            result = {'status': 'probe_failed'}
        result['seconds'] = round(time.monotonic()-started, 3)
        report['probes'].append(result)
    report['distinct_observed_ips'] = len({p['ip'] for p in report['probes'] if p.get('ip')})
    mismatch = any(p.get('country') and report['requested_country'] and
                   p['country'].lower()!=report['requested_country'] for p in report['probes'])
    if inventory and mismatch:
        report['inventory'] = {'status': 'skipped_country_mismatch'}
    elif inventory and all(p['status']=='ok' for p in report['probes']):
        products = m.select_products(config); started = time.monotonic()
        try:
            raw = client.inventory_region(products, '07094')
            offers = parse_offers(raw, products, config, '07094')
            report['inventory'] = {'status': 'http_200', 'zip': '07094', 'stores': len(raw['body']['stores']),
                'configurations': len(products), 'eligible_offers': len(offers)}
        except m.QueryError as e:
            report['inventory'] = {'status': e.code}
        except Exception:
            report['inventory'] = {'status': 'inventory_failed'}
        report['inventory']['seconds'] = round(time.monotonic()-started, 3)
    elif inventory:
        report['inventory'] = {'status': 'skipped_probe_failure'}
    report['response_body_bytes'] = client.response_bytes
    report['note'] = 'Body bytes exclude proxy billing overhead. Probe IP is not proof of the Apple request exit. No Telegram or browser event sent.'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=Path.home()/'.codex/secrets/dataimpulse.env')
    parser.add_argument('--probes', type=int, choices=range(1,4), default=3)
    parser.add_argument('--inventory', action='store_true', help='One read-only Apple inventory request after successful probes')
    parser.add_argument('--country', default='us', help='Explicit two-letter country targeting; default us')
    args = parser.parse_args()
    try:
        m.load_env(args.env_file)
        client = DataImpulseClient(os.environ, args.country)
        report = run(client, json.loads((m.ROOT/'config.json').read_text()), args.probes, args.inventory)
        directory = m.ROOT/'runtime/dataimpulse-smoke'/dt.datetime.now(m.TZ).strftime('%Y%m%d-%H%M%S')
        directory.mkdir(parents=True, mode=0o700)
        path = directory/'report.json';path.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n');path.chmod(0o600)
        print(json.dumps(report, ensure_ascii=False, indent=2));print('report:',path)
        return int(any(p['status']!='ok' for p in report['probes']) or
                   (args.inventory and report.get('inventory',{}).get('status')!='http_200'))
    except Exception:
        print('DataImpulse configuration or test failed; credentials and raw exceptions were not logged.')
        return 1


if __name__ == '__main__':raise SystemExit(main())
