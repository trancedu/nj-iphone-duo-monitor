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

完成两次刷新仍明确无货时，先验证/恢复该 Profile 的待机页，成功才释放单 Profile 锁和全局锁，不必继续等到 60 秒。Safari 的待机页为正确商品的自提 Checkout（见下文）；Chrome 仍为正确商品、数量 1 的购物袋。恢复失败则保留锁，交给无货/错误任务的超时清理。

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
避免旧计时器误清已找到库存的任务。系统Apple Pay认证仍由用户完成。

## 用户授权：自动请求 Apple Pay 面板

`open_apple_pay_sheet: true` 启用后，联系人核对完成，程序自动点击一次明确的
`Continue with Apple Pay`，请求打开系统付款面板，然后等待用户指纹/设备认证。
默认未开启时仍停在网页按钮前。不点击系统认证、条款或其他提交按钮。
点击前持久记录尝试；按钮点击或响应结果不明时不自动重试，保留有货页面与锁。

Safari 是否接受脚本点击并实际弹出系统面板，尚需真实页面验证；本地测试仅验证流程、
按钮身份、联系人核对与单次点击。点击调用完成不能被当作面板已打开、认证完成或购买成功。
Apple官方要求Apple Pay会话由用户手势触发，若Safari未接受脚本点击，应由用户直接点网页按钮：
https://developer.apple.com/documentation/applepayontheweb/creating-an-apple-pay-session
处理完或放弃后，由用户运行清锁脚本明确结束。

## 无货/错误任务的60秒上限

尚未找到库存、仍被锁住的任务，从第一次触发计时60秒。到期停止旧控制器，只将该任务所在Profile回袋，
清理任务与全局锁，然后恢复接收。清理/网络可能需要额外几秒。回袋失败也结束超时旧任务并记录错误。
其他Profile不刷新；10秒候选在控制器重启后过期，不补跑。

计时器每秒只读取本地状态和时间，不查询Apple、不读页面、不截图。重启不延长原期限。

## 手动清锁

双击桌面 `clear-locks.command` 或 `clear-chrome-locks.command`，两者都会识别当前正式后端：
暂停接收 → 取消旧任务及候选 → 依次验证/恢复四个购物袋 → 清锁 → 恢复接收；Safari 启动后再串行准备四个自提 Checkout。

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


## Checkout 待机与 20 分钟维护（2026-10-27）

Safari 正式入口改为 `standby_page: pickup_checkout`。四个独立 Profile 各保留一个对应配置、数量 1 的商品，从购物袋点击 Check out with Apple Pay，停在未选店的自提页。无货后的正常释放也回到这一页。启动和手动清锁时若需要重建，先验证购物袋商品和数量，再进入 Checkout，不清空购物袋或重复加购。

用户本次口述 07049；独立测试页提交后 Apple 明确提示 “Please enter a valid city, state or zip code.”，用户随后确认使用之前有效的 **07094**，四个页面与 Safari 接收端配置均已保持一致。Checkout 待机模式固定使用接收端配置的邮编，不能被后来事件中的旧邮编覆盖；显式环境变量覆盖仍优先。

- `idle_checkout_refresh_interval_seconds: 1200`：空闲时每 20 分钟维护；四个 Profile 的维护时间错开约 10 秒，且全局一次只维护一个。由于活跃请求和维护可能延后，不是硬实时每 1200 秒。
- 库存事件先抢占全局锁；若恰有一个维护请求在途，只等它结束，不启动其他窗口的维护。然后只刷新目标配置的 Checkout 窗口，读取新库存，省掉正常路径中的购物袋到 Checkout 跳转。
- 已有窗口没有正确待机页或刷新后会话回购物袋时，从已验证的购物袋重建一次；错误、登录或验证码等异常停止交给人工。
- 找到库存后沿用保护锁；选店、时间、联系人、付款阶段均禁止定时维护或自动返回。无货仍最多额外刷新两次，再释放并考虑 10 秒内最新候选。
- 手动清锁脚本仍先终止旧工作、取消旧候选、验证购物袋并清锁；接收端重新启动后会串行准备 Checkout 待机页。Chrome 未启用 Checkout 待机模式。

