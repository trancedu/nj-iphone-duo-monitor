#!/usr/bin/env python3
"""Cancel old requests, restore the active backend's bags, unlock and resume."""
import datetime as dt
import argparse
import fcntl
import json
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = None
JOB = f'gui/{os.getuid()}/com.trancedu.apple-pickup-router'


def job_running():
    r = subprocess.run(['launchctl', 'print', JOB], capture_output=True, text=True, timeout=5)
    return r.returncode == 0 and 'state = running' in r.stdout


def save(path, value):
    tmp = path.with_suffix('.clear-locks.tmp')
    with tmp.open('w') as f:
        os.chmod(tmp, 0o600)
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


RESTORE = r'''
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.argv[1];
const {SafariWindow,listSafariWindows,waitFor}=await import(pathToFileURL(root+'/safari/shopping.mjs'));
const {expectedProduct}=await import(pathToFileURL(root+'/protocol.mjs'));
const cfg=JSON.parse(readFileSync(root+'/receiver.router.local.json'));
const onlySlot=process.argv[2]||null;
const windows=cfg.browser_backend==='safari'?await listSafariWindows():[],results=[];
for(const slot of cfg.slots){
  if(onlySlot&&slot.label!==onlySlot)continue;
  try{
    if(cfg.browser_backend!=='safari'){
      const {PickupBrowser}=await import(pathToFileURL(root+'/browser.mjs'));
      const browser=new PickupBrowser({...cfg,slots:undefined,cdp_endpoint:slot.cdp_endpoint,auto_clear_bag:false,warm_product_pages:false});
      await browser.start();
      if(new URL(browser.page.url()).pathname!=='/shop/bag')await browser.goto('https://www.apple.com/shop/bag');
      if(await browser.bag({product_url:slot.product_url})!=='same_one')throw Error('bag_not_exactly_one_target');
      results.push({slot:slot.label,restored:true});continue;
    }
    const matches=windows.filter(w=>w.name.startsWith(slot.safari_profile+' — '));
    if(matches.length!==1||matches[0].tabs!==1)throw Error('profile_window_missing_or_ambiguous');
    const window=new SafariWindow(matches[0].id,slot.safari_profile);
    await window.goto('https://www.apple.com/shop/bag');
    const snapshot=await waitFor(async()=>{
      const s=await window.call('snapshot');
      return new URL(s.url).pathname==='/shop/bag'&&s.ready==='complete'&&(s.bag.length||s.empty)?s:null;
    },15000,500);
    if(snapshot.bag.length!==1||snapshot.bag[0].title!==expectedProduct(slot.product_url)||snapshot.bag[0].quantity!=='1')throw Error('bag_not_exactly_one_target');
    results.push({slot:slot.label,restored:true});
  }catch(e){results.push({slot:slot.label,restored:false,reason:e.code||e.message||'restore_failed'});}
}
console.log(JSON.stringify(results));
process.exit(0); // Disconnect CDP without closing Chrome.
'''


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expired-event', help='Automatic timeout: cancel only this still-expired lock owner')
    args = parser.parse_args()
    plist = Path.home() / 'Library/LaunchAgents/com.trancedu.apple-pickup-router.plist'
    argv = plistlib.loads(plist.read_bytes())['ProgramArguments']
    ROOT = Path(argv[argv.index('--config') + 1]).parent
    if not (ROOT / 'receiver.router.local.json').is_file():
        raise RuntimeError('receiver_config_not_found')
    with (ROOT / 'clear-locks.guard').open('a') as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('已有清锁任务在执行，请勿重复点击。')
            return 1
        cfg = json.loads((ROOT / 'receiver.router.local.json').read_text())
        gate_dir = Path(cfg['state_dir'])
        if not gate_dir.is_absolute():
            gate_dir = ROOT / gate_dir
        gate = gate_dir / 'global-lock.json'
        if args.expired_event:
            lock = json.loads(gate.read_text()) if gate.exists() else {}
            if not expired_owner(cfg, lock, args.expired_event):
                print('超时锁已变更或尚未到期；未操作页面。')
                return 0
        print('暂停接收，取消旧排队请求……', flush=True)
        subprocess.run(['launchctl', 'kill', 'SIGTERM', JOB], capture_output=True, timeout=5)
        for _ in range(50):
            if not job_running():
                break
            time.sleep(.1)
        else:
            raise RuntimeError('receiver_did_not_stop')
        backup = ROOT.parent / 'deployment-backups' / f'clear-to-bag-{time.time_ns()}'
        backup.mkdir(parents=True, mode=0o700)
        # Recheck after stopping: never reset a new owner using a stale timer.
        if args.expired_event:
            lock = json.loads(gate.read_text()) if gate.exists() else {}
            if not expired_owner(cfg, lock, args.expired_event):
                subprocess.run(['launchctl', 'kickstart', JOB], check=True, timeout=5)
                return 0
        if gate.exists():
            shutil.copy2(gate, backup / 'global-lock.json')
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        paths = {}
        owner_slot = None
        cancelled = 0
        for entry in cfg['slots']:
            slot = entry['label']
            state_dir = Path(entry['state_dir'])
            if not state_dir.is_absolute():
                state_dir = ROOT / state_dir
            path = state_dir / 'events.json'
            if not path.exists():
                continue
            folder = backup / slot
            folder.mkdir(mode=0o700)
            shutil.copy2(path, folder / 'events.json')
            paths[slot] = path
            state = json.loads(path.read_text())
            if args.expired_event:
                if args.expired_event not in state.get('events', {}):
                    continue
                owner_slot = slot
            for event in state.get('events', {}).values():
                if event.get('status') in ('held', 'global_waiting', 'queued', 'running'):
                    event['status'] = 'expired' if event['status'] in ('held', 'global_waiting') else 'interrupted'
                    event['reason'] = 'user_cancelled_return_to_bag'
                    event.setdefault('timestamps', {})['finished_at'] = now
                    cancelled += 1
            save(path, state)
        node = next((a for a in argv if Path(a).name in ('node', 'nodejs') and Path(a).is_file()), None) or shutil.which('node')
        if not node:
            raise RuntimeError('node_not_found_receiver_left_stopped')
        print('返回超时 Profile 的购物袋……' if args.expired_event else '返回四个 Profile 的购物袋；不加购、不付款……', flush=True)
        if args.expired_event and owner_slot is None:
            restored = []  # An orphaned reservation has no browser task to restore.
        else:
            try:
                result = subprocess.run([node, '--input-type=module', '-e', RESTORE, str(ROOT), owner_slot or ''],
                                        capture_output=True, text=True, timeout=30 if args.expired_event else 90)
                if result.returncode:
                    raise RuntimeError('bag_restore_failed_receiver_left_stopped')
                restored = json.loads(result.stdout.strip().splitlines()[-1])
            except (OSError, subprocess.TimeoutExpired, RuntimeError, ValueError, IndexError):
                if not args.expired_event:
                    raise
                restored = [{'slot': owner_slot, 'restored': False, 'reason': 'bag_restore_failed'}]
        count = 0
        for row in restored:
            if (not row['restored'] and not args.expired_event) or row['slot'] not in paths:
                continue
            path = paths[row['slot']]
            state = json.loads(path.read_text())
            active = state.get('active')
            if active:
                event = state['events'][active]
                event['reset_at'] = now
                event['release_reason'] = 'user_cancelled_return_to_bag'
                count += 1
                if args.expired_event:
                    event['status'] = 'lock_timeout_returned' if row['restored'] else 'lock_timeout'
                    event['reason'] = 'global_lock_timeout'
                    event['release_reason'] = 'global_lock_timeout'
                    event.setdefault('timestamps', {})['timeout_released_at'] = now
            state['active'] = None
            save(path, state)
        failures = [r for r in restored if not r['restored']]
        # A failed bag restore must not release the global gate protecting that page.
        if (not failures or args.expired_event) and gate.exists():
            save(gate, {'event_id': None, 'released_at': now, 'reason': 'global_lock_timeout' if args.expired_event else 'user_cancelled_return_to_bag'})
        for r in failures:
            action = '超时任务已停止并解锁，请手动检查页面' if args.expired_event else '保留该路锁'
            print(f"Profile {r['slot']} 未恢复：{r['reason']}；{action}。")
        start = subprocess.run(['launchctl', 'kickstart', JOB], capture_output=True, timeout=5)
        if start.returncode:
            raise RuntimeError('receiver_restart_failed')
        for _ in range(40):
            if job_running():
                break
            time.sleep(.25)
        else:
            raise RuntimeError('receiver_not_running_check_profile_windows')
        print(f'完成：取消 {cancelled} 个未完成请求，清除 {count} 个锁。')
        print(f"购物袋恢复 {len(restored)-len(failures)}/{len(restored)}；接收进程已恢复。")
        return 1 if failures else 0


