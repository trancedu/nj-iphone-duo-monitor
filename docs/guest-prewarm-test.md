# Guest 配送预填后切换自提：隔离测试

脚本：`mac_receiver/safari/guest_prewarm_test.mjs`。仅允许 `PickupTest18Pro` 单窗口、单标签及购物车内一台匹配的 iPhone 18 Pro；不添加商品、不提交订单，也不部署到六个生产窗口。

1. 从现有购物袋点击普通 Check Out。
2. 精确识别本测试窗口的 Apple Account 面板，先 Cancel，再 Continue as Guest。
3. 默认配送选项就绪后 Continue to shipping and fulfillment。
4. 填写配送地址与配送联系人，等待邮编查询完成，核对城市和州，再 Continue to Payment。
5. 选择 Credit or Debit Card。配送流程默认 Use my shipping address，账单地址隐藏；验证勾选后填写并核对环境变量中的卡号、有效期、CVV。
6. 点击 Continue，等待 Review；绝不点击 Place Your Order。
7. 点击 Change shipping method，切换 I’ll pick it up，设置并验证 07094。
8. 复用生产 Guest 脚本的测试模式：刷新、首个可用门店、第二个有效时间窗口、自提联系人、Continue，验证付款保留并停在最终 Review。

配送地址私有配置：`~/.config/iphone-duo/guest-shipping.json`，权限0600。配送姓名/联系方式独立于 `pickup-contact.env`，不混用。卡号仍从 `guest-payment.env` 加载，报告不保存卡片或联系人值。

运行前将测试窗口留在购物袋，并确认其中只有目标手机一台：

```sh
node --env-file="$HOME/.config/iphone-duo/guest-payment.env" \
  --env-file="$HOME/.config/iphone-duo/pickup-contact.env" \
  mac_receiver/safari/guest_prewarm_test.mjs \
  --config "$HOME/Library/Application Support/iPhoneDuo/receiver-safari/receiver.router.local.json" \
  --shipping "$HOME/.config/iphone-duo/guest-shipping.json"
```

与现有测试共用 `PickupTest18Pro.lock`，防止两个测试操作同一窗口。报告在 `runtime/safari-regression/*-prewarm.json`。此脚本不维持长期会话；付款仅在同一有效会话中可能保留，过期后需要重新准备。假卡到 Review 不表示发卡行授权成功或可用于真实下单。
