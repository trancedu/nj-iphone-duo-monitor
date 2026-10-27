#!/usr/bin/env python3
"""Manage only the independent read-only dashboard observer."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
LABEL='com.trancedu.iphone-duo-dashboard'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['install','status','stop'])
    args=parser.parse_args()
    domain=f'gui/{os.getuid()}'
    plist=Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    if args.action=='status':
        raise SystemExit(subprocess.run(['launchctl','print',f'{domain}/{LABEL}']).returncode)
    if args.action=='stop':
        raise SystemExit(subprocess.run(['launchctl','bootout',f'{domain}/{LABEL}']).returncode)
    work=ROOT/'runtime/dashboard';work.mkdir(parents=True,exist_ok=True,mode=0o700)
    definition={'Label':LABEL,'ProgramArguments':[sys.executable,str(ROOT/'dashboard/collector.py')],
        'WorkingDirectory':str(ROOT),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,
        'StandardOutPath':str(work/'stdout.log'),'StandardErrorPath':str(work/'stderr.log')}
    plist.parent.mkdir(parents=True,exist_ok=True)
    if subprocess.run(['launchctl','print',f'{domain}/{LABEL}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
        print('Dashboard observer already loaded; not restarting.');return
    plist.write_bytes(plistlib.dumps(definition));plist.chmod(0o600)
    subprocess.run(['launchctl','bootstrap',domain,str(plist)],check=True)
    print('Dashboard observer installed; inventory service untouched.')

if __name__=='__main__':main()
