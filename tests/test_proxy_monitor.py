import argparse
from contextlib import contextmanager
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import monitor as m
import proxy_monitor as p


class ProxyMonitorTests(unittest.TestCase):
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
            self.assertLess(report['elapsed_seconds'], .5)
            state = json.loads((root / 'runtime/proxy-monitor/state.json').read_text())
            self.assertIn('last_started_at', state['exits']['test-ip'])


if __name__ == '__main__':
    unittest.main()
