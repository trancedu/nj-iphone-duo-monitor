import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
import urllib.parse
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
    def test_all_six_configurations_share_one_regional_request(self):
        config=json.loads((m.ROOT/'config.json').read_text())
        with patch.object(m.random,'choice',side_effect=AssertionError('must not sample')):
            products=m.select_products(config)
        self.assertEqual({p['name'] for p in products.values()}, {
            'iPhone Duo 256GB Star White','iPhone Duo 256GB Night Sky',
            'iPhone Duo 512GB Star White','iPhone Duo 512GB Night Sky',
            'iPhone Duo 1TB Star White','iPhone Duo 1TB Night Sky'})
        client=m.Client()
        with patch.object(client,'get',return_value='{}') as get:
            client.inventory_region(products,'07094')
        get.assert_called_once()
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(get.call_args.args[0]).query)
        self.assertEqual(query['location'],['07094'])
        self.assertEqual({v[0] for k,v in query.items() if k.startswith('parts.')},set(products))

    def test_unrouted_one_tb_still_sends_telegram_but_not_mac(self):
        catalog=json.loads((m.ROOT/'catalog.json').read_text())
        for sku in ['MK1J4LL/A','MK1L4LL/A']:
            with self.subTest(sku=sku),tempfile.TemporaryDirectory() as path:
                product=catalog[sku]
                offer={'sku':sku,**product,'store_id':'R755','store':'Apple American Dream',
                       'state':'NJ','date':TODAY.isoformat(),'quote':'Available Today'}
                config={'mac_forward_skus':['MK1E4LL/A','MK1F4LL/A','MK1G4LL/A','MK1H4LL/A']}
                with patch.object(m,'telegram') as telegram,patch('pickup_bridge.enqueue_confirmed_offer') as bridge:
                    m.notify_offer(offer,config,{},Path(path),False,set())
                telegram.assert_called_once();self.assertIn(product['name'],telegram.call_args.args[0])
                bridge.assert_not_called()

    def test_one_tb_forwards_once_when_mac_route_enabled(self):
        catalog=json.loads((m.ROOT/'catalog.json').read_text())
        for sku in ['MK1J4LL/A','MK1L4LL/A']:
            with self.subTest(sku=sku),tempfile.TemporaryDirectory() as path:
                offer={'sku':sku,**catalog[sku],'store_id':'R755','store':'Apple American Dream',
                       'state':'NJ','date':TODAY.isoformat(),'quote':'Available Today'}
                with patch.object(m,'telegram') as telegram,patch('pickup_bridge.enqueue_confirmed_offer') as bridge:
                    m.notify_offer(offer,{'mac_forward_skus':[sku]}, {},Path(path),False,set())
                telegram.assert_called_once();bridge.assert_called_once()
                self.assertEqual(bridge.call_args.args[0]['sku'],sku)
                self.assertIn('-1tb-',bridge.call_args.args[0]['url'])
                self.assertNotIn('1024gb',bridge.call_args.args[0]['url'])

    def test_explicit_batch_rejects_missing_duplicate_or_empty_skus(self):
        for skus in [[],['missing'],['DUO','DUO'],'DUO',[None]]:
            with self.assertRaises(m.QueryError):
                m.select_products({'products':PRODUCTS,'selection':{'skus':skus}})

    def test_fixed_white_plus_each_random_variant(self):
        catalog=json.loads((m.ROOT/'catalog.json').read_text())
        config={'products':catalog,'selection':{'fixed_sku':'MK1E4LL/A'}}
        for extra in catalog:
            if extra == 'MK1E4LL/A': continue
            with patch.object(m.random,'choice',return_value=extra) as choice:
                selected=m.select_products(config)
                self.assertEqual(list(selected),['MK1E4LL/A',extra])
                self.assertNotIn('MK1E4LL/A',choice.call_args.args[0])
                self.assertEqual(len(choice.call_args.args[0]),7)
        with self.assertRaises(m.QueryError):
            m.select_products({'products':PRODUCTS,'selection':{'fixed_sku':'missing'}})

    def test_cycle_only_requests_selected_two(self):
        catalog=json.loads((m.ROOT/'catalog.json').read_text())
        config={'products':catalog,'selection':{'fixed_sku':'MK1E4LL/A'},'stores':{'R001':{}},'max_pickup_days':3,'interval_seconds':60,'request_gap_seconds':5}
        class Fake:
            def __init__(self): self.calls=[]
            def inventory(self,sku,stores):
                self.calls.append(sku)
                return payload(display='unavailable')
        client=Fake();state={}
        with tempfile.TemporaryDirectory() as path, patch.object(m.random,'choice',return_value='MK1R4LL/A'), patch.object(m.time,'sleep'):
            m.run_cycle(client,config,state,Path(path),dry_run=True)
        self.assertEqual(client.calls,['MK1E4LL/A','MK1R4LL/A'])
        self.assertEqual(state['selected_skus'],client.calls)
        self.assertEqual(set(state['coverage']),set(client.calls))

    def test_morning_window_boundaries_and_timezone(self):
        config={'interval_seconds':60,'morning_peak':{'start':'07:55','end':'08:15','interval_seconds':20}}
        for hour,minute,expected in [(7,54,60),(7,55,20),(8,0,20),(8,14,20),(8,15,60)]:
            at=dt.datetime(2026,10,25,hour,minute,tzinfo=m.TZ)
            self.assertEqual(m.polling_interval(config,at),expected)
        utc=dt.datetime(2026,10,25,12,0,tzinfo=dt.timezone.utc)
        self.assertEqual(m.polling_interval(config,utc),20)

    def test_alert_precedes_second_query_and_opens_once_per_model(self):
        catalog=json.loads((m.ROOT/'catalog.json').read_text())
        config={'products':catalog,'selection':{'fixed_sku':'MK1E4LL/A'},'stores':{'R001':{}},'max_pickup_days':3,'interval_seconds':60,'request_gap_seconds':5,'auto_open_product_page':True}
        events=[]
        class Fake:
            def inventory(self,sku,stores):
                events.append('query:'+sku)
                p=payload(display='available' if sku=='MK1E4LL/A' else 'unavailable')
                p['body']['content'][0]['pickupEncodedUpperDateString']=dt.datetime.now(m.TZ).strftime('%Y%m%d')
                return p
        state={}
        with tempfile.TemporaryDirectory() as path, patch.object(m.random,'choice',return_value='MK1F4LL/A'), patch.object(m.time,'sleep'), patch.object(m,'telegram',side_effect=lambda message:events.append('alert')), patch.object(m,'open_product_page',side_effect=lambda url:events.append('open')):
            m.run_cycle(Fake(),config,state,Path(path))
            self.assertTrue((Path(path)/'availability-events.jsonl').exists())
        self.assertEqual(events,['query:MK1E4LL/A','alert','open','query:MK1F4LL/A'])

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
        self.assertFalse(m.should_alert(offer,{'sent_episodes':{m.offer_key(offer):1900}},2000))
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
