# Mac mini 代理轮询部署

本机目录：`/Users/trance/coding/iPhoneDuo`。这是独立的实验服务，不替换
`monitor.py` 原有的双区域服务。轮询 ZIP 为 **07094**，使用该 ZIP 已验证的
12 家门店列表。每次批量查询 256GB/512GB 两种颜色的全部四款，沿用配置中的四款
iPhone Duo、可选门店、今天至未来三天取货的严格验证。

## 当前本机更新（2026-10-26）

正式服务现在使用 `--all-subscriptions --max-nodes 256 --workers 4`，读取 Clash Verge Rev
本地缓存的所有 remote 订阅。不会输出或重新下载订阅 URL，不切换客户端当前选中的订阅。
节点以订阅文件标识加前缀，避免重名；流量/到期说明项被排除。只支持直接含 `proxies`
的缓存订阅，provider-only 配置会明确报错，不会假装已载入。

每次启动测量所有候选节点的 IPv4 出口，按 IP 去重；相同 IP 跨订阅共享限速和冷却。
上限 256 是节点配置条目数，不是成功出口数。运行期间导入或更新的订阅在重启服务后读取。

库存查询最多 4 个在途请求，每次发起至少间隔两秒，不突发补发；同 IP 至少间隔 60 秒且
不同时在途。网络 I/O 在工作线程，冷却、去重和通知状态均由主线程处理。
429 / Retry-After 停止后续派发；已在途请求允许完成。失败出口仍按原规则冷却。
两秒是查询发起的目标间隔，不是保证每两秒拿到一次成功库存。

当前查询 07094 的 12 家门店，每次同时包含 256GB/512GB × 星白/深色四款；不查询 1TB、2TB。每次成功响应均须含四款的完整门店数据。

## 在 Mac mini 上部署

2026-10-26：用户已取消原定早上 07:50 的自动启动，相关 Codex 自动化已删除。
现在由用户在 Mac mini 手动部署；仓库不会自动创建早晨启动计划。

1. 在 Mac mini 的登录用户下安装 Python 3.9+，安装 Clash Verge Rev、导入订阅并启动一次。
   需要 `ruby`（标准 YAML 支持）；无需 pip 包。程序自行指定代理入口，系统代理和 TUN 不必打开。
2. 如果尚未下载仓库，先执行：

   ```sh
   git clone https://github.com/trancedu/nj-iphone-duo-monitor.git
   cd nj-iphone-duo-monitor
   ```

   已有仓库则进入其目录执行 `git pull --ff-only`；有本地修改时先自行合并，不要覆盖。
3. 验证本地代码：

   ```sh
   python3 -m unittest discover -s tests -v
   ```

4. 准备 Telegram 配置文件，可复用生产环境现有文件，或者：

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   在编辑器中填入 Bot Token 与 Chat ID；不要提交 `.env`。
5. 先运行十分钟测试：

   ```sh
   python3 deploy/proxy_service.py start-test --env-file /absolute/path/private.env
   cat runtime/proxy-monitor/current.json
   ```

   `status` 最初为 `preparing`（检测代理出口），之后应为 `running`，十分钟后为
   `completed`。检查 `counts`、`unique_exits` 及 `telegram_configured`；非空凭证标志
   不能证明 Telegram 已送达。配置了凭证的测试也只在发现符合规则的有货库存时发送。
6. 测试完成后卸载测试任务，再启动持续服务：

   ```sh
   python3 deploy/proxy_service.py stop-test
   python3 deploy/proxy_service.py start-live --env-file /absolute/path/private.env
   ```

   启动前先检查是否还运行原来的 `com.trancedu.iphone-duo-monitor`。如果本次是替换
   原监控，应先停止原监控，避免两套程序叠加请求；原监控附带的 watchdog 也应一并停止，
   否则会把主动停机当作故障。不要同时运行两套服务。

默认读取当前用户的 Clash Verge Rev 配置，并使用应用内的 Mihomo。非默认安装可指定：

```sh
python3 deploy/proxy_service.py start-test \
  --env-file /absolute/path/private.env \
  --clash-config /absolute/path/clash.yaml \
  --mihomo /absolute/path/mihomo
```

`start-live` 同样支持这些参数。安装器根据本机仓库目录和当前 Python 解释器生成
LaunchAgent，无需复制旧的、带另一台电脑绝对路径的 plist。需要已登录的 macOS 用户
会话。服务在用户登录时启动，异常退出后不会自动重启，需检查日志后手动启动。
`start-live` 立即启动并持续运行，不是定时到早晨才启动。

