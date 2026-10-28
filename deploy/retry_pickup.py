#!/usr/bin/env python3
"""Explicit local user control: retry only the selected production Safari profile."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[1]


def apple_script(source):
    return subprocess.check_output(['/usr/bin/osascript', '-e', source], text=True, timeout=120).strip()


def label_for(slot):
    path = slot['product_url'].lower()
    capacity = '1TB' if '1tb' in path else '512GB' if '512gb' in path else '256GB'
    color = '白色' if 'star-white' in path else '黑色'
    return f"{slot['label']} · {capacity} {color}"


def choose_slot(slots):
    # Opening this desktop command brings Terminal forward; Safari's own front
    # window still identifies the production profile the user last selected.
    try:
        title = apple_script('if application "Safari" is running then\ntell application "Safari" to return name of front window\nend if')
        matches = [s for s in slots if title.startswith(s['safari_profile']+' — ')]
        if len(matches) == 1:
            return matches[0]
    except subprocess.SubprocessError:
        pass
    choices = [label_for(s) for s in slots]
    values = '{'+', '.join(json.dumps(s, ensure_ascii=False) for s in choices)+'}'
    answer = apple_script(f'choose from list {values} with title "立即重试自提" with prompt "选择要操作的配置；只处理这个窗口，不动其他配置。" OK button name "选择" cancel button name "取消"')
    if answer == 'false':
        return None
    return next((s for s in slots if label_for(s) == answer), None)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=list('ABCDEF'), help='Optional direct profile label; otherwise use the selected Safari window')
    parser.add_argument('--restore-only', action='store_true')
    parser.add_argument('--dry-run', action='store_true', help='Show the selected configuration without sending requests')
    args = parser.parse_args()
    plist = Path.home()/'Library/LaunchAgents/com.trancedu.apple-pickup-router.plist'
    argv = plistlib.loads(plist.read_bytes())['ProgramArguments']
    config_path = Path(argv[argv.index('--config')+1])
    cfg = json.loads(config_path.read_text())
    if cfg.get('browser_backend') != 'safari' or not cfg.get('per_profile_requests'):
        raise RuntimeError('正式接收服务没有启用 Safari 独立配置模式。')
    slots = cfg['slots']
    selected = next((s for s in slots if s['label'] == args.profile), None) if args.profile else choose_slot(slots)
    if selected is None:
        print('已取消，未操作页面。')
        return
    title = label_for(selected)
    mode = '仅恢复自提' if args.restore_only else '立即重试自提'
    if args.dry_run:
        print(f'预览：{mode} · {title}；未发送请求、未操作页面。')
        return
    # Reuse the service's private env file; never embed or print credentials.
    sys.path.insert(0, str(REPO))
    from monitor import load_env
    env_arg = next((s.split('=', 1)[1] for s in argv if s.startswith('--env-file=')), None)
    if env_arg is None:
        raise RuntimeError('找不到接收服务凭据文件。')
    load_env(Path(env_arg))
    secret = os.environ.get(cfg.get('secret_env', 'PICKUP_SHARED_SECRET'), '')
    if len(secret) < 32:
        raise RuntimeError('接收服务凭据未就绪。')
    port = cfg['port']
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise RuntimeError('接收服务端口无效。')
    base = f'http://127.0.0.1:{port}'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(path, body=None):
        req = urllib.request.Request(base+path, data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer '+secret, 'Content-Type': 'application/json'}, method='GET' if body is None else 'POST')
        try:
            with opener.open(req, timeout=5) as response:
                return response.status, json.loads(response.read(65536))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read(65536))

    _, health = request('/health')
    current = next((p for p in health.get('profiles', []) if p['profile_label'] == selected['label']), None)
    if current is None:
        raise RuntimeError('接收服务找不到这个配置。')
    code, result = request('/retry', {'confirm': True, 'profile_label': selected['label'],
        'expected_event_id': current.get('active_event_id'), 'restore_only': args.restore_only})
    if code == 409:
        print('该配置刚有新任务开始，已保留新任务。如仍需要重试，请再运行一次。')
        return
    if code != 202 or not result.get('event_id'):
        raise RuntimeError('接收服务未接受操作：'+result.get('status', 'unknown'))
    if result.get('already_running'):
        print('该配置已有手动恢复任务正在进行，本次没有再启动一份；请查看 Safari。')
        return
    event_id = result['event_id']
    print(f'{mode} · {title}\n已接收，正在安全结束旧流程并恢复自提；其他配置继续运行。', flush=True)
    deadline = time.monotonic()+90
    terminal = {'awaiting_user', 'manual_review', 'pickup_unavailable', 'pickup_expired', 'manual_retry_ready',
        'lock_timeout', 'payment_window_expired', 'superseded', 'payment_failed_returned'}
    while time.monotonic() < deadline:
        _, item = request('/status/'+event_id)
        status = item.get('status')
        if status in terminal:
            if status == 'manual_retry_ready':
                print('已回到自提待命。后续真实库存消息照常接收。')
            elif status == 'awaiting_user':
                print('已到付款前，请查看该 Safari 窗口。是否实际弹出 Apple Pay 以窗口显示为准。')
            elif status in {'pickup_unavailable', 'pickup_expired'}:
                print('没有可用库存，本轮已结束。')
            elif status in {'payment_window_expired', 'payment_failed_returned'}:
                print('付款阶段已结束，正在恢复或已恢复自提，请查看该窗口。')
            else:
                print('需要查看窗口：'+str(item.get('reason') or status))
            return
        time.sleep(.5)
    print('操作仍在后台进行，请查看 Safari；本脚本不会再重复发起请求。')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print('操作未完成：请检查接收服务和所选 Safari 窗口。未输出任何凭据。', file=sys.stderr)
        sys.exit(1)
