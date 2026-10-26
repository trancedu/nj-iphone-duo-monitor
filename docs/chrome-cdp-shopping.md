# 常驻正式 Chrome、CDP 自提与独立清空购物袋

使用已安装的 Google Chrome Stable。自动化 Chrome 必须以独立 **user-data directory** 启动；Chrome 窗口里的 Profile 名称与 user-data directory 是两回事。

当前用户选择的 James 在默认 Chrome 数据目录内，且没有开放 9222。现有浏览器连接能操作 James，但以下独立 Node 脚本不能直接接入这个进程。不要关闭所有日常窗口来尝试无效的默认目录 CDP，也不要复制 James 的 Cookie、密码或整个 Profile。

官方依据：[Chrome 默认目录调试限制](https://developer.chrome.com/blog/remote-debugging-port)、[Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)。

## 启动与检查

在仓库根目录执行：

```sh
npm --prefix mac_receiver ci
sh mac_receiver/start_shopping_chrome.sh
```

这个终端保持运行。脚本使用 `~/.apple-shopping-chrome`，9222 绑定回环地址；不要把 CDP 端口暴露给 Mini。独立 Chrome 的首次登录、钱包和 Touch ID 由用户在新窗口中完成。不要用相同名称暗示它已复用 James 登录态。

另一个终端：

```sh
cp mac_receiver/receiver.cdp.example.json mac_receiver/receiver.cdp.local.json
node mac_receiver/shopping.mjs check --config mac_receiver/receiver.cdp.local.json
```

必须只开一个 Apple 工作标签页。多个 Apple 标签页时脚本拒绝猜测。CLI 与接收器共享 `state_dir/receiver.lock`，操作前停止同配置接收器；异常遗留锁需要先确认原进程确实退出。CLI 结束后保留 Chrome。

## 一次执行到自提

示例结构选择器来自当前 James 的 DOM，仍需在独立 Chrome 验证全部商品行和门店 radio。保持 `selectors_verified:false` 直到这项验证完成。`pickup_zip:07094` 是本次用户确认的邮编，可修改成自己的测试值。

核验后，将 local config 的 `selectors_verified` 改成 true：

```sh
node mac_receiver/shopping.mjs prepare --config mac_receiver/receiver.cdp.local.json \
  --event-id manual-duo-001 \
  --url 'https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked'
```

`prepare` 是明确的真实页面操作命令，不受接收器的 dry_run 控制；命令本身检查 selectors_verified。它检查已有购物袋、复用同款一台或加购一次，然后 Apple Pay → 自提 → 填写配置邮编 → 等待门店列表。未配置邮编时停下。出现登录、验证码、钱包授权或未知页面时交给用户。

脚本不选门店或时间，不点击后续 Continue/Pay，不提交订单。不确定是否加购成功时重新检查购物袋，不重复点击 Add。失败、无货或到达交接阶段都会保留持久化人工锁。

同 ID 再执行只返回旧结果。准备下一个事件前，用原 bridge_client 的本机 reset 操作明确重置；CLI 本身不清空旧锁。若当前只是接收器 dry-run，其测试事件完成后没有人工锁。

## 清空 bag：独立命令

仅清空当前连接的 Apple 购物袋商品，不清 Cookie、登录态、Chrome 数据或事件状态，也不取消任何已提交订单。默认预览：

```sh
node mac_receiver/shopping.mjs clear-bag --config mac_receiver/receiver.cdp.local.json
```

明确执行清空（会移除该购物袋内全部商品）：

```sh
node mac_receiver/shopping.mjs clear-bag --config mac_receiver/receiver.cdp.local.json --confirm-clear
```

清空命令不在 HTTP 接口上提供，也不会被库存事件自动调用。若存在未重置的人工交接事件，先检查页面并用本机 reset 解锁。每次只点击一个已核验商品行的 Remove，等待该 ID 消失，再处理下一件；结果不确定时停止，不盲目重试。最后必须看到 `Your bag is empty.`，否则报告失败。

## 接收器复用常驻 Chrome

先停止 CLI，再按原部署文档启动 Node 接收器，将 `cdp_endpoint` 留在 local config 中即可复用同一 Chrome。LAN 接口仍默认 dry-run；只在专用 Chrome 完整验收后开启 live。Mini 的源 IP 白名单、Bearer 密钥和 LAN 端口配置仍按原部署说明处理。

## 可选：填写 Pickup Details 后交接

默认仍停在门店列表。用户明确授权后，可在私密 local config 中加入 `pickup_details`：

```json
{
  "pickup_details": {
    "store_name": "Apple West 14th Street",
    "preferred_slot": 2,
    "min_lead_minutes": 0,
    "first_name": "YOUR_FIRST_NAME",
    "last_name": "YOUR_LAST_NAME",
    "email": "YOUR_EMAIL",
    "phone": "YOUR_10_DIGIT_US_PHONE"
  }
}
```

仅写入 `*.local.json`（权限 600，Git 忽略）；不要把真实联系人写入示例、测试、日志或提交。配置会把这些信息填入 Apple 的自提联系人表单，因此仅在用户明确授权后开启。

流程先检查指定门店可选，再选择该店；保留当前可用日期，无已选日期时选择最早可用日期。时段按 America/New_York 计算，当前配置优先第 2 个仍在未来的可用时段，不要求晚一小时。未知格式或指定门店不可用时停止，不随意换店。

然后只点击 **Continue to Pickup Details**，选择本人取货，填写并回读核验四个联系人字段，确认最终 Apple Pay 按钮可见且可用，然后锁定并交给用户。**绝不点击 Continue with Apple Pay，不接受最终条款、不授权钱包、不提交订单。** 旧版文档中“不选择门店、时间、不点击 Continue”的约定适用于没有开启该扩展的默认模式。

从头重跑时复用已验证的同款一台，不重复加购。需要从空袋重测时，用户先清理购物袋并明确允许重置上一轮任务。程序不会在任务完成后自动清空购物袋。

## 自动待命、旧购物袋和等待队列

本次用户授权配置已启用以下选项（示例默认仍关闭，需明确授权后开启）：

```json
{
  "auto_clear_bag": true,
  "queue_while_busy": true,
  "max_pending_events": 8,
  "held_event_ttl_seconds": 180,
  "release_on_task_tab_close": true
}
```

- 空袋正常开始；同款一台直接复用。其他旧商品只在当前任务已释放、下一任务开始后清理，不在人工付款期间清理。未知购物袋布局仍停止，不能冒险删除。
- 第二个请求返回 HTTP 202 / held，持久化去重，不修改当前任务页。最多等待 8 个事件，满时 queue_full。超过检测时间 180 秒的待执行事件过期，不会用旧库存信号启动；重启会取消旧 held 事件，避免无人确认的重放。
- 在常驻 server.mjs 中，用户关闭**当前专用任务标签页**代表完成或放弃，自动释放锁、新建工作标签页，并依序取下一条未过期事件。完成付款后关闭和放弃后关闭都使用这一手势。关闭其他标签页不起作用；任务仍运行时关闭不会自动解锁。
- 关闭整个 Chrome / CDP 断连不当作释放，原任务锁保留。主服务和浏览器恢复后需要明确处理旧任务。
- 同 Profile 的新标签页和新窗口已实测共享购物袋，不能隔离并发订单；当前采用单实例串行。真正隔离要用不同数据目录，并另外验证登录后是否共享账号购物袋。
- 单次 shopping.mjs CLI 不负责队列调度；自动释放/下一任务必须由常驻 server.mjs 处理，默认同状态目录的独占进程锁可防止 CLI 并发抢占。

取货时段当前策略是第 2 个未禁用、仍在未来的选项，不要求晚一小时。若只有 1 个有效时段则使用该时段；未知日期/时段格式停止。细分日志新增 bag_checked_at、details_navigation_at、details_page_ready_at、contact_fill_started_at，可区分 Apple 页面等待与字段填写；日志不记录联系人值。

## 实验：四款预加购后只留目标

用户授权后，停止常驻接收器并明确释放已完成的旧任务，再执行：

```sh
node mac_receiver/preload_duo.mjs --config mac_receiver/receiver.cdp.local.json
```

只接受四款已知 Duo、每款一台；跳过已存在的款，不重复加购。其他商品、重复数量、加购不确定均停止，不自动删不认识的商品。预加购不计入到货信号响应时间。

私密实验配置增加 `"bag_strategy":"preloaded_duo"` 后，正常 prepare 命令会先核验目标存在，再删除其余已知款，只保留目标一台并复核；目标缺失时停止，不误删全袋。删除等待商品行和数量实际更新，不能只依据旧按钮消失。该模式与活动任务锁互斥，不会在人工付款中补货。

实测单次同款对照：普通空袋流程 5.438 秒，四款预置流程 6.018 秒，准备时间均未混入。暂不替换默认方案，详细记录见 [四款预置测试](preloaded-duo-benchmark-2026-10-26.md)。每次删三留一后，需要另外补齐三款才能再次测试。

## 当前采用：四个预热商品页＋一个购物袋／结账页

`warm_product_pages:true` 启用五页模式，不启用之前的四款预加购模式。四个商品页仅选择 No AppleCare，不 Add；第 5 页刷新核验购物袋。同款一台复用，空袋才在对应商品页 Add 一次；之后重新读取第 5 页，严格核验只剩目标一台，再 checkout。每次关闭已交接的第 5 页后，在锁内清理旧袋并重新预热四个商品页，完成后才放行等待事件。

人工维护命令 `shopping.mjs warm-pages --config ...` 必须在停止常驻服务、释放旧任务后使用。首次预热时间不计入信号响应。当前实测同款 6.130 秒 → 3.718 秒（单次对照，预热不计时）；细节见 [五页预热测试](five-page-warm-benchmark-2026-10-26.md)。生产即便保证空袋，也保留约 0.3 秒的初始刷新检查，以及不可省略的加购后单品单件核验。

## 当前采用：四个独立 Profile 路由

后续用户选定四独立 Profile 方案，替换五页单 Profile 监听器。主入口现在是 `profile_router.mjs --config receiver.router.local.json`；外部继续使用原来的 `/prepare`、`/status/<id>`、`/health` 和本机 `/reset`。URL 精确匹配某个 Profile；同 Profile 正在人工接管时新事件 held，其他 Profile 有自己的锁。通知会写明 Profile 字母和商品并置前窗口。关闭已完成的任务标签页后，在锁内重新预置该 Profile 的主生产款，再放行下一事件。

四个主生产款仍为 Duo 的 256/512 × 两色。本次 Pro 测试链接仅为私密路由配置里的 alias，其中 C 已更正为 512GB Burgundy。事件带 store_name 时选择对应门店；必要时展开一次更多门店。选择原生 radio 时点击它唯一对应的 label 并核验 checked，避免苹果覆盖层拦截。最后始终停在 Continue with Apple Pay 前。

四 Profile 预置后的完整资料页成功测试耗时约 13–24 秒，主要是苹果门店/资料页跳转等待；填表 55–91 ms。完整记录：[四 Profile Pro 测试](four-profile-pro-checkout-2026-10-26.md)。这与此前只到无货门店列表的 2–4 秒属于不同终点。
