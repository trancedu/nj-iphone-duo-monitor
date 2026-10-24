#!/usr/bin/env python3
"""Independent launchd health checker; does not import the monitored program."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
JOB = 'com.trancedu.iphone-duo-monitor'

def read_json(path):
    try: return json.loads(path.read_text())
    except (OSError, ValueError): return {}

def save_json(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2))
    tmp.replace(path)

def service_running():
    try:
        result = subprocess.run(['/bin/launchctl','print',f'gui/{os.getuid()}/{JOB}'],capture_output=True,text=True,timeout=10)
        return result.returncode == 0 and 'state = running' in result.stdout
    except (OSError,subprocess.TimeoutExpired): return False

def send_telegram(message, env_file):
    values = dict(os.environ)
    try:
        for line in Path(env_file).read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key,value = line.split('=',1)
                values.setdefault(key.strip(),value.strip().strip('\"\''))
    except OSError: pass
    token,chat = values.get('TELEGRAM_BOT_TOKEN'),values.get('TELEGRAM_CHAT_ID')
    if not token or not chat: raise RuntimeError('missing_credentials')
    body = urllib.parse.urlencode({'chat_id':chat,'text':message,'disable_web_page_preview':'true'}).encode()
    request = urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage',data=body)
    # Caller logs only exception type: URLs may contain credentials.
    with urllib.request.urlopen(request,timeout=20) as response:
        if not json.load(response).get('ok'): raise RuntimeError('telegram_rejected')

def assess(monitor, running, now):
    if not running: return '监控进程未运行'
    last_cycle = monitor.get('last_cycle_at',0)
    deadline = monitor.get('next_check_at',0)
    if not last_cycle or now > max(deadline,last_cycle+60)+180:
        return '监控长时间没有完成查询，可能卡住或反复崩溃'
    if monitor.get('status') != 'healthy':
        return '库存查询或通知持续失败'
    return None

def check(monitor, health, running, now, send):
    """One notice per outage; persisted retry/cooldown prevents notification storms."""
    reason = assess(monitor,running,now)
    if reason:
        health['healthy_checks'] = 0
        health.setdefault('bad_since',now)
        health['reason'] = reason
        # Process exits/hangs need two minutes; repeated query failures need five.
        grace = 300 if reason == '库存查询或通知持续失败' else 120
        ready = now-health['bad_since'] >= grace
        if ready and not health.get('outage_notified') and now >= health.get('next_send_attempt',0) and now-health.get('last_alert_at',0) >= 3600:
            health['next_send_attempt'] = now+300
            try:
                send('⚠️ iPhone Duo 监控故障：'+reason+'。库存提醒可能暂停；常驻服务会自动重启或退避重试。同一故障仅提醒一次，恢复后会再通知。')
            except Exception as exc:
                health['send_error'] = type(exc).__name__
            else:
                health['outage_notified'] = True
                health['last_alert_at'] = now
                health.pop('send_error',None)
    else:
        health['healthy_checks'] = health.get('healthy_checks',0)+1
        if health.get('outage_notified'):
            if health['healthy_checks'] >= 2 and now >= health.get('next_send_attempt',0):
                health['next_send_attempt'] = now+300
                try: send('✅ iPhone Duo 监控已恢复，连续健康检查通过，库存提醒继续运行。')
                except Exception as exc: health['send_error'] = type(exc).__name__
                else:
                    health['outage_notified'] = False
                    health.pop('bad_since',None)
                    health.pop('reason',None)
                    health.pop('send_error',None)
        else:
            health.pop('bad_since',None)
            health.pop('reason',None)
    health['checked_at'] = now
    health['service_running'] = running
    health['monitor_status'] = monitor.get('status','unknown')
    return health

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--env-file',default='/Users/codex/.codex/secrets/market-radar.env')
    args=parser.parse_args()
    runtime=ROOT/'runtime';runtime.mkdir(exist_ok=True)
    lock=(runtime/'watchdog.lock').open('w')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: return
    path=runtime/'watchdog-state.json'
    health=check(read_json(runtime/'state.json'),read_json(path),service_running(),time.time(),lambda message:send_telegram(message,args.env_file))
    save_json(path,health)

if __name__=='__main__': main()
