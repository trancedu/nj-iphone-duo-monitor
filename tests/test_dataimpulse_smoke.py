import json
import http.client
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.parse
import monitor as m
import dataimpulse_smoke as d
import proxy_monitor as p


class DataImpulseTests(unittest.TestCase):
    def test_incomplete_response_is_safe_network_error_and_counts_partial_bytes(self):
        env={'DATAIMPULSE_PROXY_USERNAME':'dummy','DATAIMPULSE_PROXY_PASSWORD':'dummy',
             'DATAIMPULSE_PROXY_HOST':'gw.dataimpulse.com','DATAIMPULSE_PROXY_PORT':'823'}
        client=d.DataImpulseClient(env,'us')
        with patch.object(m.Client,'get',side_effect=http.client.IncompleteRead(b'partial',100)):
            with self.assertRaises(m.QueryError) as error:client.get('https://www.apple.com/')
        self.assertEqual(error.exception.code,'network_error')
        self.assertEqual(client.response_bytes,7)

    def test_country_override_preserves_other_parameters_and_escapes_credentials(self):
        env={'DATAIMPULSE_PROXY_USERNAME':'dummy__cr.gb;sessid.test',
             'DATAIMPULSE_PROXY_PASSWORD':'dummy:p@ss', 'DATAIMPULSE_PROXY_HOST':'gw.dataimpulse.com', 'DATAIMPULSE_PROXY_PORT':'823'}
        client=d.DataImpulseClient(env,'us')
        handler=next(h for h in client.opener.handlers if isinstance(h,d.urllib.request.ProxyHandler))
        url=urllib.parse.urlsplit(handler.proxies['https'])
        self.assertEqual(urllib.parse.unquote(url.username),'dummy__cr.us;sessid.test')
        self.assertEqual(urllib.parse.unquote(url.password),'dummy:p@ss')
        self.assertEqual(env['DATAIMPULSE_PROXY_USERNAME'],'dummy__cr.gb;sessid.test')
        for host in ['https://gw.dataimpulse.com','gw.dataimpulse.com.evil.test','user@gw.dataimpulse.com']:
            with self.assertRaises(ValueError): d.DataImpulseClient({**env,'DATAIMPULSE_PROXY_HOST':host},'us')

    def fake(self,country='US',fail=False):
        class Client:
            response_bytes=0
            inventory_calls=0
            country='us'
            def read(inner,url):
                if fail:raise OSError('SENSITIVE_AUTHENTICATED_URL')
                return 'ip=192.0.2.3\nloc='+country if 'cloudflare' in url else '{"ip":"192.0.2.1"}'
            def inventory_region(inner,products,zipcode):
                inner.inventory_calls+=1
                config=json.loads((m.ROOT/'config.json').read_text())
                return {'body':{'location':zipcode,'stores':[{
                    'storeNumber':sid,'storeName':config['stores'][sid]['name'],'state':config['stores'][sid]['state'],
                    'partsAvailability':{sku:{'pickupDisplay':'unavailable','messageTypes':{'regular':{'storeSelectionEnabled':False}}} for sku in products}}
                    for sid in p.EXPECTED_07094]}}
        return Client()

    def test_bounded_success_does_one_inventory_read_and_no_notifications(self):
        client=self.fake();config=json.loads((m.ROOT/'config.json').read_text())
        with patch.object(m,'telegram') as notify,patch('pickup_bridge.enqueue_confirmed_offer') as bridge:
            report=d.run(client,config,3,True)
        self.assertEqual(len(report['probes']),3)
        self.assertEqual(client.inventory_calls,1)
        self.assertEqual(report['inventory']['stores'],12)
        self.assertEqual(report['inventory']['configurations'],6)
        self.assertFalse(report['production_enabled']);notify.assert_not_called();bridge.assert_not_called()

    def test_country_mismatch_skips_apple(self):
        client=self.fake('GB');report=d.run(client,{},3,True)
        self.assertEqual(client.inventory_calls,0)
        self.assertEqual(report['inventory']['status'],'skipped_country_mismatch')

    def test_failed_probe_never_logs_raw_error_or_requests_inventory(self):
        client=self.fake(fail=True);report=d.run(client,{},3,True)
        self.assertEqual(client.inventory_calls,0)
        self.assertEqual(report['inventory']['status'],'skipped_probe_failure')
        self.assertNotIn('SENSITIVE_AUTHENTICATED_URL',json.dumps(report))
