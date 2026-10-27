#!/usr/bin/env python3
"""Run on Mini as the monitoring user. Never prints credentials."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import time
import urllib.request

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--repo',type=Path,default=Path('/Users/codex/workspace/nj-iphone-duo-monitor'))
p.add_argument('--label',default='com.trancedu.iphone-duo-proxy-live')
p.add_argument('--apply',action='store_true')
a=p.parse_args();stage=Path(__file__).resolve().parent
meta=json.loads((stage/'deployment.json').read_text())
secret=next(s.split('=',1)[1] for s in (stage/'pickup_bridge.local.env').read_text().splitlines() if s.startswith('PICKUP_SHARED_SECRET='))
if len(secret)<32:raise SystemExit('Invalid staged key; no changes made.')
repo=a.repo.resolve();target=repo/'pickup_bridge.py'
if not target.is_file():raise SystemExit('Run as the monitor user with access to the existing repo; no changes made.')
plist=Path.home()/'Library/LaunchAgents'/(a.label+'.plist')
if not plist.is_file():raise SystemExit('Existing monitor LaunchAgent not found; select its actual --label, do not start a second monitor.')
job=plistlib.loads(plist.read_bytes());argv=job.get('ProgramArguments',[])
if not any(str(repo/name) in argv for name in ('proxy_monitor.py','dataimpulse_monitor.py')) or '--env-file' not in argv:raise SystemExit('LaunchAgent does not match the existing monitor; no changes made.')
env=Path(argv[argv.index('--env-file')+1]);env_text=env.read_text()
endpoint=meta['endpoint'];u=__import__('urllib.parse',fromlist=['urlsplit']).urlsplit(endpoint)
if not ipaddress.ip_address(u.hostname).is_private or u.path!='/prepare':raise SystemExit('Invalid private receiver endpoint.')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
request=urllib.request.Request(endpoint.removesuffix('/prepare')+'/health',headers={'Authorization':'Bearer '+secret})
with opener.open(request,timeout=5) as response:health=json.loads(response.read())
if health.get('mode')!='live' or len(health.get('profiles',[]))!=4 or not health.get('browser_ready'):raise SystemExit('Mac is not four-profile live-ready; no changes made.')
source=stage/'pickup_bridge.py';current_hash=hashlib.sha256(target.read_bytes()).hexdigest();new_hash=hashlib.sha256(source.read_bytes()).hexdigest()
if current_hash not in (meta['expected_base_sha256'],new_hash):raise SystemExit('Mini sender has other edits; merge staged pickup_bridge.patch locally first. No changes made.')
config=repo/'pickup_bridge.local.json';cfg=json.loads(config.read_text()) if config.exists() else {}
cfg.update(enabled=True,endpoint=endpoint,secret_env='PICKUP_SHARED_SECRET');cfg.setdefault('timeout_seconds',1);cfg.setdefault('max_attempts',3);cfg.setdefault('retry_delays_seconds',[.5,1])
print('Verified: real Mini -> Mac authenticated health, four production profiles, existing monitor argv preserved.')
if not a.apply:
 print('Ready for --apply; no files or processes changed.');raise SystemExit(0)
backup=repo/'runtime/bridge-enable-backup'/str(time.time_ns());backup.mkdir(parents=True,mode=0o700)
for f in (target,env,config):
 if f.exists():
  out=backup/f.name;shutil.copyfile(f,out);out.chmod(0o600)
shutil.copyfile(source,target)
config.write_text(json.dumps(cfg,indent=2)+'\n');config.chmod(0o600)
lines=[line for line in env_text.splitlines() if not re.match(r'^\s*(?:export\s+)?(?:PICKUP_MAC_CONFIG|PICKUP_SHARED_SECRET)\s*=',line)]
lines.extend(['PICKUP_MAC_CONFIG='+str(config),'PICKUP_SHARED_SECRET='+secret]);env.write_text('\n'.join(lines)+'\n');env.chmod(0o600)
# Restart the SAME job, retaining node counts, all monitor arguments and Telegram.
r=subprocess.run(['launchctl','kickstart','-k',f'gui/{os.getuid()}/{a.label}'],capture_output=True)
if r.returncode:raise SystemExit('Files updated, but existing job restart failed. Inspect launchctl locally; no credentials logged.')
print('Enabled fixed HTTP bridge and restarted the same existing monitor job. Telegram and polling arguments preserved.')
print('Mac event logs should now receive real arrival events; no fake arrival event was sent.')
