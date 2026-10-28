# Guest Checkout 信用卡填表实验

本实验仅绑定 `PickupTest18Pro` 的单标签窗口和一台 iPhone 18 Pro 256GB Burgundy，独立于正式 iPhone Duo 接收服务。卡号、有效期和 CVV 支持本机环境变量。测试 CLI 在填表核对后点击 Billing Continue，进入 Review Order 后停止，绝不点击 Place Your Order。生产调用接口支持显式的最终提交；尚未切换现有生产库存接收流程。

## 流程

1. 准备：验证购物袋恰好一件目标手机、数量为一；普通 Check Out → 检测 Apple Account 原生登录面板并点 Cancel → 确认面板关闭 → Continue as Guest → I’ll pick it up → 设置并核对 07094。
2. 待命：保持 Guest 的 `/shop/checkout?_s=Fulfillment-init`，与 Apple Pay 的 `/shop/apw/checkout` 区分。
3. 模拟信号：刷新待命页一次，复用现有生产脚本选择首个可用门店、有效日期、第二个有效时间窗口；填入已有测试配置的取货联系人。
4. 联系人回读通过后，Continue to Payment 仅点击一次。即使点击响应因导航消失，也不重试点击。
5. Billing 页面选择 Credit or Debit Card，填假卡及账单地址。邮编查询返回前持续等待，不因空下拉框而提前判为填写成功。
6. 若 City 和 State 分开：分别填 City、选择 State；若组合下拉框：选择精确的 City, State。回读国家、邮编、城市、州和所有填入字段，两次连续一致才算完成。
7. Billing Continue 仅点击一次，等待 Review Order。测试模式停在 Review；只有显式生产模式才允许最终点击，并核对目标产品、数量一和含税总额上限。

共享 `prepareSafari` 的库存、门店、时间和联系人逻辑，通过实验适配层改变联系人页的完成条件，保持生产路径不变。适配层禁止 Add、Apple Pay、自动重建 checkout；非预期页面直接停止，不混用两种 checkout 会话。

## 运行

在仓库根目录运行；需要 Safari 已允许来自 Apple Events 的 JavaScript，测试窗口只有一个标签。配置文件保留在本机，不提交联系人或地址。

```sh
# 完整准备 + 模拟信号 + 填表
node mac_receiver/safari/guest_checkout.mjs --config /absolute/path/test.local.json --billing /absolute/path/billing.local.json

# 连测三轮；每轮计时从自提页开始刷新，不包含轮间恢复
node mac_receiver/safari/guest_checkout.mjs --config /absolute/path/test.local.json --billing /absolute/path/billing.local.json --rounds 3

# 只准备到 I’ll pick it up / 07094
node mac_receiver/safari/guest_checkout.mjs --config /absolute/path/test.local.json --prepare-only

# 已在 Guest 自提页，只跑模拟信号后的流程
node mac_receiver/safari/guest_checkout.mjs --config /absolute/path/test.local.json --billing /absolute/path/billing.local.json --run-only
```

`--billing` 可以省略，默认使用 Test Example / 1 Example Street / 07094 / Secaucus / NJ 的示例地址。支持的地址字段如下：

```json
{
  "first_name": "Test",
  "last_name": "Example",
  "street": "1 Example Street",
  "street2": "",
  "zip": "07094",
  "city": "Secaucus",
  "state": "NJ"
}
```

报告写入 `runtime/safari-regression/*-guest.json`。准备耗时与信号后耗时分开，信号后计时从刷新前开始，覆盖库存、时间、联系人、进入 Billing、填表和地址核对。报告不记录联系人、完整地址或真实卡信息。与 Apple Pay 回归测试共享同一个窗口锁，避免两个测试同时操作。

## 验证边界

真实 Safari 测试只证明 Guest 页面导航、脚本填表和回读。无效测试卡不能证明银行授权、反欺诈检查、3DS、地址验证、库存保留或最终下单成功。实验未接入正式库存通知，不改变现有生产 Apple Pay 行为。

## Apple Account 登录面板处理（2026-10-28）

已实测 Safari 在普通 Check Out 后，会在 Guest 页面上方弹出原生 Apple Account / Touch ID 登录面板。它不在网页 DOM 里，不能用网页中的 Guest 按钮状态判断它是否关闭。

