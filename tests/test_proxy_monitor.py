import argparse
from contextlib import contextmanager
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
import threading
import time
from unittest.mock import patch

import monitor as m
import proxy_monitor as p


class ProxyMonitorTests(unittest.TestCase):
    def test_recovery_budget_coalesces_errors_and_survives_restart(self):
        state = {};recovery = p.RecoveryPacer(state, 2)
        for now in [100, 101]:
            recovery.failed(m.QueryError('http_541'), 'bad')
            recovery.failed(m.QueryError('network_error'), 'other')
            self.assertTrue(recovery.available(now))
            self.assertEqual(recovery.dispatched(now, True)['ip'], 'other')
            self.assertFalse(recovery.pending)
        restored = p.RecoveryPacer(json.loads(json.dumps(state)), 2)
        restored.failed(m.QueryError('http_541'), 'bad')
        self.assertFalse(restored.available(159))
        self.assertTrue(restored.available(160))

    def test_recovery_disabled_or_global_backoff_never_grants_credit(self):
        disabled = p.RecoveryPacer({}, 0)
        disabled.failed(m.QueryError('http_541'), 'bad')
        self.assertFalse(disabled.available(100))
        recovery = p.RecoveryPacer({})
        for error in [m.QueryError('http_429'), m.QueryError('http_541', 300)]:
            recovery.failed(m.QueryError('network_error'), 'bad')
            recovery.failed(error, 'blocked')
            self.assertFalse(recovery.available(100))
        recovery.failed(m.QueryError('invalid_regional_store_schema'), 'schema')
        self.assertFalse(recovery.available(100))

    def test_recovery_uses_only_ready_ips_and_prefers_successful_exit(self):
        pool = [{'ip': ip, 'probe_seconds': .1} for ip in ['cooling', 'recent', 'healthy', 'unknown']]
        state = {'exits': {'cooling': {'blocked_until': 200}, 'recent': {'last_started_at': 95},
                          'healthy': {'last_success_at': 30, 'last_started_at': 30}}}
        self.assertEqual(p.ready_recovery_exit(pool, state, 100, 60)['ip'], 'healthy')
        state['global_blocked_until'] = 101
        self.assertIsNone(p.ready_recovery_exit(pool, state, 100, 60))

    def test_failed_request_replaced_before_normal_spacing_without_reusing_ip(self):
        config = json.loads((m.ROOT / 'config.json').read_text());calls=[]
        class FakeClient:
            def __init__(self, ip):self.ip=ip
            def inventory_region(self, products, zipcode):
                calls.append((self.ip, time.monotonic()))
                raise m.QueryError('http_541')
        pool = [{'node': str(i), 'ip': str(i), 'probe_seconds': .1, 'client': FakeClient(str(i))} for i in range(5)]
        @contextmanager
        def private(*args):yield pool
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'config.json').write_text(json.dumps(config))
            args=argparse.Namespace(duration=2.4,max_nodes=60,workers=1,spacing=2,
                max_recovery_per_minute=1,min_ip_interval=60,cooldown=300,zip='07094',
                env_file=root/'missing.env',clash_config=root/'config.yaml',mihomo='unused')
            with patch.object(m,'ROOT',root),patch.object(p,'private_proxy',private), \
                 patch.object(p,'discover_pool',return_value=pool),patch.object(p.signal,'signal'), \
                 patch.dict(p.os.environ,{},clear=True),patch('builtins.print'):
                p.run(args)
            report=json.loads((root/'runtime/proxy-monitor/current.json').read_text())
            events=[json.loads(l) for l in (Path(report['output'])/'queries.jsonl').read_text().splitlines()]
        self.assertEqual(len(calls),3)
        self.assertNotEqual(calls[0][0],calls[1][0])
        self.assertGreaterEqual(calls[1][1]-calls[0][1],.199)
        self.assertLess(calls[1][1]-calls[0][1],1)
        self.assertLess(calls[2][1]-calls[0][1],2.15)
        self.assertEqual(report['recovery_queries'],1)
        self.assertEqual(events[1]['dispatch_reason'],'failure_recovery')
        self.assertEqual(events[1]['recovery_from']['result'],'http_541')
        self.assertEqual(events[2]['dispatch_reason'],'scheduled')

    def test_environment_zip_from_env_file_reaches_actual_proxy_request(self):
        config = json.loads((m.ROOT / 'config.json').read_text())
        calls = []
        class FakeClient:
            def inventory_region(self, products, zipcode):
                calls.append(zipcode)
                return {'body': {'location': zipcode, 'stores': [{
                    'storeNumber': 'R-CA', 'storeName': 'California test', 'state': 'CA',
                    'partsAvailability': {sku: {'pickupDisplay': 'unavailable',
                        'messageTypes': {'regular': {'storeSelectionEnabled': False}}} for sku in products}}]}}
        row = {'node': 'test', 'ip': 'test-ip', 'client': FakeClient(), 'probe_seconds': .1}
        @contextmanager
        def private(*args): yield [row]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'config.json').write_text(json.dumps(config))
            env = root/'test.env';env.write_text('APPLE_PICKUP_ZIP=94596\n')
            args = argparse.Namespace(duration=.03, max_nodes=60, workers=1, spacing=2,
                min_ip_interval=60, cooldown=300, zip='07094', env_file=env,
                clash_config=root/'config.yaml', mihomo='unused')
            with patch.object(m, 'ROOT', root), patch.object(p, 'private_proxy', private), \
                 patch.object(p, 'discover_pool', return_value=[row]), patch.object(p.signal, 'signal'), \
                 patch.dict(p.os.environ, {}, clear=True), patch('builtins.print'):
                p.run(args)
            report = json.loads((root/'runtime/proxy-monitor/current.json').read_text())
        self.assertEqual(calls, ['94596'])
        self.assertEqual(report['zip'], '94596')
        self.assertEqual(report['counts'], {'http_200': 1})

    def test_proxy_offer_carries_query_zip_for_receiver(self):
        config = json.loads((m.ROOT / 'config.json').read_text())
        products = m.select_products(config)
        raw = {'body': {'location': '94596', 'stores': [{
            'storeNumber': 'R-CA', 'storeName': 'California test', 'state': 'CA',
            'partsAvailability': {sku: {'pickupDisplay': 'available', 'pickupSearchQuote': 'Available Today',
                'messageTypes': {'regular': {'storeSelectionEnabled': True, 'storePickupQuote': 'Today at Apple'}}}
                for sku in products}}]}}
        with patch.dict(p.os.environ, {'APPLE_PICKUP_ZIP': '94596'}):
            offers = p.parse_offers(raw, products, config, '94596')
        self.assertEqual(len(offers), 4)
        self.assertEqual({o['pickup_zip'] for o in offers}, {'94596'})
        self.assertEqual({o['state'] for o in offers}, {'CA'})
        with patch.dict(p.os.environ, {}, clear=True):
            with self.assertRaises(m.QueryError): p.parse_offers(raw, products, config, '94596')

    def test_subscription_merge_namespaces_nodes_and_ignores_expiry_rows(self):
        a = {'proxies': [{'name': 'US shared', 'type': 'ss', 'server': 'one'},
                         {'name': '剩余流量：10 GB', 'type': 'ss'}]}
        b = {'proxies': [{'name': 'US shared', 'type': 'ss', 'server': 'two'}]}
        with patch.object(p, 'yaml_data', side_effect=[a, b]):
            nodes = p.subscription_nodes([Path('first.yaml'), Path('second.yaml')])
        self.assertEqual([n['name'] for n in nodes], ['first::US shared', 'second::US shared'])
        self.assertEqual([n['server'] for n in nodes], ['one', 'two'])
        self.assertEqual(a['proxies'][0]['name'], 'US shared')

    def test_remote_profiles_only_are_loaded(self):
        with patch.object(p, 'yaml_data', return_value={'items': [
                {'type': 'remote', 'file': 'a.yaml'}, {'type': 'merge', 'file': 'merge.yaml'},
                {'type': 'remote', 'file': 'b.yaml'}]}):
            paths = p.subscription_paths(Path('/base/clash.yaml'), True)
        self.assertEqual(paths, [Path('/base/profiles/a.yaml'), Path('/base/profiles/b.yaml')])

    def test_bounded_concurrency_preserves_spacing_and_shared_exit_limits(self):
        config = json.loads((m.ROOT / 'config.json').read_text())
        starts = []
        active = set()
        peak = [0]
        guard = threading.Lock()

        class SlowClient:
            def __init__(self, ip): self.ip = ip
            def inventory_region(self, products, zipcode):
                with guard:
                    if self.ip in active: raise AssertionError('shared IP used concurrently')
                    active.add(self.ip)
                    starts.append((self.ip, time.monotonic()))
                    peak[0] = max(peak[0], len(active))
                time.sleep(.06)
                with guard: active.remove(self.ip)
                return {'body': {'location': zipcode, 'stores': [
                    {'storeNumber': sid, 'storeName': config['stores'][sid]['name'],
                     'state': config['stores'][sid]['state'], 'partsAvailability': {
                         sku: {'pickupDisplay': 'unavailable', 'pickupSearchQuote': 'Currently unavailable',
                               'messageTypes': {'regular': {'storeSelectionEnabled': False}}}
                         for sku in products}} for sid in p.EXPECTED_07094]}}

        pool = [{'node': str(i), 'ip': str(i), 'client': SlowClient(str(i)), 'probe_seconds': .1}
                for i in range(3)]
        pool.append({'node': 'duplicate', 'ip': '0', 'client': SlowClient('0'), 'probe_seconds': .1})
        @contextmanager
        def private(*args): yield pool
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_text(json.dumps(config))
            args = argparse.Namespace(duration=.18, max_nodes=60, workers=2, spacing=.02,
                min_ip_interval=60, cooldown=300, zip='07094', env_file=root/'missing.env',
                clash_config=root/'config.yaml', mihomo='unused')
            with patch.object(m, 'ROOT', root), patch.object(p, 'private_proxy', private), \
                 patch.object(p, 'discover_pool', return_value=pool), patch.object(p.signal, 'signal'), \
                 patch.dict(p.os.environ, {}, clear=True), patch('builtins.print'):
                p.run(args)
            report = json.loads((root/'runtime/proxy-monitor/current.json').read_text())
        self.assertEqual(peak[0], 2)
        self.assertEqual(len(starts), 3)
        self.assertTrue(all(b[1]-a[1] >= .019 for a, b in zip(starts, starts[1:])))
        self.assertEqual(report['counts'], {'http_200': 3})

    def test_global_retry_after_blocks_dispatch_to_another_worker(self):
        config = json.loads((m.ROOT / 'config.json').read_text())
        class BlockedClient:
            def inventory_region(self, *args): raise m.QueryError('http_429', 900)
        pool = [{'node': str(i), 'ip': str(i), 'client': BlockedClient(), 'probe_seconds': .1}
                for i in range(2)]
        @contextmanager
        def private(*args): yield pool
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'config.json').write_text(json.dumps(config))
            args = argparse.Namespace(duration=.08, max_nodes=60, workers=2, spacing=.02,
                min_ip_interval=60, cooldown=300, zip='07094', env_file=root/'missing.env',
                clash_config=root/'config.yaml', mihomo='unused')
            with patch.object(m, 'ROOT', root), patch.object(p, 'private_proxy', private), \
                 patch.object(p, 'discover_pool', return_value=pool), patch.object(p.signal, 'signal'), \
                 patch.dict(p.os.environ, {}, clear=True), patch('builtins.print'):
                p.run(args)
            report = json.loads((root/'runtime/proxy-monitor/current.json').read_text())
            state = json.loads((root/'runtime/proxy-monitor/state.json').read_text())
        self.assertEqual(report['counts'], {'http_429': 1})
        self.assertGreater(state['global_blocked_until'], time.time()+890)

    def test_403_cooldown_survives_state_serialization_and_increases(self):
        state = {'exits': {'ip': {'last_started_at': 100}}}
        p.record_result(state, 'ip', 101, m.QueryError('http_403'))
        restored = json.loads(json.dumps(state))
        self.assertEqual(p.ready_at('ip', restored, 60), 401)
        p.record_result(restored, 'ip', 402, m.QueryError('http_541'))
        self.assertEqual(p.ready_at('ip', restored, 60), 1002)

    def test_retry_after_stops_all_exits_not_only_failing_node(self):
        state = {}
        p.record_result(state, 'one', 100, m.QueryError('http_429', 900))
        self.assertEqual(p.ready_at('other', state, 60), 1000)

    def test_shared_ip_cannot_be_reused_via_other_node(self):
        state = {'exits': {'shared': {'last_started_at': 100}}}
        pool = [{'node': 'a', 'ip': 'shared'}, {'node': 'b', 'ip': 'shared'}, {'node': 'c', 'ip': 'fresh'}]
        self.assertEqual(p.next_ready(pool, state, 110, 60)['node'], 'c')
        self.assertEqual(p.ready_at(pool[1]['ip'], state, 60), 160)

    def test_invalid_response_never_generates_stock_offers(self):
        config = json.loads((m.ROOT / 'config.json').read_text())
        products = m.select_products(config)
        with self.assertRaises(m.QueryError):
            p.parse_offers({'body': {'location': '07094', 'stores': []}}, products, config, '07094')

    def test_bounded_runner_stops_records_success_and_sends_no_empty_stock_alert(self):
        config = json.loads((m.ROOT / 'config.json').read_text())

        class FakeClient:
            def inventory_region(self, products, zipcode):
                return {'body': {'location': zipcode, 'stores': [
                    {'storeNumber': sid, 'storeName': config['stores'][sid]['name'],
                     'state': config['stores'][sid]['state'], 'partsAvailability': {
                         sku: {'pickupDisplay': 'unavailable', 'pickupSearchQuote': 'Currently unavailable',
                               'messageTypes': {'regular': {'storeSelectionEnabled': False}}}
                         for sku in products}} for sid in p.EXPECTED_07094]}}

        row = {'node': 'test', 'ip': 'test-ip', 'probe_seconds': .1, 'client': FakeClient()}

        @contextmanager
        def private(*args):
            yield [row]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_text(json.dumps(config))
            args = argparse.Namespace(duration=.05, max_nodes=60, spacing=2, min_ip_interval=60,
                                      cooldown=300, zip='07094', env_file=root / 'missing.env',
                                      clash_config=root / 'clash.yaml', mihomo='unused')
            with patch.object(m, 'ROOT', root), patch.object(p, 'private_proxy', private), \
                 patch.object(p, 'discover_pool', return_value=[row]), patch.object(m, 'telegram') as send, \
                 patch.object(p.signal, 'signal'), patch.dict(p.os.environ, {}, clear=True), patch('builtins.print'):
                p.run(args)
                send.assert_not_called()
            report = json.loads((root / 'runtime/proxy-monitor/current.json').read_text())
            self.assertEqual(report['status'], 'completed')
            self.assertEqual(report['counts'], {'http_200': 1})
            self.assertEqual(report['alerts_sent'], 0)
            self.assertEqual(report['monitored_skus'], config['selection']['skus'])
            self.assertLess(report['elapsed_seconds'], .5)
            state = json.loads((root / 'runtime/proxy-monitor/state.json').read_text())
            self.assertIn('last_started_at', state['exits']['test-ip'])


if __name__ == '__main__':
    unittest.main()
