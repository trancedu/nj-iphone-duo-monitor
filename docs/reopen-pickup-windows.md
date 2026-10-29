# 手动重建 Safari 自提窗口

桌面入口：`重建Safari自提窗口.command` 可选一个配置或全部；`重建全部六个自提窗口.command` 顺序处理六个。终端完成后输入 R 可重跑。脚本不会自动定期运行。

只重建精确匹配的 Duo Profile、单标签、已就绪且无库存任务的窗口。活动任务、付款或联系人／Review 页面、失效或恢复中的窗口会拒绝关闭；应先使用“恢复自提就绪”。全部模式逐个关闭并重新准备，每次只使一个配置暂时不可用；任何失败立即停止后续窗口。

流程：校验空闲 Pickup → 创建外部维护租约阻止同款新任务抢占 → 再次核对 → 关闭精确窗口 ID → File / New Window / New 对应 Profile Window → 校验新窗口 ID 和 Profile → 检查购物袋恰好一台对应型号 → 取消可识别的 Apple Account 登录提示并 Guest Checkout → 配送地址及 Keychain 付款预填 → Review 页只点击 Change shipping method → 自提／07094 → 绑定接收器到新窗口。

不会退出整个 Safari，不会操作 Personal 或 PickupTest18Pro，不清 Cookie、不清购物袋、不自动补货，也不会点击 Place Your Order。若购物袋为空或型号／数量不符则停止。恢复会使用已配置的真实配送、联系和付款资料，但不执行下单。

只读 DOM 在已就绪页面可能读不到遮挡它的原生弹窗；关闭操作始终按 Safari 对象的精确窗口 ID/Profile/单标签执行，不依赖易受桌面/焦点影响的 Window 菜单来定位旧窗口。新开窗口需要 macOS 辅助功能权限。请在 Mac 解锁时运行，原生菜单操作时避免同时点击其他 Safari 菜单。

报告保存在接收器 runtime-router/reopen-reports，包含旧/新窗口 ID、各阶段时间及全体 WebKit 进程 RSS 合计。RSS 不是 Activity Monitor 的完整内存占用，也不含已压缩／换出的全部页面；其他页面的变化会影响前后总量。关闭旧窗口可能帮助回收页面内存，但 Safari 可以保留缓存进程，无法保证释放固定容量。必要时应在计划停机窗口完全退出 Safari。

## Apple Account 遮罩的处理

优先取消明确识别的 Apple Account 登录提示；准备阶段对原生窗口恢复／控件加载留最多20秒。取消未确认、原生窗口不可见或原生调用失败时只记录 `setup_native_signin_cancel_unconfirmed`，随后尝试精确 Guest Checkout。不能仅凭灰色遮罩断定页面不可操作。Guest、配送、付款预填和自提页仍须分别验证，真正的步骤失败仍停止。不会对未知弹窗或付款面板盲发ESC。

现场观察：Apple Account sheet 仍显示时，JavaScript 已从Sign In推进到Billing。一次ESC未立即改变弹窗；Computer Use点击已识别的Cancel后弹窗关闭。该次测试有人工式UI辅助，不能用于证明弹窗总会自行消失或所有机器都能自动取消。

## 直接辅助功能取消（2026-10-28 后续修正）

取消逻辑首先沿用两次 smoke test 成功的路径：直接读取已存在的原生辅助功能树 → 精确识别 Apple Account/商店域名/唯一 Cancel → 点击 → 再直接检查弹窗已消失。首次探测和取消后的确认都不切换 Window 菜单；只有目标窗口确实不可见时才用菜单定位备用。保留取消不确认时的警告及 Guest 路径验证。

手动重建也允许源页面停在空闲的 Guest Sign In 入口，不要求用户先完整恢复自提才能关闭重建。活动任务仍拒绝关闭，联系人／付款／Review 页面仍拒绝回收。最终就绪验证仍严格要求 Fulfillment、自提选中与邮编07094，登录入口不算最终成功。
