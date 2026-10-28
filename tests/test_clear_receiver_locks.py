import datetime as dt
import contextlib
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from deploy import clear_receiver_locks as cleaner
from deploy.clear_receiver_locks import expired_owner


class ExpiredOwnerTests(unittest.TestCase):
    def test_exact_sixty_second_boundary_and_owner_identity(self):
        claimed = dt.datetime(2026, 10, 27, 14, 0, tzinfo=dt.timezone.utc)
        gate = {'event_id': 'first', 'claimed_at': claimed.isoformat()}
        config = {'global_lock_timeout_seconds': 60}
        self.assertFalse(expired_owner(config, gate, 'first', claimed + dt.timedelta(seconds=59)))
        self.assertTrue(expired_owner(config, gate, 'first', claimed + dt.timedelta(seconds=60)))
        self.assertFalse(expired_owner(config, gate, 'new-owner', claimed + dt.timedelta(seconds=90)))

    def test_disabled_missing_invalid_and_future_claims_never_reset(self):
        now = dt.datetime.now(dt.timezone.utc)
        config = {'global_lock_timeout_seconds': 60}
        for gate in [{}, {'event_id': 'first'}, {'event_id': 'first', 'claimed_at': 'bad'},
                     {'event_id': 'first', 'claimed_at': (now + dt.timedelta(seconds=60)).isoformat()}]:
            self.assertFalse(expired_owner(config, gate, 'first', now))
        self.assertFalse(expired_owner({}, {'event_id': 'first', 'claimed_at': now.isoformat()}, 'first', now))

    def test_available_marker_prevents_cleanup_even_after_deadline(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)/'events.json'
            state.write_text(json.dumps({'events':{'found':{'status':'manual_review','timestamps':{'pickup_stock_found_at':'2026-10-27T10:00:00Z'}}}}))
            config={'global_lock_timeout_seconds':60,'slots':[{'state_dir':folder}]}
            self.assertFalse(expired_owner(config,{'event_id':'found','claimed_at':'2026-10-27T09:00:00Z'},'found',dt.datetime(2026,10,27,12,tzinfo=dt.timezone.utc)))
            config['protect_stock_from_timeout'] = False
            self.assertTrue(expired_owner(config,{'event_id':'found','claimed_at':'2026-10-27T09:00:00Z'},'found',dt.datetime(2026,10,27,12,tzinfo=dt.timezone.utc)))


