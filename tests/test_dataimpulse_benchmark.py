import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import monitor as m
import dataimpulse_benchmark as b


class BenchmarkTests(unittest.TestCase):
    def test_window_gap_excludes_drain_but_reports_unfinished_end_gap(self):
        def row(t):return {'result':'http_200','started_epoch':t-1,'completed_epoch':t,'elapsed_seconds':1,'response_body_bytes':0}
        stats=b.active_window_summary([row(1),row(3),row(12)],'1970-01-01T00:00:00Z',5)
        self.assertEqual(stats['max_success_gap_seconds'],2)
        self.assertEqual(stats['end_without_new_success_seconds'],2)
        self.assertEqual(stats['drained_after_window'],1)

    def test_series_is_sequential_equal_duration_and_respects_global_backoff(self):
        calls=[]
        def runner(env,cfg,output,**kwargs):
            calls.append(kwargs)
            return {'queries':1,'counts':{'http_200':1},'response_body_bytes':10,'stop_reason':None}
        with tempfile.TemporaryDirectory() as path,patch('builtins.print'):
            result=b.run_series({}, {},Path(path)/'series',duration=2,runner=runner)
        self.assertEqual([c['spacing'] for c in calls],[2,1.5,1])
        self.assertEqual([c['duration'] for c in calls],[2,2,2])
        self.assertEqual(result['response_body_bytes'],30)
        calls.clear()
        def blocked(*args,**kwargs):
            calls.append(kwargs);return {'queries':1,'counts':{'http_429':1},'response_body_bytes':0,'stop_reason':'server_backoff'}
        with tempfile.TemporaryDirectory() as path,patch('builtins.print'):
            result=b.run_series({}, {},Path(path)/'series',duration=2,runner=blocked)
        self.assertEqual(len(calls),1);self.assertEqual(result['stop_reason'],'server_backoff')

    def test_summary_sorts_completion_and_distinguishes_gap_from_duration(self):
        rows=[{'result':'http_200','started_epoch':2,'completed_epoch':5,'elapsed_seconds':3,'response_body_bytes':10},
              {'result':'http_541','started_epoch':4,'completed_epoch':4.5,'elapsed_seconds':.5,'response_body_bytes':0},
              {'result':'http_200','started_epoch':0,'completed_epoch':1,'elapsed_seconds':1,'response_body_bytes':20}]
        s=b.summarize(rows)
        self.assertEqual(s['mean_success_gap_seconds'],4);self.assertEqual(s['mean_start_gap_seconds'],2)
        self.assertEqual(s['counts'],{'http_200':2,'http_541':1});self.assertEqual(s['response_body_bytes'],30)

    def test_benchmark_is_finite_and_never_notifies(self):
        calls=[]
        def fake(*args):
            now=time.time();calls.append(now)
            return {'result':'http_200','started_epoch':now,'completed_epoch':now,'elapsed_seconds':0,'response_body_bytes':1}
        with tempfile.TemporaryDirectory() as path,patch.object(m,'telegram') as tg,patch('pickup_bridge.enqueue_confirmed_offer') as bridge:
            report=b.benchmark({}, {},Path(path)/'run',duration=.09,spacing=.03,workers=2,request=fake)
            tg.assert_not_called();bridge.assert_not_called()
        # A loaded machine may legitimately dispatch fewer before the deadline;
        # it must never catch up with extra requests or exceed the finite cap.
        self.assertGreaterEqual(len(calls),1);self.assertLessEqual(len(calls),3)
        self.assertEqual(report['status'],'completed')
        self.assertTrue(all(y-x>=.029 for x,y in zip(calls,calls[1:])))

    def test_retry_after_stops_new_dispatch_without_sending_notifications(self):
        def fake(*args):
            return {'result':'http_429','retry_after_seconds':60,'started_epoch':0,'completed_epoch':1,'elapsed_seconds':1,'response_body_bytes':0}
        with tempfile.TemporaryDirectory() as path:
            report=b.benchmark({}, {},Path(path)/'run',duration=.2,spacing=.03,request=fake)
        self.assertEqual(report['submitted'],1);self.assertEqual(report['stop_reason'],'server_backoff')

    def test_query_error_redacts_raw_exception(self):
        class Bad:
            def __init__(self,*args):raise ValueError('PRIVATE_PROXY_PASSWORD')
        report=b.query({}, {},'us','07094',client_factory=Bad)
        self.assertEqual(report['result'],'request_failed');self.assertNotIn('PRIVATE',json.dumps(report))

    def test_body_budget_stops_dispatch(self):
        def fake(*args):
            return {'result':'http_200','started_epoch':0,'completed_epoch':1,'elapsed_seconds':1,'response_body_bytes':100}
        with tempfile.TemporaryDirectory() as path:
            report=b.benchmark({}, {},Path(path)/'run',duration=.2,spacing=.03,max_bytes=50,request=fake)
        self.assertEqual(report['submitted'],1)
        self.assertEqual(report['stop_reason'],'body_budget_reached')

    def test_full_worker_does_not_queue_or_catch_up_in_a_burst(self):
        starts=[]
        def fake(*args):
            now=time.time();starts.append(now);time.sleep(.06)
            return {'result':'http_200','started_epoch':now,'completed_epoch':time.time(),'elapsed_seconds':.06,'response_body_bytes':0}
        with tempfile.TemporaryDirectory() as path:
            report=b.benchmark({}, {},Path(path)/'run',duration=.11,spacing=.02,workers=1,request=fake)
        self.assertEqual(len(starts),2)
        self.assertGreaterEqual(starts[1]-starts[0],.059)
