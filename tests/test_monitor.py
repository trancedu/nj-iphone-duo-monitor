import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import monitor as m

TODAY = dt.date(2026,10,23)
PRODUCTS = {'DUO':{'name':'iPhone Duo 256GB Night Sky','url':'https://www.apple.com/shop/buy-iphone/iphone-duo'}}

def payload(quote='Available Today', display='available', state='NJ'):
    date = TODAY
    if quote == 'Available Tomorrow': date += dt.timedelta(days=1)
    elif 'Oct 27' in quote: date += dt.timedelta(days=4)
    elif 'Oct 22' in quote: date -= dt.timedelta(days=1)
    item={'storeId':'R001','address':{'address':'Test Store'},'state':state,
          'storeSelectionEnabled':display=='available','pickupSearchQuote':quote,
          'pickupEncodedUpperDateString':date.strftime('%Y%m%d')}
    if quote == 'Available': item.pop('pickupEncodedUpperDateString')
    return {'body':{'content':[item]}}

class MonitorTests(unittest.TestCase):
    def test_dates(self):
        for quote, days in [('Available Today',0),('Available Tomorrow',1),('Oct 25',2),('October 26, 2026',3),('2026-10-24',1),('Oct 24–26',3)]:
            self.assertEqual(m.pickup_date(quote,TODAY),TODAY+dt.timedelta(days=days))
        self.assertEqual(m.pickup_date('Jan 1',dt.date(2026,12,31)),dt.date(2027,1,1))
        for quote in ['Available','Check back Tomorrow','Unavailable Today','Not available today']:
            self.assertIsNone(m.pickup_date(quote,TODAY))
    def test_filter(self):
        self.assertEqual(len(m.parse_inventory(payload(),PRODUCTS,TODAY)[0]),1)
        for p in [payload('Oct 27'),payload('Oct 22'),payload('Available'),payload(display='unavailable')]:
            self.assertEqual(m.parse_inventory(p,PRODUCTS,TODAY)[0],[])
        with self.assertRaises(m.QueryError): m.parse_inventory(payload(state='PA'),PRODUCTS,TODAY)
    def test_schema(self):
        for p in [{}, {'body':{'content':[]}},payload()]:
            products = {} if p == payload() else PRODUCTS
            with self.assertRaises(m.QueryError): m.parse_inventory(p,products,TODAY)
    def test_later_quote_wins(self):
        p=payload();p['body']['content'][0]['storePickupQuote']='Oct 28'
        
        with self.assertRaises(m.QueryError): m.parse_inventory(p,PRODUCTS,TODAY)
    def test_no_pro_alert(self):
        offer=m.parse_inventory(payload(),PRODUCTS,TODAY)[0][0]
        self.assertTrue(m.should_alert(offer,{},2000))
        self.assertFalse(m.should_alert(offer,{'sent':{m.offer_key(offer):1900}},2000))
        offer['name']='iPhone 18 Pro Max 256GB Silver'
        self.assertFalse(m.should_alert(offer,{},2000))
    def test_failed_send_retries(self):
        class Fake:
            def inventory(self,*args):
                p=payload(); p['body']['content'][0]['pickupEncodedUpperDateString']=dt.datetime.now(m.TZ).strftime('%Y%m%d'); return p
        config={'products':PRODUCTS,'stores':{'R001':{}},'max_pickup_days':3,'interval_seconds':60,'request_gap_seconds':5}
        state={}
        with tempfile.TemporaryDirectory() as path, patch.object(m,'telegram',side_effect=m.QueryError('telegram_send_failed')):
            with self.assertRaises(m.QueryError): m.run_cycle(Fake(),config,state,Path(path))
        self.assertFalse(state.get('sent'))
    def test_block_stops_requests_and_backs_off(self):
        class Fake:
            calls=0
            def inventory(self,*args):
                self.calls+=1;raise m.QueryError('http_429',900)
        config={'products':PRODUCTS,'stores':{'R001':{}},'max_pickup_days':3,'interval_seconds':60,'request_gap_seconds':5}
        client=Fake();state={}
        with tempfile.TemporaryDirectory() as path:
            delay=m.run_cycle(client,config,state,Path(path),dry_run=True)
        self.assertEqual(client.calls,1); self.assertGreaterEqual(delay,899)
        self.assertEqual(state['status'],'degraded'); self.assertNotIn('last_success_at',state)

if __name__=='__main__': unittest.main()