class AutomaticCleanupTests(unittest.TestCase):
    def exercise(self, restore_ok=True, replace_owner=False, hard=False):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / 'receiver'
            root.mkdir()
            node = home / 'node'
            node.touch()
            gate_dir = root / 'runtime-router'
            gate_dir.mkdir()
            gate = gate_dir / 'global-lock.json'
            gate.write_text(json.dumps({'event_id': 'expired', 'claimed_at': (dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=90)).isoformat()}))
            slots = []
            for label in 'AB':
                state_dir = root / 'runtime-profiles' / label
                state_dir.mkdir(parents=True)
                state = {'active': 'expired' if label == 'B' else None, 'events': {}}
                if label == 'B':
                    state['events']['expired'] = {'event_id': 'expired', 'status': 'running', 'fingerprint': 'retained', 'timestamps': {}}
                (state_dir/'events.json').write_text(json.dumps(state))
                slots.append({'label': label, 'state_dir': str(state_dir)})
            untouched = (root/'runtime-profiles/A/events.json').read_bytes()
            config = root / 'receiver.router.local.json'
            config.write_text(json.dumps({'slots': slots, 'state_dir': str(gate_dir), 'global_lock_timeout_seconds': 60, 'protect_stock_from_timeout': not hard}))
            plist = home / 'Library/LaunchAgents/com.trancedu.apple-pickup-router.plist'
            plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({'ProgramArguments': [str(node), '--config', str(config)]}))
            running = False
            restores = []

            def run(argv, **kwargs):
                nonlocal running
                if argv[:2] == ['launchctl', 'kill']:
                    running = False
                    if replace_owner:
                        gate.write_text(json.dumps({'event_id': 'new-owner', 'claimed_at': dt.datetime.now(dt.timezone.utc).isoformat()}))
                if argv[:2] == ['launchctl', 'kickstart']:
                    running = True
                if argv[:2] == ['launchctl', 'print']:
                    return subprocess.CompletedProcess(argv, 0, 'state = running' if running else 'state = not running', '')
                if argv[0] == str(node):
                    if hard:
                        self.assertIsNone(json.loads(gate.read_text())['event_id'])
                        self.assertIsNone(json.loads((root/'runtime-profiles/B/events.json').read_text())['active'])
                    restores.append(argv[-1])
                    body = [{'slot': 'B', 'restored': restore_ok, 'reason': 'fixture_failure' if not restore_ok else None}]
                    return subprocess.CompletedProcess(argv, 0, json.dumps(body), '')
                return subprocess.CompletedProcess(argv, 0, '', '')

            with patch.object(cleaner.Path, 'home', return_value=home), patch.object(cleaner.subprocess, 'run', side_effect=run), patch.object(cleaner.sys, 'argv', ['clear', '--expired-event', 'expired']), contextlib.redirect_stdout(io.StringIO()):
                result = cleaner.main()
            state = json.loads((root/'runtime-profiles/B/events.json').read_text())
            self.assertTrue(running)
            self.assertEqual((root/'runtime-profiles/A/events.json').read_bytes(), untouched)
            if replace_owner:
                self.assertEqual(restores, [])
                self.assertEqual(json.loads(gate.read_text())['event_id'], 'new-owner')
                self.assertEqual(state['active'], 'expired')
            else:
                self.assertEqual(restores, ['B'])
                self.assertIsNone(state['active'])
                self.assertIsNone(json.loads(gate.read_text())['event_id'])
                self.assertEqual(state['events']['expired']['fingerprint'], 'retained')
                self.assertEqual(state['events']['expired']['status'], 'lock_timeout_returned' if restore_ok else 'lock_timeout')
                self.assertEqual(result, 0 if restore_ok else 1)

    def test_expired_task_stops_restores_only_its_profile_and_resumes(self):
        self.exercise()

    def test_restore_failure_still_releases_expired_lock_and_resumes(self):
        self.exercise(restore_ok=False)

    def test_changed_owner_is_never_cleared_by_an_old_timer(self):
        self.exercise(replace_owner=True)

    def test_hard_deadline_clears_before_browser_restore(self):
        self.exercise(hard=True)

    def test_hard_deadline_stays_unlocked_even_when_browser_restore_fails(self):
        self.exercise(hard=True, restore_ok=False)


class SixWindowCleanupTests(unittest.TestCase):
    def test_manual_cleanup_cancels_all_six_including_one_tb_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);root=home/'receiver';root.mkdir()
            node=home/'node';node.touch();gate=root/'gate';gate.mkdir()
            (gate/'global-lock.json').write_text(json.dumps({'event_id':'active-F'}))
            slots=[]
            for label in 'ABCDEF':
                folder=root/label;folder.mkdir()
                (folder/'events.json').write_text(json.dumps({'active':'active-'+label,'events':{
                    'active-'+label:{'status':'running','timestamps':{}},
                    'waiting-'+label:{'status':'global_waiting','timestamps':{}}}}))
                slots.append({'label':label,'state_dir':str(folder)})
            config=root/'receiver.router.local.json'
            config.write_text(json.dumps({'slots':slots,'state_dir':str(gate),'standby_page':'pickup_checkout','pickup_zip':'07094'}))
            plist=home/'Library/LaunchAgents/com.trancedu.apple-pickup-router.plist';plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({'ProgramArguments':[str(node),'--config',str(config)]}))
            running=False
            def run(argv,**kwargs):
                nonlocal running
                if argv[:2]==['launchctl','kill']:running=False
                if argv[:2]==['launchctl','kickstart']:running=True
                if argv[:2]==['launchctl','print']:return subprocess.CompletedProcess(argv,0,'state = running' if running else '', '')
                if argv[0]==str(node):
                    self.assertEqual(kwargs['timeout'],450)
                    return subprocess.CompletedProcess(argv,0,json.dumps([{'slot':s['label'],'restored':True} for s in slots]),'')
                return subprocess.CompletedProcess(argv,0,'','')
            output=io.StringIO()
            with patch.object(cleaner.Path,'home',return_value=home),patch.object(cleaner.subprocess,'run',side_effect=run),patch.object(cleaner.sys,'argv',['clear']),contextlib.redirect_stdout(output):
                self.assertEqual(cleaner.main(),0)
            for slot in slots:
                state=json.loads((Path(slot['state_dir'])/'events.json').read_text())
                self.assertIsNone(state['active'])
                self.assertEqual(state['events']['waiting-'+slot['label']]['status'],'expired')
                self.assertEqual(state['events']['active-'+slot['label']]['status'],'interrupted')
            self.assertIsNone(json.loads((gate/'global-lock.json').read_text())['event_id'])
            self.assertTrue(running)
            self.assertIn('全部 6 个窗口（A、B、C、D、E、F）',output.getvalue())
            self.assertIn('6/6',output.getvalue())