原始实测结果见 [十分钟测试报告](proxy-monitor-ten-minute-2026-10-25.md)：
150 次查询中 89 次成功、39 次 HTTP 541、22 次网络错误。它仍是实验性方案，
没有验证到每两秒一次成功查询或长期不被限流。

## 调度及错误处理

- 最多读取 256 个真实节点，可合并所有本地缓存 remote 订阅；订阅流量/到期说明项不算节点。
- 每次启动对实际节点做一次非苹果 IPv4 检测，按出口去重；无法测出 IP 的节点不参与库存查询。
- 为每个节点启动独立的本地 HTTP 入口，固定转发到指定节点，不改变 Clash Verge 运行配置。
- 库存请求发起间隔至少两秒，最多 4 个在途请求；容量不足时顺延，不突发补发。
- 相同出口每次请求启动至少间隔 60 秒。多个节点名共用 IP 时，也共享此限制。
- 403、541 首次冷却五分钟，连续失败延长为十分钟、二十分钟等，最多一小时。
- 其他查询错误首次冷却一分钟，重复错误延长；绝不作为无货处理。
- 429 或 Retry-After 会触发**全局**退避，至少五分钟或更长的服务端要求。
- 冷却及每个 IP 上次请求时间持久保存，重启不会清空。池为空闲时等待，不改变身份进行即时重试。
- 锁防止本实验程序重复运行。日志及 JSON 保存在 `runtime/proxy-monitor/`，Git 忽略。
- 所有响应都会记录结果；成功抓取不等于有货。只发送符合既有库存规则的 Telegram 提醒，且相同门店/机型/取货日期 30 分钟内去重。
- 不发送失败、无货或测试成功消息。Telegram 请求使用独立直连通道；发送失败只本地记录。
- 不自动打开浏览器，不选门店、不下单。临时代理进程在退出时停止，包含节点凭证的临时配置会删除。

实际出口 IP 是 IP 查询网站观察到的结果，不能证明 Apple 观察到完全相同的地址；
节点地区名称来自订阅标签。此方案不保证避免限流或拦截。请求变慢、节点冷却、
可用出口少于 30 个时，不可能始终达到每两秒一次成功查询。

## 十分钟测试

```sh
python3 deploy/proxy_service.py start-test
```

由当前 macOS 用户的 LaunchAgent 运行。准备代理池之后轮询 600 秒，然后退出。
使用 `caffeinate -i` 避免测试期间空闲睡眠，但电脑关机、断网或合盖睡眠仍会影响运行。
任务不设置自动重启，以免十分钟到期后重新开始。完成检查之后必须卸载测试任务，
避免其 RunAtLoad 在后续登录时再次运行：

```sh
python3 deploy/proxy_service.py stop-test
```

查看状态：

```sh
cat runtime/proxy-monitor/current.json
python3 deploy/proxy_service.py status
```

## Telegram 配置

用户已明确：本机只做测试，不需要 Telegram；正式凭证将用于随后提供的 Mac mini
生产环境。因此本轮不配置、不测试、不发送 Telegram。正式环境可提供配置文件
**路径**，或在 Git 忽略的
`/Users/trance/coding/iPhoneDuo/.env` 设置：

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

使用已有配置文件时，在启动命令追加 `--env-file /absolute/path/private.env`。
凭证只读入进程，不写入报告、不输出到聊天或日志。报告字段
`telegram_configured` 仅代表两项非空，不代表已完成 Telegram 端到端送达验证。
用户没有要求测试消息，因此不发送测试消息。

## 手动启动与停止

早晨自动启动安排已取消。以下命令由用户在 Mac mini 按需执行。

正式启动命令：

```sh
python3 deploy/proxy_service.py start-live
```

它使用相同节点上限、间隔及冷却规则，持续运行直到停止：

```sh
python3 deploy/proxy_service.py stop-live
```

此 LaunchAgent 服务不依赖 Codex 应用保持运行，但需要电脑开机、用户已登录、订阅及网络可用。
如果 Telegram 凭证仍缺失，必须明确报告提醒功能尚不可用，不得声称通知已经配置成功。

## Bounded failure recovery

Normal queries retain the two-second cadence. A 541, 403 or network failure can dispatch an extra request through another ready exit without waiting for that cadence. The default is at most 12 early starts per rolling minute, with 0.2 seconds between any starts and the existing four-worker limit. Recovery prefers recently successful exits; per-IP 60-second spacing, cooldowns, global 429/Retry-After backoff and Telegram/LAN delivery stay intact. The recovery budget is persisted. Set `--max-recovery-per-minute 0` to disable; accepted values are 0–12. Look for `dispatch_reason: failure_recovery`, `recovery_from` and report `recovery_queries` when evaluating the change. A two-second maximum successful-response gap remains unachievable when requests fail or take longer.
