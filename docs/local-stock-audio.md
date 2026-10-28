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
- No fixed repeat window or phrase cooldown. Each validated stock episode is spoken once; a confirmed negative observation ends that episode, and a subsequent positive starts a new ID immediately. Errors and missing observations never end an episode. Successful event IDs are remembered across speech-service restarts, independently of Telegram.

Service startup begins at the existing log's end, so it does not replay historical stock. File replacement/truncation is handled and partial JSONL lines are retried. Queue length is limited to eight; old speech cannot accumulate indefinitely. Speech failures allow fresh observations of the same event to retry. No store or payment choice is made by this service.

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


## MacBook deployment (2026-10-28)

本机已启用同一独立进程及线程队列，不修改库存循环或浏览器转发。设备配置保存在
`~/.config/iphone-duo/local-stock-audio.json`，audio_device 为 `MacBook Pro Speakers`，
Tingting、rate=300、max_age_seconds=10。Mini原配置文件保持可复用。

```sh
python3 deploy/local_audio_service.py install --config "$HOME/.config/iphone-duo/local-stock-audio.json"
python3 deploy/local_audio_service.py status
```

新消息约每100ms扫描一次既有日志，提交用put_nowait，独立线程执行say子进程；
慢播报、设备失败不会阻塞查询、Telegram或Safari。队列最多8条，超过10秒的排队提示丢弃，
同一库存episode只播一次，启动跳过历史。当前支持256白/黑、512白/黑、1T白/黑。

验收：5个语音测试通过，含慢play仍不阻塞submit、去重/新episode、跳过历史/半行及
显式音频设备；实际执行一次“测试。二五六白，五一二黑。”命令返回成功。
这不等于确认用户听到；音量与静音状态未改动。安装语音服务前后库存PID54409保持不变。
