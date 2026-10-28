import unittest
import monitor as m
class EpisodeTests(unittest.TestCase):
    def offer(self):return {'name':'iPhone Duo 512GB Star White','store_id':'R755','sku':'white512','date':'2026-10-28'}
    def test_restock_immediately_alerts_but_continuous_stock_does_not(self):
        s={};pairs=[('R755','white512')]
        a=m.track_stock_episodes(s,[self.offer()],pairs,1)[0]
        s['sent_episodes']={a['stock_event_id']:1}
        b=m.track_stock_episodes(s,[self.offer()],pairs,2)[0]
        self.assertEqual(a['stock_event_id'],b['stock_event_id']);self.assertFalse(m.should_alert(b,s,999999))
        m.track_stock_episodes(s,[],pairs,3)
        c=m.track_stock_episodes(s,[self.offer()],pairs,4)[0]
        self.assertNotEqual(a['stock_event_id'],c['stock_event_id']);self.assertTrue(m.should_alert(c,s,4))
    def test_missing_observations_and_old_responses_do_not_close_episode(self):
        s={};pairs=[('R755','white512')]
        a=m.track_stock_episodes(s,[self.offer()],pairs,5)[0]
        m.track_stock_episodes(s,[],[],6)
        m.track_stock_episodes(s,[],pairs,4)
        b=m.track_stock_episodes(s,[self.offer()],pairs,7)[0]
        self.assertEqual(a['stock_event_id'],b['stock_event_id'])
    def test_validation_error_does_not_mutate_state(self):
        import proxy_monitor as p
        s={'stock_episodes':{'old':{'active':{'x':'y'}}}}
        import copy
        before=copy.deepcopy(s)
        with self.assertRaises(m.QueryError):p.parse_offers({}, {'sku':{}}, {'stores':[]}, '07094',s)
        self.assertEqual(s,before)
