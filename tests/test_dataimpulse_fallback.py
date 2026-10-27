import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import monitor as m
import proxy_monitor as p
from dataimpulse_fallback import FreshnessHedge


class HedgeTests(unittest.TestCase):
    def settings(self):return {'run_id':'test','enabled_until_epoch':1000,'stale_after_seconds':2,'max_per_minute':2,'max_requests':3,'max_body_mib':1}
    def test_staleness_success_and_single_flight(self):
        hedge=FreshnessHedge(self.settings(),{},100)
        self.assertEqual(hedge.reason_not_ready(101.9),'fresh')
        self.assertIsNone(hedge.reason_not_ready(102))
        hedge.dispatched(102)
        self.assertEqual(hedge.reason_not_ready(104,True),'in_flight')
        hedge.success(104)
        self.assertEqual(hedge.reason_not_ready(105),'fresh')
        self.assertIsNone(hedge.reason_not_ready(106))

    def test_rate_and_run_budgets_survive_restart(self):
        state={};hedge=FreshnessHedge(self.settings(),state,100)
        for t in [102,104]:hedge.reason_not_ready(t);hedge.dispatched(t)
        restarted=FreshnessHedge(self.settings(),json.loads(json.dumps(state)),100)
        self.assertEqual(restarted.reason_not_ready(110),'rate_budget')
        self.assertIsNone(restarted.reason_not_ready(163))
        restarted.dispatched(163)
        self.assertEqual(restarted.reason_not_ready(200),'request_budget')

    def test_expiry_body_budget_and_global_backoff(self):
        hedge=FreshnessHedge(self.settings(),{},100)
        self.assertEqual(hedge.reason_not_ready(102,False,103),'backoff')
        self.assertEqual(hedge.reason_not_ready(1000),'expired')
        hedge.finished(102,False,100,retry_after=10)
        self.assertEqual(hedge.reason_not_ready(111),'backoff')
        hedge.finished(113,True,1024*1024)
        self.assertEqual(hedge.reason_not_ready(115),'body_budget')

    def test_two_quick_failures_then_backoff(self):
        hedge=FreshnessHedge({**self.settings(),'max_per_minute':18},{},100)
        for now in [102,103]:
            hedge.finished(now,False)
            self.assertAlmostEqual(hedge.state['retry_at']-now,.2)
        hedge.finished(104,False)
        self.assertEqual(hedge.state['retry_at'],106)
        hedge.finished(106,True)
        self.assertEqual(hedge.state['failures'],0)

    def test_second_hedge_requires_staleness_and_slow_first_request(self):
        hedge=FreshnessHedge({**self.settings(),'stale_after_seconds':1.5,'max_in_flight':2},{},100)
        self.assertEqual(hedge.reason_not_ready(102,1,oldest_pending_age=1.5),'second_hedge_not_due')
        self.assertEqual(hedge.reason_not_ready(103,1,oldest_pending_age=.5),'second_hedge_not_due')
        self.assertIsNone(hedge.reason_not_ready(103,1,oldest_pending_age=1.5))
        self.assertEqual(hedge.reason_not_ready(104,2,oldest_pending_age=2),'in_flight')

    def test_fallback_error_does_not_stop_primary_or_create_fake_ip_record(self):
        self.integration(False)

    def test_fallback_stock_uses_existing_notification_entry(self):
        self.integration(True)

    def integration(self,stock):
        config=json.loads((m.ROOT/'config.json').read_text())
        def raw(products,zipcode,available=False):
            return {'body':{'location':zipcode,'stores':[{'storeNumber':sid,'storeName':config['stores'][sid]['name'],
                'state':config['stores'][sid]['state'],'partsAvailability':{sku:{
                    'pickupDisplay':'available' if available and index==0 and sid==p.EXPECTED_07094[0] else 'unavailable',
                    'pickupSearchQuote':'Available Today' if available else 'Currently unavailable',
                    'messageTypes':{'regular':{'storeSelectionEnabled':available and index==0 and sid==p.EXPECTED_07094[0]}}}
                    for index,sku in enumerate(products)}} for sid in p.EXPECTED_07094]}}
        class Primary:
            def inventory_region(self,products,zipcode):time.sleep(.06);return raw(products,zipcode)
        class Fallback:
            response_bytes=0
            def inventory_region(self,products,zipcode):
                if not stock:raise RuntimeError('PRIVATE_CREDENTIAL_ERROR')
                self.response_bytes+=100;return raw(products,zipcode,True)
        pool=[{'node':'test','ip':'primary-ip','client':Primary(),'probe_seconds':.1}]
        @contextmanager
        def private(*args):yield pool
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'config.json').write_text(json.dumps(config))
            env=root/'monitor.env';env.write_text('DATAIMPULSE_FALLBACK_CONFIG=mock-config\n')
            args=argparse.Namespace(duration=.15,max_nodes=60,workers=1,spacing=2,min_ip_interval=60,
                cooldown=300,zip='07094',env_file=env,clash_config=root/'config.yaml',mihomo='unused')
            settings={**self.settings(),'enabled_until_epoch':time.time()+60,'stale_after_seconds':.02}
            with patch.object(m,'ROOT',root),patch.object(p,'private_proxy',private),patch.object(p,'discover_pool',return_value=pool), \
                 patch('dataimpulse_fallback.load_settings',return_value=(settings,Fallback())),patch.object(p.signal,'signal'), \
                 patch.dict(p.os.environ,{},clear=True),patch('builtins.print'),patch.object(m,'notify_offer') as notify:
                p.run(args)
            report=json.loads((root/'runtime/proxy-monitor/current.json').read_text())
            state=json.loads((root/'runtime/proxy-monitor/state.json').read_text())
            self.assertEqual(notify.call_count,int(stock))
        self.assertEqual(report['status'],'completed')
        self.assertEqual(report['counts_by_source']['primary'],{'http_200':1})
        self.assertEqual(report['counts_by_source']['dataimpulse'],{'http_200':1} if stock else {'fallback_error':1})
        self.assertEqual(set(state['exits']),{'primary-ip'})
