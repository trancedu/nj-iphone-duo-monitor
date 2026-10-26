#!/usr/bin/env python3
"""Install/start or stop this checkout's isolated proxy polling LaunchAgent."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start-test', 'start-live', 'stop-test', 'stop-live', 'status'])
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
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
    if args.action.startswith('stop'):
        subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
        if plist.exists():
            plist.unlink()
        return
    # The process lock also prevents accidental test/live overlap.
    if not args.clash_config.is_file():
        parser.error('Clash config not found; supply --clash-config /absolute/path/config.yaml')
    if not args.mihomo.is_file() or not os.access(args.mihomo, os.X_OK):
        parser.error('Mihomo executable not found; supply --mihomo /absolute/path/mihomo')
    runtime = ROOT / 'runtime/proxy-monitor'
    runtime.mkdir(parents=True, exist_ok=True)
    argv = ['/usr/bin/caffeinate', '-i', sys.executable, str(ROOT / 'proxy_monitor.py'),
            '--duration', '600' if kind == 'test' else '0', '--max-nodes', '256', '--all-subscriptions', '--workers', '4',
            '--spacing', '2', '--min-ip-interval', '60', '--cooldown', '300',
            '--zip', '07094', '--env-file', str(args.env_file.resolve()),
            '--clash-config', str(args.clash_config.resolve()), '--mihomo', str(args.mihomo.resolve())]
    job = {'Label': label, 'ProgramArguments': argv, 'WorkingDirectory': str(ROOT),
           'RunAtLoad': True, 'KeepAlive': False, 'ProcessType': 'Background',
           'StandardOutPath': str(runtime / (kind + '.stdout.log')),
           'StandardErrorPath': str(runtime / (kind + '.stderr.log'))}
    plist.parent.mkdir(parents=True, exist_ok=True)
    plist.write_bytes(plistlib.dumps(job))
    subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    subprocess.run(['launchctl', 'print', f'{domain}/{label}'], check=True)


if __name__ == '__main__':
    main()
