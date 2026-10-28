#!/usr/bin/env python3
"""Speak fresh confirmed stock observations on the Mini, without changing polling."""
import argparse
import datetime as dt
import fcntl
import json
import logging
from pathlib import Path
import queue
import re
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger('stock.audio')


def phrase_for(offer):
    match = re.fullmatch(r'iPhone Duo (256GB|512GB|1TB) (Star White|Night Sky)', offer.get('name', ''))
    if not match:
        return None
    return {'256GB': '二五六', '512GB': '五一二', '1TB': '一T'}[match[1]] + ('白' if match[2] == 'Star White' else '黑')


def fresh(offer, now, max_age):
    try:
        observed = dt.datetime.fromisoformat(offer['observed_at'].replace('Z', '+00:00')).timestamp()
        return -5 <= now - observed <= max_age
    except (KeyError, ValueError, TypeError):
        return False


def speak(phrase, config):
    # Argument vector, fixed text mapping and explicit device: no shell or default virtual audio.
    result = subprocess.run(['/usr/bin/say', '-a', config['audio_device'], '-v', config['voice'],
                             '-r', str(config['rate']), phrase], capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError('speech_failed')


class Speaker:
    def __init__(self, config, state_path, play=speak, clock=time.time):
        self.config, self.state_path, self.play, self.clock = config, Path(state_path), play, clock
        self.pending = queue.Queue(maxsize=8)
        self.lock = threading.Lock()
        self.phrases = {}
        try:
            self.sent = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            self.sent = {}
        self.played = dict(self.sent)
        self.worker = threading.Thread(target=self.run, name='mini-stock-speech', daemon=True)
        self.worker.start()

    def submit(self, offer):
        now = self.clock()
        phrase = phrase_for(offer)
        if not phrase or not fresh(offer, now, self.config['max_age_seconds']):
            return False
        key = '|'.join(str(offer.get(k, '')) for k in ('store_id', 'sku', 'date'))
        if not all(offer.get(k) for k in ('store_id', 'sku', 'date')):
            return False
        with self.lock:
            if now - self.sent.get(key, 0) < self.config['dedup_seconds']:
                return False
            if now - self.phrases.get(phrase, 0) < self.config['phrase_cooldown_seconds']:
                return False
            try:
                self.pending.put_nowait((key, phrase, now))
            except queue.Full:
                LOG.warning('speech_queue_full')
                return False
            self.sent[key] = now
            self.phrases[phrase] = now
        return True

    def run(self):
        while True:
            key, phrase, queued_at = self.pending.get()
            try:
                if self.clock() - queued_at > self.config['max_age_seconds']:
                    raise RuntimeError('speech_expired')
                LOG.info('speech_started phrase=%s queue_ms=%.0f', phrase, (self.clock()-queued_at)*1000)
                self.play(phrase, self.config)
                with self.lock:
                    cutoff = self.clock() - self.config['dedup_seconds']
                    self.sent = {k: v for k, v in self.sent.items() if v >= cutoff}
                    self.played = {k: v for k, v in self.played.items() if v >= cutoff}
                    self.played[key] = queued_at
                    temp = self.state_path.with_suffix('.tmp')
                    temp.write_text(json.dumps(self.played))
                    temp.replace(self.state_path)
                LOG.info('speech_completed phrase=%s', phrase)
            except Exception as error:
                # Failure never reaches the monitor. Permit a fresh observation to retry after coalescing.
                with self.lock:
                    self.sent.pop(key, None)
                LOG.warning('speech_error code=%s', type(error).__name__)
            finally:
                self.pending.task_done()


class Tail:
    def __init__(self, path, from_end=True):
        self.path = Path(path)
        self.inode = None
        self.offset = 0
        if from_end and self.path.exists():
            stat = self.path.stat()
            self.inode, self.offset = stat.st_ino, stat.st_size

    def read(self):
        try:
            stat = self.path.stat()
            if self.inode != stat.st_ino or stat.st_size < self.offset:
                self.inode, self.offset = stat.st_ino, 0
            with self.path.open('rb') as stream:
                stream.seek(self.offset)
                # Bounded work; partial JSONL writes are retried on the next pass.
                for _ in range(512):
                    line = stream.readline()
                    if not line or not line.endswith(b'\n'):
                        break
                    self.offset = stream.tell()
                    try:
                        offer = json.loads(line)
                        if isinstance(offer, dict):
                            yield offer
                    except (ValueError, UnicodeDecodeError):
                        LOG.warning('invalid_audio_observation')
        except FileNotFoundError:
            return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT/'local_stock_audio.json')
    parser.add_argument('--test', action='store_true', help='Speak a clearly identified local test; no stock/Telegram/Mac event')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    config = json.loads(args.config.read_text())
    config['rate'] = max(180, min(400, int(config['rate'])))
    if args.test:
        speak('测试。二五六黑，五一二白。', config)
        return
    work = ROOT/'runtime/local-stock-audio'
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (work/'speaker.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Local stock speaker already running')
    # Never replay old arrivals at service startup. Only new, fresh observations are spoken.
    tail = Tail(ROOT/'runtime/proxy-monitor/availability-events.jsonl')
    speaker = Speaker(config, work/'spoken.json')
    LOG.info('speaker_ready device=%s voice=%s rate=%s', config['audio_device'], config['voice'], config['rate'])
    while True:
        for offer in tail.read():
            speaker.submit(offer)
        time.sleep(.1)


if __name__ == '__main__':
    main()
