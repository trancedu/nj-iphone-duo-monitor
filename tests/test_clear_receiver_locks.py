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


if __name__ == '__main__':
    unittest.main()
