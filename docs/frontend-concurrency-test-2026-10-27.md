# Safari 前台三事件并发测试 — 2026-10-27

用户要求同时发送 512GB 白色、256GB 白色、再一条 512GB 白色，观察不同 Profile 并行和同 Profile 排队。相同请求在聊天中重复出现，本次只执行一轮三事件，未发九条。

## 方法

美东 07:58:31，通过 Mini 的既有认证 LAN 接口，三个工作线程同时 POST /prepare。统一门店 Apple American Dream（R755）、ZIP 07094；使用三条不同 event_id，保留各自 payload。两条 512GB 是不同事件，不是同 ID 重发去重测试。没有改变库存监控、重新发送真实到货 Telegram、重启 Mac 接收器或重置已有任务。

发送前 authenticated health 为 live / Safari / 四 Profile ready，各 Profile 没有 active_event_id 或 pending_events。Mini 三次发送开始时间相差约 0.24 毫秒。

## 接收与队列

批次 ID：ffea999c11da。

| 事件 ID 后缀 | 商品 | Profile | POST 回执 | 往返时间 |
|---|---|---|---|---:|
| `512gb-ffea999c11da-1` | 512GB Star White | C | 202 queued | 0.432 秒 |
| `256gb-ffea999c11da-2` | 256GB Star White | A | 202 queued | 0.460 秒 |
| `512gb-ffea999c11da-3` | 512GB Star White | C | 202 held | 0.447 秒 |

完整 event_id 均以 sim-concurrent-white- 开头。Mac 收到三条的时间范围为 UTC 11:58:31.462–11:58:31.491。C 首事件 execution_started_at 为 11:58:31.466，A 为 11:58:31.493，相差 27 毫秒，说明不同 Profile 的任务独立启动。第三条进入 C 的 held 队列，没有 execution_started_at，没有抢走第一条 C 任务的页面。

## 实际浏览器结果

截至美东 08:00:16 的状态查询：

| 任务 | 状态 | 原因 | 执行开始到结束 |
|---|---|---|---:|
| C / 第一条白色 512GB | manual_review | safari_step_timeout | 24.252 秒 |
| A / 白色 256GB | manual_review | safari_step_timeout | 40.392 秒 |
| C / 第二条白色 512GB | held | 等前一条任务释放；仍受配置 TTL 限制 | 未执行 |

C 首任务完成 bag_verified_at 和 checkout_clicked_at，但没有 pickup_page_ready_at。最后安全诊断为 secure6.store.apple.com、/shop/apw/checkout、Fulfillment-init，ZIP 显示 07094，没有识别到门店行。

A 任务约 2.9 秒到达 pickup_page_ready_at，之后执行了多次不可用检查；第九次刷新后等待步骤超时。最后安全诊断页面为 www.apple.com/shop/bag，没有门店行。仅凭这些证据不能认定是 Apple 限制 IP、Safari 并发缺陷、服务端返回购物袋或人工导航造成，尚未定位根因。

两条前台反馈均记录 foreground=true、audio_queued=true、notification_submitted=true；audio_queued 表示音频入队，不等于已核验实际播放完成。两条均记录购物袋验证完成，未出现 add_clicked_at；这不代替测试结束后的人工购物袋检查。

## 结论与保留状态

**事件接收、正确路由、不同 Profile 独立启动和同 Profile 串行排队符合预期；端到端浏览器流程未通过，前两条都安全停止于人工检查。**

没有 store_selected_at、time_selected_at 或 handoff_at；没有付款授权或提交订单。C/A 的 manual_review 锁保留，不自动 reset、不清空购物袋；C 的第二条不会越过前一条锁执行，held 超过 TTL 后应过期而非重新加购。

需要在 Mac 上检查对应 Safari 窗口、必要时由用户明确完成/放弃并本机 reset。本次测试没有擅自释放这些锁。真正库存事件如果路由到仍锁住的 Profile，会按接收端配置排队或拒绝；Mini 的库存检测和独立 Telegram 提醒仍继续。

私密证据：runtime/front-concurrency-test/ffea999c11da/manifest.json，包含原始测试 payload、首次接收结果和状态快照。此目录被忽略，不提交密钥、Cookie、联系资料、完整结账页面或原始截图。
