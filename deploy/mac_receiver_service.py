#!/usr/bin/env python3
"""Install the receiving Mac's GUI LaunchAgent (never run this on the monitoring Mini)."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LABEL = 'com.trancedu.apple-pickup-receiver'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['install', 'start', 'stop', 'status'])
    p.add_argument('--config', type=Path, default=ROOT/'mac_receiver/receiver.local.json')
    p.add_argument('--env-file', type=Path, default=ROOT/'mac_receiver/.env')
    p.add_argument('--node', default=shutil.which('node'))
    a = p.parse_args()
    domain = f'gui/{os.getuid()}'
    plist = Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    if a.action == 'install':
        if not a.node or not a.config.is_file() or not a.env_file.is_file(): p.error('Node, config and env file must exist')
        if a.env_file.stat().st_mode & 0o077: p.error('chmod 600 the env file first')
        log = ROOT/'mac_receiver/runtime';log.mkdir(parents=True, exist_ok=True, mode=0o700)
        job = {'Label':LABEL, 'ProgramArguments':['/usr/bin/caffeinate','-i',str(Path(a.node).resolve()),'--env-file='+str(a.env_file.resolve()),str(ROOT/'mac_receiver/server.mjs'),'--config',str(a.config.resolve())],
            'WorkingDirectory':str(ROOT/'mac_receiver'), 'RunAtLoad':True, 'KeepAlive':False, 'LimitLoadToSessionType':'Aqua',
            'StandardOutPath':str(log/'service.stdout.log'), 'StandardErrorPath':str(log/'service.stderr.log')}
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_bytes(plistlib.dumps(job));plist.chmod(0o600)
        print(f'Installed {plist}; run start in the logged-in graphical session.');return
    if a.action == 'stop':
        subprocess.run(['launchctl','bootout',f'{domain}/{LABEL}'],check=False);return
    if a.action == 'start':
        subprocess.run(['launchctl','bootstrap',domain,str(plist)],check=True);return
    subprocess.run(['launchctl','print',f'{domain}/{LABEL}'],check=True)

if __name__ == '__main__': main()
