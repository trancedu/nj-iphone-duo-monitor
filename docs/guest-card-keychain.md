# Guest 卡片的本机 Keychain 存储

已将当前测试卡的 number、expiry、CVV 合并成一个 Generic Password 条目存入 macOS 本机 Keychain。服务名 `com.trancedu.iphone-duo.guest-card`，账户名 `checkout-card`，标签 `iPhoneDuo Guest checkout card`。未启用 iCloud 同步，也不是 Apple Wallet 卡片。

实现：`mac_receiver/keychain/card-store.swift` 使用 Security.framework 的 SecItemAdd / SecItemUpdate / SecItemCopyMatching。卡片不经过命令行参数：写入走 stdin，读回走被父进程捕获的 stdout。不要手工运行 helper 的 `read` 子命令到终端，它会输出秘密。

编译后的专用 helper 位于 `~/.config/iphone-duo/card-keychain`，权限0700，使用本机 ad-hoc 代码签名。替换或重新签名 helper 可能触发 Keychain 授权；Keychain 锁定或授权失败时脚本报 `guest_card_keychain_unavailable`，不会回退到假卡或旧环境变量。程序可读取卡片意味着拥有调用该 helper 权限的同用户进程也可能请求读取，不能将此当作脚本级访问隔离。

`~/.config/iphone-duo/guest-payment.env` 现在只含：

```dotenv
APPLE_GUEST_CARD_SOURCE=keychain
```

原三个明文卡片变量已从该文件移除，未生成明文备份。脚本使用原来的 `--env-file` 命令即可读取 Keychain。未设置 source 的旧环境变量模式仍兼容，生产 prepared-payment 模式仍不会主动读取卡片。

验证：原值和 Keychain 读回三项逐一匹配；交互程序读取约27ms；临时 LaunchAgent 后台读取成功约28ms；迁移后新进程没有三个明文卡片环境变量也能读取。临时探针任务已移除。验证过程未操作浏览器、未提交订单。

已运行的进程不会因文件修改自动清除原先继承的环境变量；下次正常重启时才会加载 source-only 配置。此轮不为清理进程环境而中断库存接收。Keychain保护静态存储，填表时数据仍需进入程序及浏览器内存。

## CVV 混淆（当前：989）

Keychain JSON 的字段仍叫 `cvv`，保存值改为 `989 - 原CVV`；读取时同样以 `989 - 保存值` 还原到三位字符串，保留前导零。原 CVV 为990–999时保存负数也可还原。卡号和有效期不变。

私有 `.env` 增加 `APPLE_GUEST_CVV_MODE=mixed`，使用时必须加载该配置。程序保留旧 subtract_1003 解码兼容用于迁移，但当前条目已改用989。它是可逆混淆，不增加密码学安全性，不能防止能读代码及调用 helper 的同用户进程。报告与测试输出不包含保存值或还原值。
