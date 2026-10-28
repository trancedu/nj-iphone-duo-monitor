import datetime as dt
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import local_stock_audio as audio

class SpeechTests(unittest.TestCase):
    def offer(self,name='iPhone Duo 256GB Night Sky',**extra):
        return {'name':name,'sku':'black256','store_id':'R755','date':'2026-10-27',
                'observed_at':dt.datetime.now(dt.timezone.utc).isoformat(),**extra}
    def test_six_short_phrases_and_no_other_models(self):
        for name,phrase in [('256GB Night Sky','二五六黑'),('256GB Star White','二五六白'),('512GB Night Sky','五一二黑'),('512GB Star White','五一二白'),('1TB Night Sky','一T黑'),('1TB Star White','一T白')]:
            self.assertEqual(audio.phrase_for(self.offer('iPhone Duo '+name)),phrase)
        self.assertIsNone(audio.phrase_for(self.offer('iPhone 18 Pro 256GB Night Sky')))
        self.assertIsNone(audio.phrase_for(self.offer('iPhone Duo 2TB Night Sky')))
    def test_submit_does_not_wait_for_speech_and_coalesces_other_stores(self):
        entered=threading.Event();release=threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            def play(*args):entered.set();release.wait(2)
            cfg={'max_age_seconds':10,'dedup_seconds':1800,'phrase_cooldown_seconds':15}
            s=audio.Speaker(cfg,Path(directory)/'state.json',play=play)
            started=time.monotonic();self.assertTrue(s.submit(self.offer()))
            self.assertLess(time.monotonic()-started,.1);self.assertTrue(entered.wait(1))
            self.assertFalse(s.submit(self.offer()));self.assertFalse(s.submit(self.offer(store_id='R095')))
            self.assertFalse(s.submit(self.offer(observed_at='2020-01-01T00:00:00+00:00')))
            release.set();s.pending.join()
            persisted=json.loads((Path(directory)/'state.json').read_text());self.assertIn('R755|black256|2026-10-27',persisted)
            s2=audio.Speaker(cfg,Path(directory)/'state.json',play=lambda *args:None)
            self.assertFalse(s2.submit(self.offer()))
    def test_tail_skips_history_and_handles_partial_line(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'events.jsonl';path.write_text('{"old":true}\n')
            tail=audio.Tail(path);self.assertEqual(list(tail.read()),[])
            with path.open('a') as f:f.write('{"new":true}')
            self.assertEqual(list(tail.read()),[])
            with path.open('a') as f:f.write('\n')
            self.assertEqual(list(tail.read()),[{'new':True}]);self.assertEqual(list(tail.read()),[])
    def test_audio_uses_named_physical_output_and_no_shell(self):
        with patch.object(audio.subprocess,'run') as run:
            run.return_value.returncode=0
            audio.speak('五一二白',{'audio_device':'Mac mini Speakers','voice':'Tingting','rate':300})
            self.assertEqual(run.call_args.args[0],['/usr/bin/say','-a','Mac mini Speakers','-v','Tingting','-r','300','五一二白'])
            self.assertNotIn('shell',run.call_args.kwargs)

if __name__=='__main__':unittest.main()
