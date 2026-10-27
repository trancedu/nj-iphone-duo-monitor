#!/usr/bin/env python3
"""Manage only the Mac mini's independent stock speech service."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
LABEL = 'com.trancedu.iphone-duo-local-audio'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['install', 'status', 'stop'])
    args = p.parse_args()
    domain = f'gui/{os.getuid()}'
    target = f'{domain}/{LABEL}'
    plist = Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    if args.action != 'install':
        raise SystemExit(subprocess.run(['launchctl', 'print' if args.action=='status' else 'bootout', target]).returncode)
    if subprocess.run(['launchctl', 'print', target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        print('Stock speaker already loaded; not restarting.');return
    work = ROOT/'runtime/local-stock-audio';work.mkdir(parents=True, exist_ok=True, mode=0o700)
    job = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(ROOT/'local_stock_audio.py')],
           'WorkingDirectory': str(ROOT), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15,
           'StandardOutPath': str(work/'stdout.log'), 'StandardErrorPath': str(work/'stderr.log')}
    plist.parent.mkdir(parents=True, exist_ok=True);plist.write_bytes(plistlib.dumps(job));plist.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    print('Local speech enabled. Inventory, Telegram and Mac forwarding unchanged.')

if __name__ == '__main__':main()