def expired_owner(config, lock, event_id, now=None):
    seconds = config.get('global_lock_timeout_seconds', 0)
    if not seconds or lock.get('event_id') != event_id:
        return False
    try:
        claimed = dt.datetime.fromisoformat(lock['claimed_at'].replace('Z', '+00:00'))
        # Available stock and all later handoff stages override automatic expiry.
        for entry in config.get('slots', []):
            directory = Path(entry['state_dir'])
            if not directory.is_absolute():
                directory = ROOT / directory
            state = json.loads((directory / 'events.json').read_text())
            item = state.get('events', {}).get(event_id)
            if item and (item.get('status') == 'awaiting_user' or any(k in item.get('timestamps', {}) for k in ('pickup_stock_found_at', 'store_selected_at', 'time_selected_at', 'pickup_time_at', 'details_navigation_at', 'contact_verified_at', 'handoff_at'))):
                return False
        return ((now or dt.datetime.now(dt.timezone.utc)) - claimed).total_seconds() >= seconds
    except (KeyError, ValueError, TypeError, OSError):
        return False


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        # Avoid dumping private configuration, form values, or browser contents.
        print(f'清锁未全部完成：{type(exc).__name__}: {exc}。请检查当前页面/接收服务。', file=sys.stderr)
        sys.exit(1)
