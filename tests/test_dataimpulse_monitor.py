import argparse
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import monitor as m
import dataimpulse_monitor as d
import proxy_monitor as p


class LiveMonitorTests(unittest.TestCase):
    def test_stock_result_uses_shared_notification_entry_and_no_original_pool(self):
        config=json.loads((m.ROOT/'config.json').read_text());calls=[]
        class Client:
            response_bytes=0
            def __init__(self,*_):pass
            def inventory_region(self,products,zipcode):
                calls.append(time.monotonic());self.response_bytes=100
                return {'body':{'location':zipcode,'stores':[{'storeNumber':sid,'storeName':config['stores'][sid]['name'],
                    'state':config['stores'][sid]['state'],'partsAvailability':{sku:{'pickupDisplay':'available' if i==0 and sid==p.EXPECTED_07094[0] else 'unavailable',
                    'pickupSearchQuote':'Available Today','messageTypes':{'regular':{'storeSelectionEnabled':i==0 and sid==p.EXPECTED_07094[0]}}}
                    for i,sku in enumerate(products)}} for sid in p.EXPECTED_07094]}}
        with tempfile.TemporaryDirectory() as path:
            root=Path(path);(root/'config.json').write_text(json.dumps(config));env=root/'empty.env';env.write_text('')
            args=argparse.Namespace(env_file=env,proxy_env_file=env,duration=.09,spacing=.03,workers=2,zip='07094')
            runtime=root/'runtime/proxy-monitor';runtime.mkdir(parents=True)
            (runtime/'state.json').write_text(json.dumps({'sent':{'existing-key':123},'exits':{'old-ip':{'last_success_at':100}}}))
            with patch.object(m,'ROOT',root),patch.object(d.signal,'signal'),patch.dict(d.os.environ,{},clear=True), \
                 patch.object(m,'notify_offer') as notify,patch.object(p,'private_proxy') as old_pool:
                report=d.run(args,client_factory=Client)
            state=json.loads((runtime/'state.json').read_text())
            self.assertGreaterEqual(notify.call_count,1);old_pool.assert_not_called()
            self.assertTrue(all(call.args[4] is False for call in notify.call_args_list))
            self.assertEqual(state['sent']['existing-key'],123);self.assertEqual(set(state['exits']),{'old-ip'})
        self.assertEqual(report['backend'],'dataimpulse_only');self.assertFalse(report['uses_original_pool'])
        self.assertEqual(report['counts_by_source']['dataimpulse'],{'http_200':len(calls)})
        self.assertGreater(report['daily_response_body_bytes'],0)

    def test_health_failure_backoff_alert_is_capped_and_recovers_once(self):
        state={};error={'result':'network_error'}
        with patch.object(m,'telegram') as tg:
            for _ in range(12):d.record_health(state,error,1000)
            self.assertEqual(tg.call_count,1)
            self.assertGreaterEqual(state['dataimpulse_live_blocked_until'],1060)
            d.record_health(state,{'result':'http_200'},1001)
            self.assertEqual(tg.call_count,2)
            d.record_health(state,{'result':'http_200'},1002)
            self.assertEqual(tg.call_count,2)
            self.assertEqual(state['dataimpulse_live']['consecutive_failures'],0)
            self.assertEqual(state['dataimpulse_live_blocked_until'],0)

    def test_retry_after_preserved(self):
        state={};d.record_health(state,{'result':'http_429','retry_after':900},1000)
        self.assertEqual(state['dataimpulse_live_blocked_until'],1900)
        d.record_health(state,{'result':'http_200'},1001)
        self.assertEqual(state['dataimpulse_live_blocked_until'],1900)

    def test_inventory_failure_redacts_exception(self):
        class Bad:
            response_bytes=0
            def inventory_region(self,*args):raise RuntimeError('PRIVATE_PASSWORD')
        raw,event=d.inventory(Bad(),{},'07094')
        self.assertIsNone(raw);self.assertEqual(event['result'],'network_error')
        self.assertNotIn('PRIVATE_PASSWORD',json.dumps(event))

    def test_client_factory_failure_is_safe_network_error(self):
        def bad(*args):raise RuntimeError('PRIVATE_AUTH')
        raw,event=d.inventory_from_settings({}, {},'07094',bad)
        self.assertIsNone(raw);self.assertEqual(event['result'],'network_error')
        self.assertNotIn('PRIVATE_AUTH',json.dumps(event))
