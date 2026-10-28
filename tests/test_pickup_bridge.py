import datetime as dt
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import pickup_bridge as b
import monitor as m

URL='https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked'
OFFER={'observed_at':'2026-10-26T12:00:00Z','url':URL,'sku':'MK1E4LL/A','store_id':'R755','store':'American Dream','state':'NJ','quote':'Available today','date':'2026-10-26','name':'iPhone Duo 256GB Star White'}
class BridgeTests(unittest.TestCase):
    def bridge(self,path,notify=lambda text:None):
        return b.Bridge({'endpoint':'http://127.0.0.1:8765/prepare','retry_delays_seconds':[.5,1]},'test-secret-'*4,path,notify,autostart=False)
    def test_stable_id_payload_across_duplicate_and_restart(self):
        with tempfile.TemporaryDirectory() as path:
            one=self.bridge(path);eid=one.persist(OFFER,1000);two=self.bridge(path)
            self.assertEqual(two.persist({**OFFER,'observed_at':'2026-10-26T12:00:01Z'},1001),eid)
            with two.connect() as c:payload=json.loads(c.execute('SELECT payload FROM events').fetchone()[0])
            self.assertEqual(payload['detected_at'],OFFER['observed_at'])
            self.assertEqual(two.persist(OFFER,3000),eid)
            self.assertNotEqual(two.persist({**OFFER,'stock_event_id':'new-stock-episode'},1001),eid)
    def test_finite_retries_and_one_offline_notice_no_secret_in_logs(self):
        notices=[]
        with tempfile.TemporaryDirectory() as path:
            bridge=self.bridge(path,notices.append);eid=bridge.persist(OFFER,1000)
            with patch.object(bridge,'request',side_effect=OSError('sensitive URL and credentials')) as req:
                for t in [1000,1001,1003,1005]:bridge.tick(t)
            self.assertEqual(req.call_count,3);self.assertEqual(len(notices),1)
            with bridge.connect() as c:self.assertEqual(c.execute('SELECT phase FROM events').fetchone()[0],'failed')
            log=(Path(path)/'pickup-bridge/delivery.jsonl').read_text();self.assertNotIn(bridge.secret,log);self.assertNotIn('sensitive URL',log)
    def test_submit_never_performs_network_and_preserves_id_on_retry(self):
        with tempfile.TemporaryDirectory() as path:
            bridge=self.bridge(path);calls=[]
            def request(method,event_id,payload=None):
                calls.append((event_id,payload))
                if len(calls)==1:raise OSError()
                return 202,{'event_id':event_id,'status':'queued','timestamps':{'received_at':'2026-10-26T12:00:01Z'}}
            with patch.object(bridge,'request',side_effect=request):
                self.assertTrue(bridge.submit(OFFER));self.assertEqual(calls,[])
                bridge.tick(1000);bridge.tick(1001)
            self.assertEqual(calls[0],calls[1])
    def test_busy_and_browser_failure_send_capped_manual_notice(self):
        notices=[]
        with tempfile.TemporaryDirectory() as path:
            bridge=self.bridge(path,notices.append);one=bridge.persist(OFFER,1000)
            with patch.object(bridge,'request',return_value=(409,{'event_id':one,'status':'busy'})):bridge.tick(1000)
            two=bridge.persist({**OFFER,'store_id':'other'},1001)
            with patch.object(bridge,'request',return_value=(200,{'event_id':two,'status':'manual_review'})):bridge.tick(1001)
            self.assertEqual(len(notices),1)
    def test_notification_hook_does_not_change_telegram_or_dedup(self):
        with tempfile.TemporaryDirectory() as path,patch('pickup_bridge.enqueue_confirmed_offer') as enqueue,patch.object(m,'telegram') as tg:
            state={};m.notify_offer(OFFER,{},state,Path(path),False,set());m.notify_offer(OFFER,{},state,Path(path),False,set())
            self.assertEqual(tg.call_count,1);self.assertEqual(enqueue.call_count,2)
    def test_disabled_by_default_and_bad_endpoints_rejected(self):
        with patch.dict(b.os.environ,{},clear=True):self.assertFalse(b.enqueue_confirmed_offer(OFFER,'.',lambda x:None))
        with tempfile.TemporaryDirectory() as path:
            with self.assertRaises(ValueError):b.Bridge({'endpoint':'http://8.8.8.8:8765/prepare'},'x'*40,path,print,False)
        self.assertFalse(b.valid_product_url(URL+'?token=secret'))
    def test_hook_exception_cannot_prevent_stock_telegram(self):
        with tempfile.TemporaryDirectory() as path,patch('pickup_bridge.enqueue_confirmed_offer',side_effect=RuntimeError()),patch.object(m,'telegram') as tg:
            m.notify_offer(OFFER,{}, {},Path(path),False,set())
            self.assertEqual(tg.call_count,1)
    def test_expired_pending_event_is_not_sent_after_restart(self):
        notices=[]
        with tempfile.TemporaryDirectory() as path:
            bridge=self.bridge(path,notices.append);bridge.persist(OFFER,1000)
            with patch.object(bridge,'request') as req:bridge.tick(1200)
            req.assert_not_called();self.assertEqual(len(notices),1)
    def test_held_event_keeps_watching_until_receiver_finishes(self):
        with tempfile.TemporaryDirectory() as path:
            bridge=self.bridge(path);eid=bridge.persist(OFFER,1000)
            with patch.object(bridge,'request',return_value=(202,{'event_id':eid,'status':'held'})):bridge.tick(1000)
            with bridge.connect() as c:self.assertEqual(c.execute('SELECT phase FROM events').fetchone()[0],'watching')
            with patch.object(bridge,'request',return_value=(200,{'event_id':eid,'status':'awaiting_user'})):bridge.tick(1006)
            with bridge.connect() as c:self.assertEqual(c.execute('SELECT phase,result FROM events').fetchone(),('done','awaiting_user'))


