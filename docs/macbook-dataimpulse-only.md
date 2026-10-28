# MacBook 运行 DataImpulse Data Center 库存监控

这是交给 MacBook agent 的部署说明。只运行 Python 库存 API 入口；不安装、不调用 Clash/mihomo。Safari 接收器独立运行，购买仍由用户授权。当前 Mini 于 2026-10-28 13:05 美东暂停，已安排当天 14:00 恢复；迁移正式接管前，请用户在原对话取消 Mini 恢复，或到点后确认 Mini 已停止，避免两台重复付费查询和通知。不要自行启用两台正式监控。

## 1. 更新与准备

在 MacBook 已有仓库目录执行 `git fetch origin`、`git status --short`，保留本地修改后再 `git pull --rebase origin main`。若尚无 checkout，使用用户 GitHub 权限克隆 `https://github.com/trancedu/nj-iphone-duo-monitor.git`。本说明所有命令在仓库根目录运行；私密文件放在用户目录。

Python 3.9+，仅标准库，不需要 pip 或 Node 来运行库存端。Safari 接收器的依赖按 Mac 现有部署保留。不要在 Mini 上执行下列 MacBook 安装命令。

```sh
mkdir -p "$HOME/.config/iphone-duo"
chmod 700 "$HOME/.config/iphone-duo"
cp examples/dataimpulse-datacenter.env.example "$HOME/.config/iphone-duo/datacenter.env"
cp examples/macbook-monitor.env.example "$HOME/.config/iphone-duo/monitor.env"
chmod 600 "$HOME/.config/iphone-duo/datacenter.env" "$HOME/.config/iphone-duo/monitor.env"
cp examples/pickup-bridge-loopback.example.json pickup_bridge.local.json
chmod 600 pickup_bridge.local.json
```

用户在本机填写两个 env，不把实际内容发聊天或提交 Git：

- `datacenter.env`：Data Center 的 login、password、host、port 对应四个 `DATAIMPULSE_PROXY_*`。不是 DataImpulse 管理 API token，也不是旧住宅套餐。
- `monitor.env`：原 Telegram bot/chat、原共享密钥，以及 `PICKUP_MAC_CONFIG` 的真实绝对路径。不能保留 `/ABSOLUTE/...`；env 解析器不会展开 `$HOME`、`~`。这份文件不放代理凭据，避免覆盖第二份配置。
- 同一 MacBook 的接收器用 `http://127.0.0.1:8765/prepare`，确认接收器 loopback 监听及来源白名单启用。若接收器在另一台 Mac，则使用它的 Tailscale 地址并允许 MacBook 的 Tailscale 来源 IP，沿用正确共享密钥；不要复制 Mini 的来源 IP 当作 MacBook 的 IP。
- 不要复制 Mini 的整个 runtime、LaunchAgent 或硬编码 `/Users/codex` 路径。保留 MacBook 已有 Safari Profiles，不重装、不清空购物袋。
- `load_env` 保留 shell 已有环境变量。测试前确认 shell 没有旧的同名 DataImpulse 凭据、旧 `PICKUP_MAC_CONFIG` 或意外 ZIP；不要打印它们。下面 unset 只影响当前 shell，不改文件。

```sh
unset DATAIMPULSE_PROXY_USERNAME DATAIMPULSE_PROXY_PASSWORD DATAIMPULSE_PROXY_HOST DATAIMPULSE_PROXY_PORT
unset PICKUP_MAC_CONFIG APPLE_PICKUP_ZIP
```

## 2. 只读验证（不触发浏览器）

```sh
python3 dataimpulse_smoke.py \
  --env-file "$HOME/.config/iphone-duo/datacenter.env" \
  --probes 1 --inventory --country us
python3 bridge_client.py health \
  --env-file "$HOME/.config/iphone-duo/monitor.env" \
  --endpoint http://127.0.0.1:8765
```

烟测只发一个库存请求，不发到货通知。应解析六配置、12 店；health 应显示鉴权通过且六个 Profile ready。503/541 不是“无货”，不能当作成功。Apple 维护时保留错误证据，稍后重试，不用加频率绕过错误。不要为了验收擅自发送模拟到货或点击真实购买流程。