实验脚本通过 AppleScript / System Events 只检查 `PickupTest18Pro` 窗口的原生 sheet：同时匹配 Apple Account、store.apple.com、Use a different Apple Account 和 Cancel 后，才点击 Cancel。随后重新检查，确认 sheet 不存在，才允许 Continue as Guest。不会用全局 Escape，不会取消 Apple Pay，不会触碰其他配置窗口。

未出现面板时保留 2 秒出现等待；出现无法识别的 sheet、取消失败或重复出现的登录面板时停止，不继续 Guest。相关阶段会记录为 `apple_account_cancel_clicked` → `apple_account_prompt_closed` → `guest_continue_clicked`，用于核对顺序。

### 本轮真实 Safari 验证

2026-10-28 美东 16:01 的完整重跑成功。日志顺序：16:01:11.360 点击 Apple Account Cancel → 16:01:12.576 确认原生面板关闭 → 16:01:12.981 点击 Continue as Guest。随后准备到自提 07094，并从那里跑到信用卡填表和 City/State 回读通过；没有提交支付。

报告：`runtime/safari-regression/1793217662879-guest.json`。准备耗时 15.8 秒，模拟信号后耗时 39.9 秒。本轮耗时高于前一轮 24.0 秒；联系人页面、付款页面及账单表单和地址查询等待均有增加，未进行网络抓包，不能进一步断言全部属于网络耗时。原生 Cancel 在预先准备阶段完成，不计入信号后耗时。

14 项相关自动测试通过，覆盖 City/State 两种布局、假卡限制、阻止提交、原生面板延迟渲染、取消确认、未知面板停止等场景。

## 刷新起点计时与减少通信

`from_refresh_ms` 使用最终回读完成的时间减去 `standby_refresh_requested_at`，以自提页开始刷新为统一起点；不包含购物袋、原生 Cancel、Guest 登录入口、邮编预设或轮间恢复。`elapsed_ms` 另外保留模拟信号开始后的全部操作耗时。

联系人准备改为一次 Apple Event 完成页面就绪检查、共享生产 DOM 填写和 Guest 按钮就绪核对；City/State 设置及账单回读也合并为一次调用。保留首次信用卡控件加载检查和两次连续回读，避免用提前结束计时掩盖未填写完成。

`--rounds 3` 的后两轮从当前测试 Guest 会话恢复到 Fulfillment 页面，然后重新核对自提和 07094；不重复进入购物袋或 Apple ID 登录入口，不改变生产会话。每轮报告单独记录所有阶段。

### 优化后三轮刷新起点实测

报告：`runtime/safari-regression/1793217908163-guest.json`。三轮都完成假卡、账单地址和 City/State 回读，没有点击 Billing Continue，没有提交支付。

| 阶段（秒） | 第 1 轮 | 第 2 轮 | 第 3 轮 |
|---|---:|---:|---:|
| 刷新开始到取货联系人核对完成 | 9.677 | 9.415 | 4.050 |
| 联系人核对到 Continue to Payment 点击 | 0.879 | 0.424 | 0.456 |
| 等待 Billing 路由 | 8.730 | 0.420 | 0.428 |
| 信用卡控件、表单出现及填写 | 10.031 | 1.242 | 0.983 |
| 城市/州地址查询与连续回读 | 10.063 | 0.476 | 0.624 |
| **总计：刷新到全部核对完成** | **39.380** | **11.977** | **6.541** |

三轮平均 **19.299 秒**，中位数 **11.977 秒**；后两轮平均 **9.259 秒**。最快 6.541 秒不代表稳定速度，样本不足以承诺固定延迟。第一次 Billing/表单/地址等待明显更长，但没有网络抓包，不能确定都是网络还是缓存、页面初始化等原因。实际 DOM 填表分别只有 54、53、52 毫秒。

## 环境变量和 Continue / Place Your Order（最新行为）

三个变量需一起设置：

- `APPLE_GUEST_CARD_NUMBER`：允许空格或横线，填表前移除。
- `APPLE_GUEST_CARD_EXPIRY`：`MM/YY` 或 `MMYY`。
- `APPLE_GUEST_CARD_CVV`：3–4 位数字。

用户提供的本次测试值保存在本机 `~/.config/iphone-duo/guest-payment.env`（权限 600，仓库外）。不把卡号或 CVV 写入文档、报告或提交到 Git。未设置任何变量时保留全零假卡回退；只设置部分变量会报错，错误信息不回显卡号。