class TailscaleTransportTests(unittest.TestCase):
    def test_exact_shared_address_range_and_existing_lan_support(self):
        for value in ['100.64.0.0','100.103.212.49','100.83.108.82','100.127.255.255','192.168.31.35','127.0.0.1']:
            self.assertTrue(b.private_bridge_ipv4(value),value)
        for value in ['100.63.255.255','100.128.0.0','8.8.8.8','0.0.0.0','::1','invalid']:
            self.assertFalse(b.private_bridge_ipv4(value),value)
    def test_tailscale_sender_preserves_authentication_and_url_restrictions(self):
        with tempfile.TemporaryDirectory() as path:
            bridge=b.Bridge({'endpoint':'http://100.103.212.49:8765/prepare'},'test-secret-'*4,path,lambda _:None,autostart=False)
            self.assertEqual(bridge.config['endpoint'],'http://100.103.212.49:8765/prepare')
            for url in ['http://100.128.0.0:8765/prepare','http://100.103.212.49:8765/prepare?token=x','http://user:pass@100.103.212.49:8765/prepare']:
                with self.assertRaises(ValueError):b.Bridge({'endpoint':url},'test-secret-'*4,path,lambda _:None,autostart=False)
            with self.assertRaises(ValueError):b.Bridge({'endpoint':'http://100.103.212.49:8765/prepare'},'short',path,lambda _:None,autostart=False)

class EndpointEnvironmentTests(unittest.TestCase):
    def test_explicit_environment_replaces_remote_endpoint_without_mutating_file(self):
        original={'enabled':True,'endpoint':'http://100.103.212.49:8765/prepare','secret_env':'PICKUP_SHARED_SECRET'}
        resolved=b.endpoint_config(original,{'PICKUP_MAC_ENDPOINT':'http://127.0.0.1:8765/prepare'})
        self.assertEqual(resolved['endpoint'],'http://127.0.0.1:8765/prepare')
        self.assertEqual(original['endpoint'],'http://100.103.212.49:8765/prepare')
        self.assertEqual(resolved['secret_env'],'PICKUP_SHARED_SECRET')
    def test_empty_override_preserves_config_and_public_override_still_rejected(self):
        original={'enabled':True,'endpoint':'http://127.0.0.1:8765/prepare'}
        self.assertEqual(b.endpoint_config(original,{}),original)
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                b.Bridge(b.endpoint_config(original,{'PICKUP_MAC_ENDPOINT':'http://8.8.8.8:8765/prepare'}),'x'*40,folder,lambda _:None,autostart=False)

class ImmediateWakeTests(unittest.TestCase):
    def test_submit_signals_worker_without_sending_on_callers_thread(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge=b.Bridge({'endpoint':'http://127.0.0.1:8765/prepare'},'x'*40,folder,lambda _:None,autostart=False)
            with patch.object(bridge,'request',side_effect=AssertionError('must remain asynchronous')):
                self.assertFalse(bridge.wake.is_set())
                self.assertTrue(bridge.submit(OFFER))
                self.assertTrue(bridge.wake.is_set())
    def test_full_queue_does_not_claim_success(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge=b.Bridge({'endpoint':'http://127.0.0.1:8765/prepare'},'x'*40,folder,lambda _:None,autostart=False)
            for _ in range(128):self.assertTrue(bridge.submit(OFFER))
            bridge.wake.clear();self.assertFalse(bridge.submit(OFFER));self.assertFalse(bridge.wake.is_set())

class SimulationPaymentTests(unittest.TestCase):
    def test_only_explicit_test_offer_preserves_payment_suppression(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge=b.Bridge({'endpoint':'http://127.0.0.1:8765/prepare'},'x'*40,folder,lambda _:None,autostart=False)
            normal=bridge.persist(OFFER,1000)
            test=bridge.persist({**OFFER,'stock_event_id':'test','simulation_no_payment':True},1001)
            with bridge.connect() as c:
                records={row[0]:json.loads(row[1]) for row in c.execute('SELECT id,payload FROM events')}
            self.assertNotIn('simulation_no_payment',records[normal]);self.assertTrue(records[test]['simulation_no_payment'])
