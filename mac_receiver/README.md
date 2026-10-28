# Mac 接收与浏览器程序

当前正式策略以[首条独占、60秒释放说明](../docs/pickup-execution-policy.md)为准：
Chrome/Safari 共用全局首条锁，后续请求不排队、不补跑，最多额外刷新2次；默认drop_busy_events=true，忙时拒绝的ID解锁后也不会重放。
尚未发现库存的错误任务可在60秒后清理；已发现库存或待付款页面保留至人工完成/放弃。历史的独立队列和闲置返回行为不在此模式启用。

这是**接手购买的 Mac**运行的程序。Mac mini 只监控库存、发 Telegram 和 LAN 事件。完整部署、验收命令和另一位 AI 的测试清单在 [两机部署说明](../docs/split-pickup-deployment.md)。

依赖 Node.js 22+、Google Chrome、已登录的 macOS 图形会话。`npm ci` 安装锁定版本的 Playwright。Chrome 使用 `apple-browser-profile/`，不使用日常配置目录。首次登录、Apple Pay / Touch ID 可用性必须在这套专用浏览器中手动验证。

默认 `dry_run: true`、`prewarm_browser: false`，不打开浏览器、不加购。示例中的三个结构选择器只是占位，必须在接收 Mac 的真实英文 Apple 页面核验，才可设置 `selectors_verified: true` 并启用 live。布局、数量或商品不明确时停止，不能为跑通而跳过检查。

接口都需要 Bearer 认证和来源 IP 许可，不接受浏览器 Origin 请求：

| 接口 | 行为 |
|---|---|
| `GET /health` | 返回 dry-run/live、浏览器进程状态、当前锁；不保证账号和 Apple Pay 已就绪 |
| `POST /prepare` | 202 接收新事件、后台执行；同 ID 同内容 200 返回旧状态，不再执行 |
| `GET /status/<event_id>` | 阶段时间和结果，不返回页面、Cookie、付款信息 |
| `POST /reset` | 仅回环来源，`{"event_id":"...","confirm":true}`；运行中禁止重置 |

不同内容复用 ID 返回 409；全局忙碌返回 409 busy，该事件不会排队或稍后自动执行。live 的成功、失败、全部无货均保留人工锁，必须明确本机 reset。重启将未完任务标为 interrupted，不重新加购。已记录事件最多 4096 个，满后拒绝新事件；停止服务后由人工归档状态，勿在有待接手购物袋时清空。

浏览器只实现这些动作：检查购物袋 → 必要时打开商品/选择 No AppleCare/一次 Add → Review Bag/验证同款一台 → Checkout with Apple Pay → I’ll pick it up → 等待门店 → 置前、响铃、停止。默认模式停在门店列表。用户明确配置 `pickup_details` 后，可选择指定门店和取货时段、点击 Continue to Pickup Details 并填联系人；始终停在 Continue with Apple Pay 前，不授权付款或提交订单。 若 Apple 页面要求登录、验证码、ZIP 或其他步骤则保留页面交接，不自行绕过。

日志 `runtime/events.jsonl` 只包含 ID、状态、阶段时间。`events.json` 为去重保存商品 URL 与可选门店名称；均不保存 Cookie 或结账页面。共享密钥只从环境加载。人工浏览器配置本身包含登录态，应只保留在 Mac 本机，不上传或提交。

## CDP 与手动清空购物袋

常驻正式 Chrome 的 CDP 连接、单次自提命令和独立清空命令见 [CDP 操作说明](../docs/chrome-cdp-shopping.md)。`clear-bag` 默认预览，`--confirm-clear` 才移除商品；库存事件不会调用清空。

当前用户授权配置可启用自动旧袋清理、held 等待队列，以及关闭任务标签页释放；相同 Profile 的新标签页/新窗口共享购物袋，不能用来隔离并发。队列只由常驻 server.mjs 调度，CLI 不调度队列。详见 CDP 操作说明。

五页预热模式：`warm_product_pages:true`，四个 Duo 商品页预选 No AppleCare，第五页用于购物袋核验和 checkout。预热不加购；收到事件时只 Add 一次，加购后必须验证唯一目标一台。第 5 页关闭后的锁内空袋清理/重新预热完成才放行下一任务。实测和维护命令见 [五页预热测试](../docs/five-page-warm-benchmark-2026-10-26.md)。


## Safari production backend

The receiver supports `browser_backend: "safari"` with four `slots`, each having
`safari_profile` plus its canonical `product_url` and independent `state_dir`.
It reuses the same authenticated HTTP protocol, durable Engine, deduplication
and per-profile hold queue. The Safari adapter is `safari/browser.mjs`; shared
deterministic DOM/workflow code is under `safari/`. No AI participates in runtime.

Current deployment, actual Mini simulation, sounds and manual-release behavior
are documented in [Safari production handoff](../docs/safari-production-handoff-2026-10-26.md).
Safari profile windows must be open when starting the LaunchAgent. Closing a sole
work window requires reopening the same profile before automatic close-release
can restore its cart. Safari quitting does not release active locks. Local reset
restores the correct bag before releasing held work. The final Apple Pay button
is always left for the user.
