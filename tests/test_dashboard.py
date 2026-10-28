"""Availability evidence must never confuse a failed query with sold-out stock."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('dashboard_collector',ROOT/'dashboard/collector.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.sku='MK1E4LL/A';self.sid='R755'
        (self.root/'config.json').write_text(json.dumps({'products':{self.sku:{'name':'White 256GB'}},'max_pickup_days':3}))
        self.c=m.Collector(self.root)
    def tearDown(self):
        self.c.db.close();self.temp.cleanup()
    def query(self,identifier,result='http_200',offers=0,skus=None,covered=None,at=101,finished=102):
        self.c.db.execute('INSERT INTO queries VALUES (?,?,?,?,?,?,?,?,?)',(identifier,at,finished,result,finished-at,offers,json.dumps(skus if skus is not None else [self.sku]),json.dumps(covered if covered is not None else [self.sid]),'test'))
    def positive(self,identifier,t):
        self.c.db.execute('INSERT INTO positives VALUES (?,?,?,?,?,?,?,?)',(identifier,t,self.sid,self.sku,'2026-10-27','Apple American Dream','NJ','Today'))
    def test_failure_never_closes_stock(self):
        self.positive('p',100);self.query('error','http_541');self.query('network','network_error')
        self.assertIsNone(self.c.periods(110)[0]['end'])
    def test_empty_success_requires_matching_coverage_and_later_start(self):
        self.query('wrong-sku',skus=['OTHER']);self.query('wrong-store',covered=['OTHER']);self.query('older-inflight',at=99,finished=104)
        self.assertIsNone(self.c.absence(self.sid,self.sku,100,110))
        self.query('proof',at=105,finished=106)
        self.assertEqual(self.c.absence(self.sid,self.sku,100,110),{'t':106,'source':'query_empty'})
    def test_indexed_absence_matches_query_timing_and_direct_evidence(self):
        self.query('older',at=99,finished=104)
        self.query('wrong',covered=['OTHER'],at=101,finished=102)
        self.query('valid',at=105,finished=106)
        for before in [102,104,106,110]:
            self.assertEqual(self.c.absence(self.sid,self.sku,100,before),
                self.c.absence(self.sid,self.sku,100,before,self.c.absence_index()))
        self.c.db.execute('INSERT INTO negatives VALUES (?,?,?,?,?)',('n',105.5,self.sid,self.sku,'snapshot'))
        self.assertEqual(self.c.absence(self.sid,self.sku,100,110,self.c.absence_index()),
                         {'t':105.5,'source':'snapshot'})

    def test_restock_periods_split_only_with_absence_evidence(self):
        self.positive('a',100);self.positive('b',101);self.query('empty',at=102,finished=103);self.positive('c',105)
        periods=self.c.periods(110)
        self.assertEqual(len(periods),2);self.assertEqual(periods[1]['end'],103);self.assertEqual(periods[1]['last_seen'],101)
        self.assertIsNone(periods[0]['end'])
    def test_short_flicker_waves_keep_true_first_last_and_all_segments(self):
        self.positive('a',100);self.positive('b',110)
        self.query('first-end',at=111,finished=112)
        self.positive('c',120);self.positive('d',130)
        self.query('last-end',at=131,finished=132)
        periods=self.c.periods(140);waves=self.c.waves(periods)
        self.assertEqual(len(periods),2);self.assertEqual(len(waves),1)
        wave=waves[0]
        self.assertEqual((wave['start'],wave['last_seen'],wave['end']),(100,130,132))
        self.assertEqual(wave['elapsed_seconds'],32)
        # Visible conservative span excludes the final negative-confirmation delay.
        self.assertEqual(wave['observed_span_seconds'],30)
        self.assertEqual([p['observed_span_seconds'] for p in wave['segments']],[10,10])
        self.assertEqual(wave['segment_count'],2);self.assertEqual(wave['brief_unavailable_count'],1)
        self.assertEqual([p['segment_number'] for p in wave['segments']],[1,2])
        self.assertEqual(wave['historical_first_seen'],100)
    def test_long_gap_is_new_wave_but_keeps_historical_first(self):
        self.positive('a',100);self.query('first-end',at=101,finished=102)
        self.positive('b',300);self.query('second-end',at=301,finished=302)
        waves=self.c.waves(self.c.periods(310))
        self.assertEqual(len(waves),2);self.assertEqual(waves[0]['wave_number'],2)
        self.assertEqual(waves[0]['start'],300);self.assertEqual(waves[0]['historical_first_seen'],100)
    def test_unobserved_long_gap_is_not_continuous_stock_or_a_known_end(self):
        self.positive('a',100);self.positive('b',500)
        periods=self.c.periods(510);waves=self.c.waves(periods)
        self.assertEqual(len(periods),2);self.assertEqual(len(waves),2)
        self.assertEqual(periods[1]['end_reason'],'observation_gap')
        self.assertIsNone(periods[1]['end']);self.assertIsNone(periods[1]['elapsed_seconds'])
    def test_current_snapshot_does_not_bridge_old_unknown_period(self):
        self.positive('a',100)
        self.c.db.execute('INSERT INTO current VALUES (?,?,?,?,?,?,?,?,?,?)',
            (self.sid,self.sku,500,1,1,'2026-10-27','Today','Apple American Dream','NJ','East Rutherford'))
        periods=self.c.periods(510)
        self.assertEqual(len(periods),2);self.assertFalse(periods[1]['is_current']);self.assertTrue(periods[0]['is_current'])
        self.assertEqual(periods[1]['last_seen'],100);self.assertIsNone(periods[1]['end'])
    def test_waves_never_merge_different_store_or_configuration(self):
        self.positive('a',100);self.query('first-end',at=101,finished=102)
        self.c.db.execute('INSERT INTO positives VALUES (?,?,?,?,?,?,?,?)',
            ('other',105,'R095',self.sku,'2026-10-27','Apple Fifth Avenue','NY','Today'))
        self.assertEqual(len(self.c.waves(self.c.periods(110))),2)

    def test_incremental_ingest_ignores_incomplete_line_and_is_idempotent(self):
        directory=self.root/'runtime/proxy-monitor/20261027-000000';directory.mkdir(parents=True)
        (directory/'report.json').write_text('{"zip":"07094"}')
        path=directory/'queries.jsonl';line=json.dumps({'at':'2026-10-27T08:00:00-04:00','completed_at':'2026-10-27T08:00:01-04:00','result':'http_200','stores':12,'skus':[self.sku],'eligible_offers':0})
        path.write_text(line);self.c.ingest(path,'query');self.assertEqual(self.c.db.execute('SELECT count(*) FROM queries').fetchone()[0],0)
        with path.open('a') as f:f.write('\n')
        self.c.ingest(path,'query');self.c.ingest(path,'query');self.assertEqual(self.c.db.execute('SELECT count(*) FROM queries').fetchone()[0],1)
    def test_malformed_snapshot_is_unknown_not_negative(self):
        directory=self.root/'runtime/proxy-monitor/20261027-000000';directory.mkdir(parents=True)
        (directory.parent/'current.json').write_text(json.dumps({'output':str(directory),'zip':'07094','monitored_skus':[self.sku]}))
        (directory/'last-inventory.json').write_text('{"body":{"stores":[{"storeNumber":"R755"}]}}')
        self.c.snapshot();self.assertEqual(self.c.db.execute('SELECT count(*) FROM negatives').fetchone()[0],0)
    def test_export_whitelists_monitor_fields_and_sanitizes_text(self):
        self.c.monitor={'status':'running','secret':'never-export-this','proxy_url':'private'}
        result=self.c.export();self.assertNotIn('secret',result['monitor']);self.assertNotIn('proxy_url',result['monitor'])
        self.assertEqual(m.clean('<b>Available</b> &amp; today'),'Available & today')

if __name__=='__main__':unittest.main()
