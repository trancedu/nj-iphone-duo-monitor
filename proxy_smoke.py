#!/usr/bin/env python3
"""Bounded, isolated Clash/Mihomo pickup connectivity diagnostic (no alerts)."""
import argparse
import concurrent.futures
import datetime as dt
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

import monitor as m


def connectivity_probe(opener, urls=None):
    results = []
    for url in (urls or ('https://api.ipify.org?format=json',
                'https://www.cloudflare.com/cdn-cgi/trace', 'https://example.com/')):
        started = time.monotonic()
        row = {'url': url}
        try:
            with opener.open(url, timeout=12) as response:
                body = response.read(65536).decode(errors='replace')
                row['status'] = response.status
                if 'ipify.org' in url:
                    row['ip'] = json.loads(body)['ip']
                elif 'cloudflare.com' in url:
                    fields = dict(line.split('=', 1) for line in body.splitlines() if '=' in line)
                    row.update({k: fields[k] for k in ('ip', 'loc') if k in fields})
                else:
                    row['expected_content'] = 'Example Domain' in body
        except Exception as exc:
            row['error'] = type(exc).__name__ + ': ' + str(exc)
        row['seconds'] = round(time.monotonic() - started, 3)
        results.append(row)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', action='append', help='Exact node name; repeat for each selected node (maximum thirty for inventory)')
    parser.add_argument('--zip', default='07094')
    parser.add_argument('--compare-three', '--compare-nodes', dest='compare_three', action='store_true', help='One inventory request per node, three seconds apart by default; no retries (3–30 nodes)')
    parser.add_argument('--connectivity-only', action='store_true', help='Test non-Apple sites and exit; never query inventory')
    parser.add_argument('--scan-exits', action='store_true', help='Measure IPv4 exits of all subscription nodes; never contact Apple')
    parser.add_argument('--start-spacing', type=float, help='Minimum seconds between inventory request starts (sequential, no catch-up bursts)')
    parser.add_argument('--require-unique-exits', action='store_true', help='Exclude duplicate/unverified exits before inventory requests')
    parser.add_argument('--exit-report', type=Path, help='Reuse an exit scan measured within the last five minutes')
    parser.add_argument('--probe-url', action='append', help='Override connectivity test URLs (non-Apple diagnostics)')
    parser.add_argument('--clash-config', type=Path, default=Path.home() / 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml')
    parser.add_argument('--mihomo', default='/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo')
    args = parser.parse_args()
    if args.start_spacing is not None and (not args.compare_three or args.start_spacing < 2):
        parser.error('--start-spacing requires comparison mode and a minimum of two seconds')
    if args.scan_exits:
        args.connectivity_only = True
        args.probe_url = ['https://api4.ipify.org?format=json']
    if args.compare_three and args.connectivity_only:
        parser.error('--compare-three cannot be combined with --connectivity-only')
    nodes = args.node or [f'🇺🇸美国{i:02d}|流媒体|0.1x' for i in (1, 2, 3)]
    # Ruby ships with macOS; credentials travel only through memory/private temp files.
    loaded = subprocess.run(['ruby', '-ryaml', '-rjson', '-e',
                             'puts JSON.generate(YAML.load_file(ARGV[0]))', str(args.clash_config)],
                            capture_output=True, check=True)
    source = json.loads(loaded.stdout)
    proxies = {p['name']: p for p in source['proxies']}
    measured_exits = {}
    if args.exit_report:
        evidence = json.loads(args.exit_report.read_text())
        age = time.time() - dt.datetime.fromisoformat(evidence['started_at']).timestamp()
        if not 0 <= age <= 300:
            parser.error('Exit scan must be less than five minutes old')
        measured_exits = {r['node']: p['ip'] for r in evidence['results']
                          for p in r.get('probes', []) if p.get('ip') and p.get('status') == 200}
        if any(node not in measured_exits for node in nodes):
            parser.error('Exit report lacks a selected node')
    if args.scan_exits:
        nodes = [name for name in proxies if name.startswith('🇺🇸')]
        nodes += [name for name in proxies if name.startswith('🇬🇧')]
        nodes += [name for name in proxies if name not in nodes and name.startswith(('🇯🇵', '🇭🇰', '🇸🇬', '🇨🇳'))]
    if len(set(nodes)) != len(nodes) or not 3 <= len(nodes) <= (60 if args.scan_exits else 30 if args.compare_three else 10 if args.connectivity_only else 3):
        parser.error('Use distinct nodes, maximum 30 for inventory comparison or 60 for exit scan')
    if any(node not in proxies for node in nodes):
        parser.error('A selected node is absent from the active config')
    report = {'started_at': dt.datetime.now(m.TZ).isoformat(), 'zip': args.zip,
              'skus': ['MK1E4LL/A', 'MK1J4LL/A'], 'results': [],
              'scope': 'One bounded diagnostic; no retries, alerts, or production changes'}
    if args.compare_three:
        report['scope'] = f'Explicit {len(nodes)}-node comparison: one inventory request per node, three-second gaps, no retries'
        if args.start_spacing is not None:
            report['scope'] = f'Explicit {len(nodes)}-node comparison: one inventory request per node, minimum {args.start_spacing}s between starts, sequential, no retries'
    runtime = m.ROOT / 'runtime' / ('proxy-smoke-' + dt.datetime.now(m.TZ).strftime('%Y%m%d-%H%M%S'))
    runtime.mkdir(parents=True, exist_ok=True)
    os.environ['no_proxy'] = os.environ['NO_PROXY'] = ''
    if args.connectivity_only:
        report['scope'] = f'Non-Apple connectivity only; direct, running Clash port, {len(nodes)} pinned nodes'
        report['controls'] = {}
        for name, mapping in [('direct', {}), ('running_clash_7897', {
                'http': 'http://127.0.0.1:7897', 'https': 'http://127.0.0.1:7897'})]:
            report['controls'][name] = connectivity_probe(urllib.request.build_opener(urllib.request.ProxyHandler(mapping)), args.probe_url)
            print(json.dumps({name: report['controls'][name]}, ensure_ascii=False), flush=True)
    with tempfile.TemporaryDirectory(prefix='iphone-proxy-smoke-') as private:
        # Reserve all ports together so the OS cannot allocate the same port twice.
        reserved = []
        try:
            for _ in nodes:
                sock = socket.socket()
                reserved.append(sock)
                sock.bind(('127.0.0.1', 0))
            ports = [sock.getsockname()[1] for sock in reserved]
        finally:
            for sock in reserved:
                sock.close()
        config = {'mode': 'rule', 'log-level': 'info', 'allow-lan': False,
                  'proxies': [proxies[n] for n in nodes],
                  'listeners': [{'name': f'smoke-{i}', 'type': 'http', 'listen': '127.0.0.1',
                                 'port': port, 'proxy': node} for i, (node, port) in enumerate(zip(nodes, ports))],
                  'rules': ['MATCH,REJECT'], 'profile': {'store-selected': False}}
        config_path = Path(private) / 'config.json'
        config_path.write_text(json.dumps(config, ensure_ascii=False))
        config_path.chmod(0o600)
        with (runtime / 'mihomo.log').open('w') as log:
            process = subprocess.Popen([args.mihomo, '-d', private, '-f', str(config_path)], stdout=log, stderr=log)
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
                            raise RuntimeError('Private Mihomo listeners failed to start')
                        time.sleep(.1)
                clients = []
                for node, port in zip(nodes, ports):
                    client = m.Client()
                    client.opener = urllib.request.build_opener(urllib.request.ProxyHandler(
                        {'http': f'http://127.0.0.1:{port}', 'https': f'http://127.0.0.1:{port}'}))
                    client.opener.addheaders = m.Client().opener.addheaders
                    clients.append(client)
                    row = {'node': node, 'port': port}
                    if args.scan_exits:
                        report['results'].append(row)
                        continue
                    if args.connectivity_only:
                        row['probes'] = connectivity_probe(client.opener, args.probe_url)
                        report['results'].append(row)
                        print(json.dumps(row, ensure_ascii=False), flush=True)
                        continue
                    try:
                        if args.exit_report:
                            row['egress_ip'] = measured_exits[node]
                            row['exit_measurement_source'] = str(args.exit_report.resolve())
                        else:
                            row['egress_ip'] = json.loads(client.get('https://api4.ipify.org?format=json'))['ip']
                    except (m.QueryError, ValueError, KeyError) as exc:
                        row['preflight_error'] = str(exc)
                    report['results'].append(row)
                    print(json.dumps(row, ensure_ascii=False), flush=True)
                if args.scan_exits:
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                        futures = {executor.submit(connectivity_probe, client.opener, args.probe_url): row
                                   for client, row in zip(clients, report['results'])}
                        for future in concurrent.futures.as_completed(futures):
                            row = futures[future]
                            row['probes'] = future.result()
                            print(json.dumps(row, ensure_ascii=False), flush=True)
                if args.connectivity_only:
                    return 0 if all(all(p.get('status') == 200 for p in r['probes'])
                                    for r in report['results']) else 1
                # Default starts: 0,20,40. Comparison is sequential with no catch-up bursts.
                epoch = time.monotonic()
                next_allowed = epoch
                seen_exits = set()
                for i, (client, row) in enumerate(zip(clients, report['results'])):
                    if args.require_unique_exits:
                        ip = row.get('egress_ip')
                        if not ip or ip in seen_exits:
                            row['skipped'] = 'Unverified or duplicate preflight exit IP'
                            continue
                        seen_exits.add(ip)
                    target = next_allowed if args.compare_three else epoch + i * 20
                    time.sleep(max(0, target - time.monotonic()))
                    row['start_seconds'] = round(time.monotonic() - epoch, 3)
                    if not args.compare_three and i and row['start_seconds'] >= 60:
                        row['error'] = 'one_minute_budget_exceeded'
                        break
                    row['queried_at'] = dt.datetime.now(m.TZ).isoformat()
                    try:
                        payload = client.inventory_region(report['skus'], args.zip)
                        (runtime / f'apple-{i+1}.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2))
                        rows = payload.get('body', {}).get('stores', [])
                        watched = {r['storeNumber']: {} for r in rows}
                        products = {sku: {} for sku in report['skus']}
                        m.regional_payloads(payload, products, watched, {'zip': args.zip}, dt.datetime.now(m.TZ).date())
                        row.update(ok=True, http_status=200, store_count=len(rows), stores=[{
                            'id': r['storeNumber'], 'name': r['storeName'], 'parts': {
                                sku: {'display': r['partsAvailability'][sku]['pickupDisplay'],
                                      'quote': r['partsAvailability'][sku].get('pickupSearchQuote', '')}
                                for sku in report['skus']}} for r in rows])
                    except (m.QueryError, ValueError, KeyError) as exc:
                        row.update(ok=False, error=str(exc))
                        if isinstance(exc, m.QueryError):
                            row['retry_after_seconds'] = exc.retry_after
                            if exc.code.startswith('http_'):
                                row['http_status'] = int(exc.code[5:])
                        print(json.dumps(row, ensure_ascii=False), flush=True)
                        # Explicit comparison is bounded to one request per node. Honor rate-limit responses.
                        if not args.compare_three or (isinstance(exc, m.QueryError) and
                                (exc.code == 'http_429' or exc.retry_after > 0)):
                            break
                    finally:
                        row['finished_seconds'] = round(time.monotonic() - epoch, 3)
                        next_allowed = (epoch + row['start_seconds'] + args.start_spacing
                                        if args.start_spacing is not None else time.monotonic() + 3)
                    print(json.dumps({k: v for k, v in row.items() if k != 'stores'}, ensure_ascii=False), flush=True)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                report['finished_at'] = dt.datetime.now(m.TZ).isoformat()
                for row in report['results']:
                    if not args.connectivity_only and 'queried_at' not in row and 'skipped' not in row:
                        row['skipped'] = 'Stopped after earlier error or exhausted time budget'
                if args.connectivity_only:
                    report['passed'] = len(report['results']) == len(nodes) and all(
                        all(p.get('status') == 200 for p in r['probes']) for r in report['results'])
                    report['distinct_egress_ips'] = len({p['ip'] for r in report['results'] for p in r['probes'] if p.get('ip')})
                else:
                    report['passed'] = all(r.get('ok') for r in report['results']) and len(report['results']) == len(nodes)
                    report['distinct_egress_ips'] = len({r['egress_ip'] for r in report['results'] if r.get('egress_ip')})
                (runtime / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
                print('Report: ' + str(runtime / 'report.json'), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
