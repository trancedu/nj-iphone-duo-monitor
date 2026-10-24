import json
import unittest
import watchdog as w

class WatchdogTests(unittest.TestCase):
    def good(self,now): return {'status':'healthy','last_cycle_at':now-5,'next_check_at':now+55}
    def test_dead_process_one_notice_persisted(self):
        sent=[];state={}
        for now in [10000,10060,10120,10180,14000,20000]:
            state=w.check(self.good(now),state,False,now,sent.append)
            state=json.loads(json.dumps(state))
        self.assertEqual(len(sent),1)
        self.assertTrue(state['outage_notified'])
    def test_recovery_needs_two_healthy_checks_sends_once(self):
        sent=[];state={'outage_notified':True,'bad_since':9000,'last_alert_at':10000,'next_send_attempt':10300}
        for now in [10400,10460,10520]: w.check(self.good(now),state,True,now,sent.append)
        self.assertEqual(len(sent),1)
        self.assertIn('已恢复',sent[0]);self.assertFalse(state['outage_notified'])
    def test_persistent_errors_wait_five_minutes(self):
        sent=[];state={}
        for now in [10000,10060,10120,10240,10300,11000]:
            monitor={'status':'degraded','last_cycle_at':now,'next_check_at':now+3600}
            w.check(monitor,state,True,now,sent.append)
            if now<10300: self.assertFalse(sent)
        self.assertEqual(len(sent),1)
    def test_notification_failure_retries_after_five_minutes(self):
        calls=[];state={}
        def fail(message): calls.append(message);raise OSError('test')
        for now in [10000,10120,10180,10300,10420]:
            w.check(self.good(now),state,False,now,fail)
        self.assertEqual(len(calls),2)
        self.assertFalse(state.get('outage_notified'))
        self.assertEqual(state['send_error'],'OSError')
    def test_new_outages_limited_to_one_per_hour(self):
        sent=[];state={'last_alert_at':10000}
        for now in [11000,11200,13000,13600]:
            w.check(self.good(now),state,False,now,sent.append)
        self.assertEqual(len(sent),1)
    def test_hang_detection_respects_expected_backoff(self):
        self.assertIsNone(w.assess({'status':'healthy','last_cycle_at':10000,'next_check_at':13600},True,12000))
        self.assertIn('卡住',w.assess({'status':'healthy','last_cycle_at':10000,'next_check_at':10060},True,10300))
        self.assertIn('进程',w.assess({},False,10000))

if __name__=='__main__': unittest.main()