```sh
node --env-file="$HOME/.config/iphone-duo/guest-payment.env" mac_receiver/safari/guest_checkout.mjs --config /absolute/path/test.local.json --billing /absolute/path/billing.local.json
```

测试 CLI 强制使用 test 路径：填写 → 核对 → Billing Continue → Review Order → 停止。测试 Profile 即使被误传 production 也拒绝提交。若 Apple 显示表单验证错误，返回 `billing_validation_failed`，不反复点 Continue。

生产代码接口：`runGuestSignal(window,url,config,billing,stage,{mode:'production',max_total_usd:授权的含税上限})`。默认 mode 为 test。生产接口在 Review 核对唯一目标手机、数量一、含税总额不超过上限、正确最终按钮，然后点击一次 Place Your Order。提交标记先写入 sessionStorage，导航回复丢失也不得自动重试；返回 order_requested 不代表订单成功。此接口未接入现有六窗口库存接收服务，生产 Apple Pay 流程保持原样。

真实 Safari 本轮验证：使用用户提供的测试卡，Billing Continue 成功到达 `_s=Review`，观察到 Place Your Order，返回 `review_ready_test_stopped`，未提交订单。测试报告 `runtime/guest-checkout/continue-test.json` 不含卡号。旧计时报告只到填表完成；新报告额外提供 `to_review_from_refresh_ms`，计入 Continue 后到 Review 的等待。

## 复用当前 Guest 会话保留的付款信息

联系人 Continue 之后同时接受 Billing 或 Review 两种目的地。Apple 已保留本会话付款信息时，会直接到 Review；旧实现只等待 Billing，导致即使已到最终确认页仍报超时。

新实现到 Review 后，只在付款摘要区域核对卡号后四位、账单姓名、街道、单元号、邮编、城市和州。全部匹配就直接复用，不再打开 Billing、不触发邮编查询、不重新填写 CVV。Review 不展示完整卡号或有效期，因此这里核对的是可见摘要，不声称已验证完整卡信息。若摘要不匹配，点账单 Change 回到 Billing，按当前环境变量重新填写和回读。

Billing 页面仍仅更新与配置不一致的字段，已匹配的值不会触发 input/change。无论走哪条路，测试都在 Review 停止，不点 Place Your Order。报告用 `payment_details_reused: true` 标识复用，最终刷新到 Review 耗时使用 `to_review_from_refresh_ms`。

这种保留状态属于 Apple 当前会话，脚本不额外保存完整卡号到浏览器本地存储，也不保证换会话或过期后仍有效。

### 复用路径三轮实测

报告 `runtime/safari-regression/1793218947860-guest.json`。三轮刷新到 Review 就绪分别为 5.489, 5.763, 5.359 秒，平均 5.537 秒。三轮全部 payment_details_reused=true、付款摘要核对通过、test 停在最终 Place Your Order 之前。此前两次失败未计入成功轮次平均：一轮联系人按钮缩写，另一轮 Apple 跳过 Billing 直达 Review；均已记录并修正，不代表订单成功。

## 取货联系人环境变量

可使用现有 `pickup_details.first_name / last_name / phone / email` 配置，也可逐字段使用环境变量覆盖：

```dotenv
APPLE_PICKUP_FIRST_NAME="Test"
APPLE_PICKUP_LAST_NAME="Example"
APPLE_PICKUP_PHONE="2015550123"
APPLE_PICKUP_EMAIL="test@example.com"
```

优先级：已设置的环境变量 > 对应配置字段；未设置的字段继续使用配置，不覆盖门店或时间偏好。显式空值、无效邮箱、无效电话直接报错，错误不回显私人信息。美国电话允许空格、括号、横线及 +1，规范化为 10 位。

本机文件 `~/.config/iphone-duo/pickup-contact.env` 已从现有测试配置建立，权限 600，仓库外保存。与卡片文件一起加载：

```sh
node --env-file="$HOME/.config/iphone-duo/guest-payment.env" --env-file="$HOME/.config/iphone-duo/pickup-contact.env" mac_receiver/safari/guest_checkout.mjs --config /absolute/path/test.local.json --billing /absolute/path/billing.local.json
```

环境覆盖支持 Guest 实验和共享 Safari / Chrome 取货填写代码。现有生产服务尚未部署这次更改；当前服务仍按其既有配置运行。只编辑 env 文件不会改变已运行服务的进程环境，需要在启动命令加载相应文件并重启才会生效。