class RestoreDestinationTests(unittest.TestCase):
    def test_node_restore_requires_verified_pickup_and_zip_for_every_slot(self):
        import shutil
        node=shutil.which('node')
        if not node:self.skipTest('node unavailable')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'safari').mkdir()
            slots=[{'label':label,'safari_profile':'Profile'+label,'product_url':'url-'+label} for label in 'ABCDEF']
            cfg={'browser_backend':'safari','standby_page':'pickup_checkout','pickup_zip':'07094','slots':slots}
            (root/'receiver.router.local.json').write_text(json.dumps(cfg))
            (root/'protocol.mjs').write_text('export const expectedProduct=url=>url;')
            (root/'safari/shopping.mjs').write_text("""
import {readFileSync,appendFileSync} from 'node:fs';
const root=process.argv[1];
const cfg=JSON.parse(readFileSync(root+'/receiver.router.local.json'));
export const listSafariWindows=async()=>cfg.slots.map((s,i)=>({id:i,name:s.safari_profile+' — Bag',tabs:1}));
export const waitFor=async fn=>{const value=await fn();if(!value)throw Error('not_ready');return value;};
export class SafariWindow{
 constructor(id){this.id=id;this.pickup=(cfg.initialReady||[]).includes(id);}
 async goto(){appendFileSync(root+'/navigated',String(this.id)+'\\n');this.pickup=false;}
 async call(op){
  if(op==='snapshot')return {url:'https://www.apple.com/shop/bag',ready:'complete',bag:[{title:cfg.slots[this.id].product_url,quantity:'1'}]};
  if(op==='standbyState')return {ready:this.pickup,matching_product:true,checkout:true,pickup_ready:this.pickup,protected:false,expired:false,pickup_selected:this.pickup};
  if(op==='locationState')return {displayed_zip:cfg.badZip&&this.id===5?'00000':'07094'};
 }
}
export const prepareSafariStandby=async(w,url,config)=>{
 if(config.open_apple_pay_sheet!==false)throw Error('payment_not_disabled');
 w.pickup=true;appendFileSync(root+'/prepared',url+'\\n');return {status:'standby_checkout'};
};
""")
            run=lambda:subprocess.run([node,'--input-type=module','-e',cleaner.RESTORE,str(root)],capture_output=True,text=True,check=True)
            rows=json.loads(run().stdout)
            self.assertEqual(len(rows),6)
            self.assertTrue(all(r['restored'] and r['page']=='pickup_checkout' and r['zip']=='07094' for r in rows))
            cfg['badZip']=True;(root/'receiver.router.local.json').write_text(json.dumps(cfg))
            rows=json.loads(run().stdout)
            self.assertTrue(all(r['restored'] for r in rows[:5]))
            self.assertFalse(rows[5]['restored'])
            self.assertEqual(rows[5]['reason'],'pickup_standby_not_verified')
            # Five ready pages are never navigated or passed through checkout again.
            cfg.pop('badZip');cfg['initialReady']=[0,1,2,3,4]
            (root/'receiver.router.local.json').write_text(json.dumps(cfg))
            (root/'navigated').unlink();(root/'prepared').unlink()
            rows=json.loads(run().stdout)
            self.assertTrue(all(r.get('unchanged') for r in rows[:5]))
            self.assertFalse(rows[5].get('unchanged',False))
            self.assertEqual((root/'navigated').read_text().splitlines(),['5'])
            self.assertEqual((root/'prepared').read_text().splitlines(),['url-F'])
            # When all six are ready, the restore must perform zero navigations/checkouts.
            cfg['initialReady']=list(range(6));(root/'receiver.router.local.json').write_text(json.dumps(cfg))
            (root/'navigated').unlink();(root/'prepared').unlink()
            rows=json.loads(run().stdout)
            self.assertTrue(all(r.get('unchanged') for r in rows))
            self.assertFalse((root/'navigated').exists());self.assertFalse((root/'prepared').exists())



if __name__ == '__main__':
    unittest.main()
