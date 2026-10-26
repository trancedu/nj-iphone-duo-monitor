"""Cross-language dry-run smoke test: Python outbox -> real Node HTTP receiver."""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pickup_bridge import Bridge

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipUnless(shutil.which('node'), 'Node >=22 required for cross-language smoke test')
class ReceiverIntegrationTests(unittest.TestCase):
    def test_python_to_node_dry_run_and_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            config = json.loads((ROOT/'mac_receiver/receiver.example.json').read_text())
            config.update(port=port, state_dir=str(root/'state'), profile_dir=str(root/'profile'), allowed_sources=['127.0.0.1'])
            file = root/'receiver.json'; file.write_text(json.dumps(config))
            secret = 'test-only-cross-language-secret-'*2
            env = {**os.environ, 'PICKUP_SHARED_SECRET':secret}
            process = subprocess.Popen(['node',str(ROOT/'mac_receiver/server.mjs'),'--config',str(file)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                self.assertIn('listening', process.stdout.readline())
                notices=[]
                bridge=Bridge({'endpoint':f'http://127.0.0.1:{port}/prepare'},secret,root,notices.append,autostart=False)
                offer={'observed_at':dt.datetime.now(dt.timezone.utc).isoformat(),'sku':'test','store_id':'R755','date':'2026-10-26',
                       'url':'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-black-unlocked'}
                now=time.time();event_id=bridge.persist(offer,now);bridge.tick(now)
                # Request status through the same authenticated transport; it follows the POST on the server event loop.
                code,result=bridge.request('GET',event_id)
                self.assertEqual(code,200);self.assertEqual(result['status'],'dry_run_completed')
                bridge.tick(now+6)
                with bridge.connect() as db:
                    payload=json.loads(db.execute('SELECT payload FROM events').fetchone()[0])
                    self.assertEqual(db.execute('SELECT phase FROM events').fetchone()[0],'done')
                code,duplicate=bridge.request('POST',event_id,payload)
                self.assertEqual(code,200);self.assertEqual(duplicate['status'],'dry_run_completed')
                self.assertEqual(notices,[])
                self.assertFalse((root/'profile').exists())
                times=result['timestamps'];self.assertIn('received_at',times);self.assertIn('finished_at',times)
                def cli(action,*args):
                    result=subprocess.run([sys.executable,str(ROOT/'bridge_client.py'),action,*args],env=env,cwd=ROOT,capture_output=True,text=True,timeout=5,check=True)
                    return json.loads(result.stdout)
                endpoint=f'http://127.0.0.1:{port}'
                self.assertEqual(cli('health','--endpoint',endpoint)['mode'],'dry_run')
                event_file=str(root/'client-event.local.json')
                cli('make-event','--event',event_file,'--event-id','client-test','--url',offer['url'])
                cli('prepare','--endpoint',endpoint,'--event',event_file)
                self.assertEqual(cli('status','--endpoint',endpoint,'--event',event_file)['status'],'dry_run_completed')
                self.assertEqual(cli('prepare','--endpoint',endpoint,'--event',event_file)['status'],'dry_run_completed')
            finally:
                process.terminate()
                try:process.communicate(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.communicate()