## 3. 正式接管：二选一，不能同时运行

先让用户确认 Mini 已停止且其自动恢复已取消。选前台命令便于初测，或直接使用登录用户的 LaunchAgent；两者共用文件锁，禁止并行启动。

前台命令（Ctrl+C 停止）：

```sh
python3 dataimpulse_monitor.py \
  --env-file "$HOME/.config/iphone-duo/monitor.env" \
  --proxy-env-file "$HOME/.config/iphone-duo/datacenter.env" \
  --spacing 1 --workers 4 --zip 07094 --duration 0
```

登录用户常驻服务（推荐正式运行）：

```sh
python3 deploy/proxy_service.py start-live --provider dataimpulse \
  --env-file "$HOME/.config/iphone-duo/monitor.env" \
  --proxy-env-file "$HOME/.config/iphone-duo/datacenter.env"
python3 deploy/proxy_service.py status
```

显式 `--provider dataimpulse` 会跳过 Clash/mihomo 检查，服务命令固定 spacing=1、workers=4，使用 Data Center 的那个 env。不要只凭保存的 provider 名猜测套餐；住宅和 Data Center 使用同一个客户端，区别在所选凭据文件。LaunchAgent 为本机当前用户生成正确路径，用 caffeinate 防止空闲睡眠；合盖、退出登录、断网仍可能中断，需保持 MacBook 合适的唤醒状态。

临时暂停，保留 plist（再启动时 bootstrap 同一个 plist；不要重复启动）：

```sh
launchctl bootout "gui/$(id -u)/com.trancedu.iphone-duo-proxy-live"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.trancedu.iphone-duo-proxy-live.plist"
```

这两条分别是暂停和恢复，按需执行，不能连着运行来“暂停”。永久停止可用 `python3 deploy/proxy_service.py stop-live`，它还会删除该服务 plist，未来重新执行 start-live 安装。

## 4. 核对与交接

`runtime/proxy-monitor/current.json` 应为 `backend=dataimpulse_only`、`uses_original_pool=false`、`target_start_spacing=1`，随后出现成功查询或明确退避。各运行目录 `queries.jsonl` 记录每次发起/完成时间、耗时、错误码、正文量；`pickup-bridge/delivery.jsonl` 记录接收器结果。不要从 `unique_exits=null` 推断没有 IP：rotating 的真实 Apple 请求出口未逐个核验。

每次请求覆盖 256/512GB/1TB × 白/黑，12 家门店。每秒发起为目标，最多四项在途；慢请求、通知处理或退避会拉大实际间隔，不追赶突发。429/Retry-After 的服务端等待保留；普通连续错误不再触发退避，仍按节奏轮换查询，故障通知继续限频。Telegram、转发均沿用现有通道；按同一门店/配置的库存事件通知：持续有货不重复，确认无货后再次有货立即重新提醒，API 报错不算无货。没有 30 分钟抑制。

Mini 语音和 dashboard 是独立服务，本命令不迁移它们。Mac 接收器可继续自行通知；若要在 MacBook 部署语音，需要另改音频设备名，不能照抄 `Mac mini Speakers`。Mini dashboard 不会自动读到 MacBook runtime。

Agent 应回报实际 commit、凭据文件路径（不含值）、唯一运行进程、health、查询样本成功率/耗时/退避及 Mini 停止情况。不要重播旧 outbox 或重置前台人工接手页面。

## 5. 性能与网络

Python 主要等待 HTTPS 网络 I/O，最多四个工作线程，解析约 72 项库存；预计 CPU 负担远小于多个 Safari 页面刷新，但尚未在目标 MacBook 实测，不能保证零影响。安装好后用活动监视器观察 Python 与 Safari 的 CPU、内存和网络，分别判断。

API 和浏览器共享 MacBook 网络。约 122 KB 的解码正文 × 每秒一次，约 0.98 Mbps、10.5 GB/天，仅是无停顿持续运行的正文估算；不是压缩后传输量或代理账单。手机热点需考虑套餐与代理计费。移动到同机可省 Mini→Mac 的一次传输，Apple/代理响应仍是主要等待部分；未测不能保证总流程明显加快。API 配置只影响 Python 的显式代理，不修改 Safari 的网络或系统 VPN。