20 分钟是维护策略，**不是 Apple 已确认的会话过期时间**。页面仍显示不证明服务器会话有效；一次维护成功也不保证未来 20 分钟一定有效。独立测试页约 7 分钟后仍能收到 Apple 的邮编校验响应，只能证明该次操作得到服务器响应，不能推导固定超时。实际性能以事件的 `standby_refresh_at`、`pickup_page_ready_at`、首次库存观察和后续选店时间为准。


验证：Node 全套 157 项通过；最后补充的待机专项共 7 项通过，覆盖 1200 秒边界、请求抢占、串行维护、已选店页面保护与过期回袋重建。真实 Safari 四个 Profile 均核对到自提选中、07094、零已选门店；启动日志四个 `standby_checkout_startup` 均成功，健康检查 ready=true、global_locked=false。尚未等待一个完整的 20 分钟维护周期，也未用真实到货事件验证新路径的实际提速。


## 每分钟会话过期巡检（2026-10-27）

`checkout_session_check_interval_seconds: 60` 在现有 Safari 接收程序内执行，接收程序运行时持续有效。它每分钟读取各 Profile 的本地 DOM 小摘要，不截屏、不刷新健康页面、不主动访问 Apple。只把可见的精确标题 `Your session has expired.` 和可见的 `Return to Bag` 控件同时出现认定为已过期；控件支持链接、按钮和 ARIA 按钮。

巡检和原有 20 分钟维护共用全局串行通道；有活跃请求、全局锁、恢复工作或入站预留时让路。已经选店/进入联系人/付款的页面保持保护，巡检不清锁。对空闲且明确过期的页面，从购物袋验证对应商品、数量 1，重新进入 Apple Pay Checkout、自提和邮编 07094，再确认待机页。它不把正常缺货、页面内容未加载、网络错误、登录或验证码当作明确过期。

过期恢复失败会退避至少 3 分钟，避免每秒或每分钟反复访问 Apple。成功恢复后重新计算 20 分钟维护时间；健康巡检不会延后原维护期限。健康接口各 Profile 的 `checkout_session_watch` 提供最近巡检时间及 ready / expired / recovered / protected / failed 状态，正常无变化不弹通知。

这是对已经显露在页面上的过期状态的检测；若服务器已失效但页面尚未显示过期，本地只读检查无法证明其有效。原有 20 分钟维护及事件到来时的单窗口刷新仍保留。


本轮实测：全套 162 项通过，后续恢复专项/路由 39 项通过，购物袋等待相关 40 项通过。接收端已启用 60 秒检查，健康接口记录到 A 在 2026-10-27 15:47:49 美东完成 ready 检查。15:47:57 美东新到的 B / World Trade Center 事件已发现可用库存并选店、选时间，之后进入 manual_review，因此全局有货保护锁阻止其他窗口维护与控制器重启。巡检主体已上线；购物袋字段等待、导航时空 body 防护、失败后续恢复状态这三项最终修复已同步到运行目录，将在下一次手动清锁/正常重启时加载，未为部署中断该有货页面。


## 默认展开自提门店列表（2026-10-27）

自提 Checkout 待机准备完成、事件首次刷新完成，以及无货后的每一次额外刷新后，都会点击存在且唯一可见的 Show more stores，并等待已读到的所有门店行可见，再判断库存。不选取默认第一家门店，目标门店和有货页面保护策略不变。

本轮人工修复 C / Duo512White（原来仍选配送）和 D / Duo512Black（原来会话过期）。实际界面验证：两个均为自提 Checkout，邮编 07094，各显示 12 家门店且列表已展开，无会话过期提示。现有 B 的 manual_review 有货保护任务与全局锁保留；只在任务已停止执行后重载接收程序，启动时因保护锁存在而跳过自动预置，未导航该任务页面。待机专项 11 项通过，Safari 相关回归 40 项通过。


## 会话恢复与条件展开的最终规则（2026-10-27）

用户观察到约 30 分钟可能过期；这是现场观察，不作为 Apple 固定时限。继续保留 20 分钟的空闲维护和 60 秒的本地会话检查，最终恢复点始终是 Apple Pay Checkout → I’ll pick it up → 07094，而非购物袋。购物袋只是重建过期会话的中间步骤；恢复验证失败不算成功。

