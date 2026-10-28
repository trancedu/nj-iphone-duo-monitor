# 自提执行策略：只做最先到的一条，忙时丢弃，不排队

更新：2026-10-27。适用于仓库 ProfileRouter 的 Safari 与 Chrome。
本次规则替代旧的10秒候选补跑。Mac当前LAN接口不可达，运行版本尚未确认更新；不能声称仓库默认已在Mac生效。

## 一次只操作一个页面

空闲时新收到的请求立即取得全局锁。执行期间其他机型、其他门店的通知不会操作页面，
不会覆盖当前任务。相同事件ID的重发返回原状态，不重复执行，不延长等待时效。

进入自提后先检查一次；目标门店明确不可选时最多额外刷新 **2次**，共最多3轮检查。
目标门店未显示时，先展开“Show more stores”并等待目标；不会默认选第一家门店。
若目标未列出或明确不可选，先核对页面实际位置：不等于配置ZIP（当前07094）、或只显示城市
无法确认ZIP时，每任务只尝试一次打开位置编辑、输入配置ZIP并Apply，再检查目标门店。
不通过反复刷新或反复改ZIP探测；已经发现可用目标时不改位置。无法唯一识别位置控件则停止供人工处理。
未知页面、服务错误、缺目标门店不等于明确无货。

## 明确无货后提前释放

完成两次刷新仍明确无货时，先将该 Profile 恢复到正确商品、数量1的购物袋，恢复成功才释放
单Profile锁和全局锁。不必继续等到60秒。回袋失败则保留锁，交给无货/错误任务的超时清理。

## 忙时后续事件直接丢弃

最新用户规则：第一条取得全局锁后，后续事件直接返回409 / busy，不打开页面、不排队、不补跑，
也不会选择后来更长或更高价值的库存。当前任务完成或放弃并释放后，只能接收那之后的新事件。

`single_active_request=true` 时仓库默认 `drop_busy_events=true`。被拒绝的事件持久化为终态busy；
同一event_id在解锁后重发仍返回原busy，避免延迟重试突然开单。新event_id在空闲时可以立即开始。
旧global_waiting记录会过期，调度器不执行它们；health显示 `busy_event_policy=drop`、
`recent_request_ttl_seconds=0`。旧10秒最新候选机制仅在显式 `drop_busy_events=false` 时保留兼容，
不属于本次用户选择，不能在部署时意外打开。

短窗口如果先到也会占住任务并挡住后面的长窗口。这是“只做第一条”的取舍，
不能在复盘中预先过滤短事件再选择好机会。详见[严格单任务机会重算](opportunity-first-only-2026-10-27.md)。

## 最重要：有货就保留页面，不自动解锁

一旦目标门店被观察为可自提，就写入 `pickup_stock_found_at`。随后无论正在选店、选时段、填写联系人、
等待用户付款，还是后续出现错误，都不执行自动回袋、不释放全局锁、不补跑其他任务。
状态 `awaiting_user` 和后续关键阶段也构成保护，即使旧任务没有有货标记亦同。

**有货保护优先于60秒期限，且跨服务重启保留。** 自动清理助手在停止控制器前后再次检查保护标记，
避免旧计时器误清已找到库存的任务。最终Apple Pay和提交订单仍由用户完成。
处理完或放弃后，由用户运行清锁脚本明确结束。

## 无货/错误任务的60秒上限

尚未找到库存、仍被锁住的任务，从第一次触发计时60秒。到期停止旧控制器，只将该任务所在Profile回袋，
清理任务与全局锁，然后恢复接收。清理/网络可能需要额外几秒。回袋失败也结束超时旧任务并记录错误。
其他Profile不刷新；10秒候选在控制器重启后过期，不补跑。

计时器每秒只读取本地状态和时间，不查询Apple、不读页面、不截图。重启不延长原期限。

## 手动清锁

双击桌面 `clear-locks.command` 或 `clear-chrome-locks.command`，两者都会识别当前正式后端：
暂停接收 → 取消旧任务及候选 → 依次恢复四个购物袋 → 清锁 → 恢复接收。

这是用户明确的完成/放弃操作，**会离开当前有货页面**；仍要付款时不要运行它。
自动超时不会这样处理受有货保护的页面。

## 配置

```json
{
  "single_active_request": true,
  "drop_busy_events": true,
  "release_global_on_unavailable": true,
  "recent_request_ttl_seconds": 0,
  "global_lock_timeout_seconds": 60,
  "pickup_unavailable_retries": 2,
  "queue_while_busy": false,
  "queue_when_browser_not_ready": false,
  "auto_release_unavailable": true,
  "release_on_task_tab_close": false,
  "handoff_idle_timeout_seconds": 0,
  "idle_bag_refresh_interval_seconds": 0
}
```

还需私有配置中的 `global_timeout_python` 与 `global_timeout_unlock_script` 本机路径。
各Profile的旧held队列保持关闭，忙时事件不进入任何候选队列。

## 代码与验证

- `mac_receiver/profile_router.mjs`：全局锁、忙时终态丢弃、重复拒绝幂等、有货超时保护。
- `mac_receiver/engine.mjs`：明确无货回袋后通知router释放；有货后失败保留页面。
- `mac_receiver/browser.mjs`、`safari/shopping.mjs`：目标门店验证、展开、有货标记和两次刷新。
- `deploy/clear_receiver_locks.py`：停止控制器后清理，自动清理二次核验有货保护。
- 测试覆盖四条HTTP同时到达仅首条执行、忙时事件解锁后重发仍不执行、有货三种状态免超时和回袋失败保留锁。

真实库存与checkout可能存在竞争/不一致；明确无货不能证明原因一定是“被别人抢走”。
独立测试CLI不提供跨进程统一调度，不能与正式服务同时控制同一Profile。


## Mac 上启用与验收

先同步代码并保留Mac本机更新的pickup待机实现及私有配置。确保single_active_request=true、
drop_busy_events=true、recent_request_ttl_seconds=0、queue_while_busy=false。
仅在没有需要保留的有货/付款任务时按现有部署说明重载接收器；不要为了改策略清掉正在付款的页面。
检查认证GET /health返回busy_event_policy=drop、recent_waiting=0、recent_request_ttl_seconds=0。
默认变化不会依赖旧TTL值；但显式drop_busy_events=false必须移除或改为true。

本次Mini只修改并测试仓库代码，没有通过不可达的Mac接口更改配置、重置锁或操作浏览器。
