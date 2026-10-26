# Mac 接收与浏览器程序

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

浏览器只实现这些动作：检查购物袋 → 必要时打开商品/选择 No AppleCare/一次 Add → Review Bag/验证同款一台 → Checkout with Apple Pay → I’ll pick it up → 等待门店 → 置前、响铃、停止。**没有选择门店、时间、Continue、Pay、提交订单的代码。** 若 Apple 页面要求登录、验证码、ZIP 或其他步骤则保留页面交接，不自行绕过。

日志 `runtime/events.jsonl` 只包含 ID、状态、阶段时间。`events.json` 为去重保存商品 URL 与可选门店名称；均不保存 Cookie 或结账页面。共享密钥只从环境加载。人工浏览器配置本身包含登录态，应只保留在 Mac 本机，不上传或提交。