- **有可见的** “There's no availability within your location. Please try another search.”：不点 Show more stores；按现有规则最多额外刷新两次。即使目标门店没有列出，该明确的区域无货提示也按限次无货处理。
- **没有这条可见提示**：展开门店列表，再检查指定门店是否 enabled。没有提示不等于有货，仍以门店可选状态为准。每次刷新和会话重建均重新判断，隐藏的旧提示不计。
- 事件正在 queued/running、发通知、释放或接收预留时，全部维护让路；任务停在 awaiting_user/manual_review 后，允许对其他窗口做本地检查，且只对明确过期的窗口执行恢复，锁存在期间不做周期性主动刷新。
- **持锁任务自己的页面明确过期**（精确可见过期标题 + Return to Bag，且页面未报告付款/受保护阶段）才记录 `checkout_session_expired_at`，标记 `session_expired_recovering`，恢复自提待机页。验证成功后才结束这个失效任务并释放它自己的锁；普通无货、未知页面、超时或有货页面不触发这个例外。
- 恢复失败继续保留锁，至少退避 3 分钟；已确认过期的恢复状态持久保存，程序重启后可以继续。新消息仍只处理对应配置的窗口，目标有货才继续选店和时间。

这一节取代上文“有任意全局锁就停止所有巡检”和“所有情况都默认展开”的旧行为。

本次最终规则测试：Safari 工作流、待机恢复、路由与接收适配共 75 项通过。条件展开与失效持锁任务恢复已同步到正式运行目录并重载，已有非过期任务锁未手动清除。


## 最新覆盖规则：60 秒硬期限与接收端关闭语音

用户明确要求任务不超过一分钟。正式 Safari 和备用 Chrome 配置均设置 `global_lock_timeout_seconds: 60`、`protect_stock_from_timeout: false`。期限从首次抢占全局锁计时，不因已发现库存、选店、时间或 awaiting_user 而延长。这覆盖此前有货页面无限保护规则。计时器约每秒检测；到期独立清理进程先终止旧控制器，复核锁拥有者，然后清掉 Profile/全局锁，随后恢复页面与接收。Apple 加载或恢复耗时不延长锁；恢复完成前服务仍可能短暂不可接收。原有 10 秒候选过期规则不变，重启不重播旧候选。

Safari 最终仍恢复到 Apple Pay Checkout → I’ll pick it up → 07094。显示区域无货提示时不展开，否则展开门店再检查指定店。

两个后端配置 `speech_enabled: false`；Safari 接收端语音通道不再排队 `/usr/bin/say`，禁用语音后不会用终端铃声替代库存播报。服务器播报不受影响；桌面通知和原有错误提示音保留。Chrome 当前无相同的 say 播报实现。

验证：硬期限/路由/语音/待机相关 Node 62 项通过，Python 清锁 8 项通过；生产健康检查四个 Profile ready，global_locked=false，protect_stock_from_timeout=false，期限 60 秒。旧的 World Trade Center 锁已由新超时策略清除。

完整回归补充：Node 全套 172 项通过，Python 清锁 8 项通过；部署后健康检查 ready=true、global_locked=false。


## 过期倒计时弹窗的续期处理

Safari 正式配置使用 `checkout_session_check_interval_seconds: 30`。巡检读取本地 DOM，不截图、不刷新健康页面。识别可见的 “Are you still shopping?” 会话弹窗及唯一可见的精确按钮 “I’m still shopping”；点击一次并确认弹窗消失。控件缺失、同名按钮多个或不是该弹窗时停止，不猜测点击。续期后不返回购物袋、不切换选店/联系人页面，也不延长库存任务的 60 秒硬期限。成功续期重置 20 分钟空闲维护计时。

库存事件开始时也检查并关闭该会话弹窗，再继续原流程。已经过期则仍按此前规则重建到自提待机页。queued/running、信号发送、释放或入站预留期间巡检让路，因此 30 秒是空闲时的检查频率，不能保证机器休眠/浏览器无响应期间及时点击。

倒计时处理验证：Safari 工作流与待机专项共 48 项通过；部署后四个 Profile 健康接口均确认 checkout_session_check_interval_seconds=30，ready=true、global_locked=false。实际弹窗当时已消失，点击验证使用本地模拟页面完成，尚无真实弹窗自动续期成功的现场记录。
