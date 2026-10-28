# 接单与下单诊断日志

所有时间为 ISO 8601 UTC，可换算成美东时间；通过 event_id 关联整次请求。

## 文件

各配置 state_dir 下：
- events.jsonl：接单、重复通知、等待/过期、步骤、错误、结果观察、释放锁。schema_version=2 包含 sequence、previous_stage、since_previous_stage_ms、since_received_ms、since_execution_ms、signal_age_ms、active_event_id、lock_owned、checkout_method。重复步骤保留每条记录，不只依赖最终 timestamps。
- diagnostics.jsonl：门店是否列出/可选、邮编、Guest 页面阶段、提交是否返回、是否结果不确定。仅白名单字段，不记录卡号、CVV、联系人、HTML 或带会话参数的 URL。
- session-watch.jsonl：空闲会话检查结果、窗口、周期、是否到定期刷新时间、检查耗时。活跃任务或受保护页面可能跳过维护，不代表每30秒刷新。

三类日志各10 MiB轮转，保留当前文件及 .1、.2，文件权限0600。旧事件归档后可被覆盖，应及时保存故障时间段。

## 如何分析

1. 按 event_id 过滤 events.jsonl（包括轮转文件），按 at、sequence 排序。比较 detected_at、received_at、execution_started_at，区分通知传输和本机排队。
2. 查看刷新、门店、日期/时间窗口、联系人、Review、guest_order_requested_at、guest_order_click_returned_at 的时间差。点击已返回不表示订单成功。
3. 查看对应 diagnostics.jsonl 的 guest_page_transition_at、pickup_inventory_observed_at 和 pickup_failure_observed_at。Guest 错误会额外保存结构化错误码；不保存任意异常原文。
4. browser_operation_summary_at 按 operation 汇总调用次数、total_ms、max_ms、dom_ms。bridge/total 包含 AppleEvent、浏览器执行和系统等待；不是纯网络耗时。DOM计时只覆盖相应同步脚本，不能代表全部渲染。当前日志不采集网络响应明细，不能据此精确拆分网络与异步渲染。汇总仅在流程退出时写入；硬退出时可能缺失。
5. configuration_lock_released 表示锁已清除；是否恢复Pickup还应核对 payment_failure_pickup_restored_at 或会话就绪记录。未知下单结果保持现场，不因日志改动自动重试。

日志采集复用已有读取，不额外刷新、截屏或读取付款信息。修改不改变购物或提交策略。
