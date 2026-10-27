#!/usr/bin/env python3
"""Install/start or stop this checkout's isolated proxy polling LaunchAgent."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import fcntl
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start-test', 'start-live', 'stop-test', 'stop-live', 'status'])
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--provider', choices=['clash', 'dataimpulse'], help='Defaults to the saved provider; first install uses clash')
    parser.add_argument('--proxy-env-file', type=Path, default=Path.home()/'.codex/secrets/dataimpulse.env')
    parser.add_argument('--clash-config', type=Path, default=Path.home() / 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml')
    parser.add_argument('--mihomo', type=Path, default=Path('/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'))
    args = parser.parse_args()
    domain = f'gui/{os.getuid()}'
    if args.action == 'status':
        for name in ('test', 'live'):
            subprocess.run(['launchctl', 'print', f'{domain}/com.trancedu.iphone-duo-proxy-{name}'])
        return
    kind = 'test' if args.action.endswith('test') else 'live'
    label = f'com.trancedu.iphone-duo-proxy-{kind}'
    plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    runtime = ROOT / 'runtime/proxy-monitor'
    provider_file = runtime / (kind+'-provider.json')
    if args.action.startswith('stop'):
        subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
        if plist.exists():
            plist.unlink()
        return
    if args.provider is None:
        if provider_file.exists():args.provider=json.loads(provider_file.read_text())['provider']
        elif plist.exists() and str(ROOT/'dataimpulse_monitor.py') in plistlib.loads(plist.read_bytes()).get('ProgramArguments',[]):args.provider='dataimpulse'
        else:args.provider='clash'
    if args.provider not in ('clash','dataimpulse'):parser.error('Invalid saved provider; pass --provider explicitly')
    # The process lock also prevents accidental test/live overlap.
    if args.provider == 'clash' and not args.clash_config.is_file():
        parser.error('Clash config not found; supply --clash-config /absolute/path/config.yaml')
    if args.provider == 'clash' and (not args.mihomo.is_file() or not os.access(args.mihomo, os.X_OK)):
        parser.error('Mihomo executable not found; supply --mihomo /absolute/path/mihomo')
    runtime = ROOT / 'runtime/proxy-monitor'
    runtime.mkdir(parents=True, exist_ok=True)
    argv = ['/usr/bin/caffeinate', '-i', sys.executable, str(ROOT / 'proxy_monitor.py'),
            '--duration', '600' if kind == 'test' else '0', '--max-nodes', '256', '--all-subscriptions', '--workers', '4',
            '--spacing', '2', '--min-ip-interval', '60', '--cooldown', '300',
            '--zip', '07094', '--env-file', str(args.env_file.resolve()),
            '--clash-config', str(args.clash_config.resolve()), '--mihomo', str(args.mihomo.resolve())]
    if args.provider == 'dataimpulse':
        if not args.env_file.is_file():
            parser.error('Notification env file must exist before switching the service')
        if not args.proxy_env_file.is_file() or args.proxy_env_file.stat().st_mode & 0o077:
            parser.error('DataImpulse private env must exist with permission 600')
        # Check configuration locally before stopping the previous service.
        sys.path.insert(0,str(ROOT))
        from dataimpulse_client import DataImpulseClient
        values={}
        for line in args.proxy_env_file.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key,value=line.split('=',1);values[key.strip()]=value.strip().strip('\"\'')
        DataImpulseClient(values,'us')
        argv=['/usr/bin/caffeinate','-i',sys.executable,str(ROOT/'dataimpulse_monitor.py'),
            '--duration','600' if kind=='test' else '0','--spacing','1','--workers','4','--zip','07094',
            '--env-file',str(args.env_file.resolve()),'--proxy-env-file',str(args.proxy_env_file.resolve())]
    job = {'Label': label, 'ProgramArguments': argv, 'WorkingDirectory': str(ROOT),
           'RunAtLoad': True, 'KeepAlive': False, 'ProcessType': 'Background',
           'StandardOutPath': str(runtime / (kind + '.stdout.log')),
           'StandardErrorPath': str(runtime / (kind + '.stderr.log'))}
    if args.provider=='dataimpulse':
        job.update(KeepAlive={'SuccessfulExit':False},ThrottleInterval=60)
    plist.parent.mkdir(parents=True, exist_ok=True)
    if plist.exists():
        backup=runtime/'service-backups'/str(time.time_ns());backup.mkdir(parents=True,mode=0o700)
        (backup/plist.name).write_bytes(plist.read_bytes())
    plist.write_bytes(plistlib.dumps(job))
    subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
    # Wait for the shared lock instead of racing an old process that is draining.
    with (runtime/'monitor.lock').open('a') as lock:
        until=time.monotonic()+25
        while True:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()>=until:raise RuntimeError('Previous monitor has not stopped; no second monitor started')
                time.sleep(.2)
        fcntl.flock(lock,fcntl.LOCK_UN)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    provider_file.write_text(json.dumps({'provider':args.provider})+'\n')
    subprocess.run(['launchctl', 'print', f'{domain}/{label}'], check=True)


if __name__ == '__main__':
    main()
