import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import monitor as m

TODAY=dt.date(2026,10,24)

def retail(config,products,region,available=False):
    rows=[]
    for sid in region['expected_stores']:
        rows.append({'storeNumber':sid,'storeName':config['stores'][sid]['name'],'state':config['stores'][sid]['state'],
                     'partsAvailability':{sku:{'pickupDisplay':'available' if available else 'unavailable',
                       'pickupSearchQuote':'Available Today' if available else 'Currently unavailable',
                       'messageTypes':{'regular':{'storeSelectionEnabled':available,'storePickupQuote':'Today at Apple Test' if available else 'Currently unavailable'}}} for sku in products}})
    return {'body':{'location':region['zip'],'stores':rows}}

class RegionalTests(unittest.TestCase):
    def setUp(self):
        self.config=json.loads((m.ROOT/'config.json').read_text())
        self.products={sku:self.config['products'][sku] for sku in ['MK1E4LL/A','MK1G4LL/A']}
        self.region=self.config['regions'][0]
    def test_available_batch_preserves_sku_store_and_pickup_date(self):
        data=m.regional_payloads(retail(self.config,self.products,self.region,True),self.products,self.config['stores'],self.region,TODAY)
        for sku,payload in data.items():
            offers,count=m.parse_inventory(payload,{sku:self.products[sku]},TODAY,requested_stores=self.config['stores'])
            self.assertEqual(count,len(self.region['expected_stores']))
            self.assertEqual({o['sku'] for o in offers},{sku})
            self.assertEqual({o['date'] for o in offers},{'2026-10-24'})
    def test_ignored_location_missing_store_or_sku_fail_closed(self):
        original=retail(self.config,self.products,self.region)
        wrong=copy.deepcopy(original);wrong['body']['location']='wrong'
        missing_store=copy.deepcopy(original);missing_store['body']['stores'].pop()
        missing_sku=copy.deepcopy(original);missing_sku['body']['stores'][0]['partsAvailability'].pop('MK1G4LL/A')
        for payload in [wrong,missing_store,missing_sku]:
            with self.assertRaises(m.QueryError):m.regional_payloads(payload,self.products,self.config['stores'],self.region,TODAY)
    def test_fixed_pair_covers_all_22_stores_in_each_two_request_cycle(self):
        config=self.config
        class Fake:
            def __init__(self):self.calls=[]
            def inventory_region(self,products,zipcode):
                self.calls.append((zipcode,list(products)))
                region=next(r for r in config['regions'] if r['zip']==zipcode)
                return retail(config,products,region)
        client=Fake();state={}
        with tempfile.TemporaryDirectory() as path,patch.object(m.random,'choice',return_value='MK1G4LL/A'),patch.object(m.time,'sleep'):
            for _ in range(3):
                m.run_cycle(client,config,state,Path(path),dry_run=True)
                self.assertEqual(set(state['coverage']['MK1E4LL/A']['returned_stores']),set(config['stores']))
        self.assertEqual(len(client.calls),6)
        self.assertTrue(all(skus==config['selection']['skus'] for _,skus in client.calls))
        self.assertEqual(set(state['coverage_history']['MK1E4LL/A']),set(config['stores']))
        self.assertEqual(state['fresh_coverage_counts']['MK1E4LL/A'],22)
        self.assertEqual([z for z,_ in client.calls],['07078','11530']*3)
    def test_real_captured_responses_cover_all_22(self):
        # Captures are local commissioning evidence, never needed by CI.
        covered=set()
        for region in self.config['regions']:
            path=m.ROOT/'runtime/coverage-investigation'/('retail-'+region['name']+'.json')
            if not path.exists():self.skipTest('commissioning captures not present')
            raw=json.loads(path.read_text())
            products={'MK1E4LL/A':self.products['MK1E4LL/A']}
            normalized=m.regional_payloads(raw,products,self.config['stores'],region,TODAY)
            covered.update(r['storeId'] for r in normalized['MK1E4LL/A']['body']['content'])
        self.assertEqual(covered,set(self.config['stores']))

    def test_environment_zip_replaces_all_configured_regions(self):
        calls=[]
        class Fake:
            def inventory_region(inner,products,zipcode):
                calls.append(zipcode)
                return {'body':{'location':zipcode,'stores':[{
                    'storeNumber':'R-CA','storeName':'Test California','state':'CA',
                    'partsAvailability':{sku:{'pickupDisplay':'unavailable',
                        'pickupSearchQuote':'Currently unavailable',
                        'messageTypes':{'regular':{'storeSelectionEnabled':False,
                            'storePickupQuote':'Currently unavailable'}}} for sku in products}}]}}
        state={}
        with tempfile.TemporaryDirectory() as path,patch.dict(m.os.environ,{'APPLE_PICKUP_ZIP':'94596'}),patch.object(m.time,'sleep') as sleep:
            m.run_cycle(Fake(),self.config,state,Path(path),dry_run=True)
            sleep.assert_not_called()
        self.assertEqual(calls,['94596'])
        self.assertEqual(state['regions_checked'],['94596'])
        self.assertEqual(state['status'],'healthy')
        self.assertEqual(state['coverage']['MK1E4LL/A']['states'],['CA'])

    def test_invalid_environment_zip_fails_before_querying(self):
        with patch.dict(m.os.environ,{'APPLE_PICKUP_ZIP':'9459'}):
            with self.assertRaisesRegex(m.QueryError,'invalid_pickup_zip'):
                m.select_regions(self.config,{})

if __name__=='__main__':unittest.main()
