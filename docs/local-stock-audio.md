# Mac mini local stock voice alerts

The Mini now speaks short Chinese configuration names through its physical **Mac mini Speakers**, in addition to the unchanged Telegram and authenticated Mac delivery channels:

| Product | Spoken text |
| --- | --- |
| 256GB Night Sky | 二五六黑 |
| 256GB Star White | 二五六白 |
| 512GB Night Sky | 五一二黑 |
| 512GB Star White | 五一二白 |
| 1TB Night Sky | 一T黑 |
| 1TB Star White | 一T白 |

`local_stock_audio.py` is an independent process. It tails the existing confirmed `runtime/proxy-monitor/availability-events.jsonl` every 100ms, submits fresh observations to a bounded queue, and plays them on a dedicated Python worker thread. It adds no Apple requests, never loads secrets, never sends test events to Telegram/Mac and never changes polling or checkout code. The monitor need not be restarted to enable or disable it.

The audio device is explicit: the Mini currently has Jump Desktop virtual audio as its default output, so relying on the default could send sound to a remote session. `/usr/bin/say -a 'Mac mini Speakers' -v Tingting -r 300` targets the built-in speaker by name rather than a reboot-sensitive device ID. Output-device or voice failures are logged; speech does not silently fall back to another output. Actual audibility still depends on speaker volume and mute state.

## Configuration and repeat policy

Edit `local_stock_audio.json`:

- `voice`: installed macOS voice, currently `Tingting` (Mandarin).
- `rate`: macOS speech rate, currently 300; accepted range is clamped to 180–400.
- `audio_device`: `Mac mini Speakers`.
- `max_age_seconds`: 10. Old arrivals and expired queued speech are discarded.
- `dedup_seconds`: 1800 per store/SKU/pickup date, matching the existing Telegram repeat window. Successful speech is remembered in a separate local file across restarts. This is independent of Telegram success/failure.
- `phrase_cooldown_seconds`: 15. Same configuration at several stores close together is spoken once; different configurations can speak immediately in sequence.

Service startup begins at the existing log's end, so it does not replay historical stock. File replacement/truncation is handled and partial JSONL lines are retried. Queue length is limited to eight; old speech cannot accumulate indefinitely. Speech failures allow fresh observations to retry after the phrase cooldown. No store or payment choice is made by this service.

## Commands

```sh
cd /Users/codex/workspace/nj-iphone-duo-monitor
# Clearly announces a test; no stock events, Telegram or browser actions.
python3 local_stock_audio.py --test
python3 deploy/local_audio_service.py install
python3 deploy/local_audio_service.py status

# Stop only local voice alerts, leaving monitoring and other notifications running.
python3 deploy/local_audio_service.py stop
```

After configuration/code changes, stop then install this audio service only. `install` is idempotent while loaded and does not restart an already-running service.

LaunchAgent: `~/Library/LaunchAgents/com.trancedu.iphone-duo-local-audio.plist` (login GUI session, RunAtLoad / KeepAlive). Logs and spoken-state deduplication are in `runtime/local-stock-audio/`; the existing inventory state is never written. A lock prevents two speaker instances. Log `speech_started` includes phrase and queue delay, and `speech_completed` confirms the speech command returned successfully; it does not prove a human heard it.

## Verification on 2026-10-27

- Four focused tests passed: all four phrase mappings, nonblocking submission/deduplication/persistence, incremental tail behavior, and the explicit physical audio device argument.
- Real local test command completed successfully with “测试。二五六黑，五一二白。”
- The deployed service observed a fresh real 512GB Night Sky event, logged approximately 2ms queue delay and successful playback completion in about 1.3 seconds.
- Inventory PID 72913 remained running at one-second target dispatch / four workers. No monitor restart or additional inventory request was required.


2026-10-28：增加两种颜色的1TB语音映射。与原四款共用独立队列和去重策略；2TB仍不播报。模拟测试必须带“测试”前缀，不向真实到货日志或Mac前端注入伪库存。
