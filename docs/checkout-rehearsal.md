# Apple 结账辅助流程：2026-10-26 浏览器实测

## 本次实际验证的范围

使用用户指定的 iPhone 18 Pro 256GB Burgundy 链接，在当前 Chrome 中操作：

1. 商品页已有 No trade-in、一次性 Buy、Connect to any carrier later。
2. 点击 **No AppleCare coverage**，确认选中。
3. 点击 **Add to Bag**，进入配件推荐页。
4. 点击 **Review Bag**，进入购物袋。
5. 单台测试机的购物袋中点击 **Check out with Pay**。
6. 进入 Apple 的 **How would you like to get your order?** 取货/配送页面。
   这时还没有打开最终 Apple Pay 付款确认面板。
7. 页面默认选择 I’ll pick it up、Apple West 14th Street、October 26。
8. 选择 **9:15 a.m. – 9:30 a.m.**，点击 **Continue to Pickup Details**。
   页面先显示 Processing，最终跳到 Apple 404 页面；原生按钮重试也未成功推进。

另一次尝试：编辑取货位置为 **07094**、取消保存位置、点击 Apply 后曾进入
Apple 的 404 页面。已返回取货步骤。不能将这次实测描述为 07094 完整结账通过。

**没有点击 Pay、Place Order 或任何最终付款确认；没有填写个人联系方式或银行卡。**
没有创建订单，也没有证明保留了库存。Duo 有货时的流程尚未实测。

测试开始时购物袋含多台 Duo，并提示超过每人两台限制。用户随后明确确认，测试时
用户本人正在同步清理购物袋，允许继续测试。目前购物袋仅显示一台测试用 18 Pro。
后续脚本仍禁止自动清理购物袋，并在加购前要求空袋、结账前要求只有一台完全匹配
的手机，以免重复加购或携带额外商品进入结账。

## 记录产物

`checkout_rehearsal.py` 是根据本次 CUA 实际操作及可见 DOM **整理的 Playwright
回放脚本**，不是此次 Chrome 操作的原生 codegen 文件。这次没有生成原生
Playwright trace 或连续录像，不能声称脚本已用 Playwright 端到端回放通过。

本次截图保存在 Git 忽略的
`runtime/checkout-rehearsal/pickup-handoff.png`；错误截图为
`runtime/checkout-rehearsal/checkout-404.png`。浏览器已返回取货步骤供人工检查。

## 回放与录像

与库存轮询程序分开运行，不接入自动下单触发器。脚本不包含最终付款点击。
需要桌面 Chrome；使用独立 Chrome 用户目录，避免接管正在使用的默认个人资料。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-checkout.txt
.venv/bin/python -m playwright install chromium
.venv/bin/python checkout_rehearsal.py
```

默认打开 18 Pro 测试链接。先读取独立会话的购物袋：只有空袋才加购；选择不买
AppleCare，核对无换购、一次性付款、稍后连运营商。加购后再次检查仅一款正确商品、
数量为一，随后进入 Apple Pay 取货入口，并交给用户选择门店、日期、时间。
购物袋非空、出现额外商品或控件改变时停止，不自动删商品或重复加购。

同一独立会话已经有那一台测试机时，可以跳过再次加购：

```sh
.venv/bin/python checkout_rehearsal.py --resume-bag
```

仅在明确确认当前页面有对应门店、日期和时间时，才传入全部三个参数。下例复现
本次测试选择，日期和时间是历史值，不应原样用于未来购买：

```sh
.venv/bin/python checkout_rehearsal.py --resume-bag \
  --store 'Apple West 14th Street' \
  --pickup-date 'october 26' \
  --window '9:15 a.m. – 9:30 a.m.'
```

脚本只点击到 Continue to Pickup Details，下一页控件、取货联系人、订单审核、
Apple Pay 系统面板、设备确认等全部由人处理。它不会猜测后续按钮，也不会填入虚假
资料。可见的“附近有货”信息不等于已经选择并确认取货方式，需要复核结账页的门店
和总额；本次购物袋与结账页的估算总额也不同。

为将来验证 Duo，可以传 `--url` 与 `--product-name`，但需要重新验证该页面及库存。
该参数支持不代表 Duo 流程已经跑通。库存 API 的代理轮换不应用于当前购物或支付
会话；此脚本没有轮换 IP 功能。

每次回放在 `runtime/checkout/<运行时间>/` 保存：

- 步骤截图及 `report.json`：记录停在哪一步。
- `trace.zip`：Playwright 步骤和网页快照，在人工填写资料之前停止 trace。
- `videos/*.webm`：浏览器页面录像，按终端 Enter 关闭会话后才完成保存。

查看 trace：

```sh
.venv/bin/python -m playwright show-trace /absolute/path/trace.zip
```

浏览器网页录像不能代表录到了操作系统的原生付款确认窗口。人工接手时，视频仍会
记录网页画面，直到关闭会话；若将填写个人资料，应先结束本次回放。所有会话、截图、
trace 和视频均保留本地且由 Git 忽略，不要发布含个人资料的录制文件。

Playwright 官方说明：[Trace Viewer](https://playwright.dev/python/docs/trace-viewer)、
[录像及保存时机](https://playwright.dev/python/docs/videos)。
