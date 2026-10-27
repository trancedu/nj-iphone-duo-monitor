# 当前生产：纯 DataImpulse，每秒一次

2026-10-27 用户在三档独立比较后授权切换。现有 LaunchAgent `com.trancedu.iphone-duo-proxy-live` 已改为执行 `dataimpulse_monitor.py`；旧 `proxy_monitor.py` 和其监控专用 Mihomo 实例退出，不再读旧订阅池发库存请求。用户系统自己的 Clash 应用未被关闭或修改。

## 调度与持久状态

- 美国 Rotating，urllib，与一秒档基准相同的传输方式和 12 秒 socket 超时。
- 目标每秒发起一次，每请求覆盖 07094 的 12 店和四款 256/512GB 黑白配置，最多四项在途。客户端在工作线程构造，避免拖慢主线程节奏。
- 慢请求占满名额时等待，不积累后突发追赶。因此实际发起与成功刷新间隔不是一秒硬保证。
- 这次是持续服务，duration=0；不再使用混合试验的 200 次、绝对 expiry 或正文预算。旧试验状态保留审计，不会决定新模式是否运行。持续运行会产生付费流量，之前一秒档外推约 8 GB 正文/天仅作参考，不等于账单。
- Rotating 的逐请求实际出口无法核验，记录 ip=null、actual_exit_ip_verified=false，不能报告“多少个健康 IP”或保证逐个实际 IP 一分钟不重复。

保留 runtime/proxy-monitor/state.json 的 sent、旧 exits、既有 LAN outbox 和可用库存日志；增加 dataimpulse_live 子项记录健康状态、累计和当前生产模式当天正文量。每天字节只统计此生产入口，不是整个 DataImpulse 账户当天总账单。

每个成功响应仍由 proxy_monitor.parse_offers（复用 monitor.regional_payloads/parse_inventory）检查店铺覆盖、四款配置、可选状态及近三天日期。有效 offer 仍走同一个 monitor.notify_offer：到货 Telegram、30 分钟去重、LAN 后台 outbox 和 Mac Profile 路由均未替换。

## 错误与重启

普通网络错误/541 后继续下一个按节奏排定的 rotating 请求，不进行额外无限快速补发。429 或 Retry-After 进入共享的服务端等待；并发旧请求的成功不会取消服务端等待。

连续十次失败后暂停至少一分钟，后续连续失败逐步延长，最多十五分钟；普通失败的等待可在真实成功后解除。故障 Telegram 冷却十分钟，同一故障只在通知成功后记录一次恢复消息，避免抖动刷屏。通知凭据缺失或 Telegram 本身不可达时不能保证送达，错误不会打印认证 URL 或原始异常。

LaunchAgent 在图形登录会话启动，caffeinate 保持空闲唤醒。异常退出可自动重启，节流一分钟；手动 stop/bootout 不会被重启策略重新拉起。共有 monitor.lock 阻止新旧进程重叠，安装器在旧进程退出并释放锁后才启动新入口。

## 操作命令

```sh
# 明确切到纯 DataImpulse；保持已有通知 env 和独立代理私密 env
python3 deploy/proxy_service.py start-live --provider dataimpulse \
  --env-file /Users/codex/.codex/secrets/market-radar.env \
  --proxy-env-file /Users/codex/.codex/secrets/dataimpulse.env
python3 deploy/proxy_service.py status
python3 deploy/proxy_service.py stop-live
```

代理配置文件权限必须为 600。安装器先校验本地凭据格式，再停止旧服务，备份旧 plist 到 runtime/proxy-monitor/service-backups。provider 选择保存到 runtime/proxy-monitor/live-provider.json；后续未传 --provider 的 start-live 复用该选择，即使先 stop-live 删除 plist，也不会悄悄恢复旧池。首次全新安装且无保存值时才使用 clash 默认模式。

若确实要回滚，明确传 `--provider clash`；不能同时启动两种入口。`deploy/enable_pickup_bridge.py` 现在认可两种监控入口，但旧的外部临时脚本未自动修改。

## 状态与日志

保留同一位置：runtime/proxy-monitor/current.json、各时间目录的 report.json/queries.jsonl/last-inventory.json、availability-events.jsonl、pickup-bridge/。关键标志：backend=dataimpulse_only、uses_original_pool=false、dataimpulse.mode=continuous、target_start_spacing=1、workers=4。unique_exits=null / pool=[] 表示没有已核验 IP 名册，不能解释成零连接或服务故障。

只记录安全状态、时间、字节数与异常类型，不记录共享密钥、代理密码、Cookie 或付款页面。生产 env、state、备份和原始日志均不提交。

切换前 78 项 Python 测试通过，包括原池不被调用、共用通知/去重状态、429 与恢复区别、故障通知冷却及客户端构造异常安全处理。切换后的真实查询与当前统计见对应 runtime 目录；短期成功率和最大 gap 不构成长期保证。

前台独立测试记录见 [三事件并发测试](frontend-concurrency-test-2026-10-27.md)：接收/排队正常，但两条 Safari 工作流超时，不能视为端到端通过。
