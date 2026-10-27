# DataImpulse 小规模连通性测试

`dataimpulse_smoke.py` 只做有限测试，不注册 LaunchAgent，不修改正在运行的库存调度，不发送 Telegram 或 Mac 浏览器事件，也不自动启用持续付费轮询。

私密配置在仓库外 `/Users/codex/.codex/secrets/dataimpulse.env`，权限 600。四个键为 DATAIMPULSE_PROXY_USERNAME、DATAIMPULSE_PROXY_PASSWORD、DATAIMPULSE_PROXY_HOST、DATAIMPULSE_PROXY_PORT。不得提交 env、代理认证 URL、登录密码或原始异常文本。

## 设置与协议

初测使用美国、Rotating、HTTP/HTTPS、DNS hostname。官方说明 HTTP/HTTPS rotating 端口是 823，SOCKS5 是 824；sticky 使用 10000–20000 端口，rotation interval 主要控制 sticky 会话。DNS gateway 是 gw.dataimpulse.com。

- https://docs.dataimpulse.com/proxies/types-of-connections
- https://docs.dataimpulse.com/proxies/connection-hosts
- https://docs.dataimpulse.com/proxies/parameters/session-id

Apple 查询请求用 ZIP 指定门店区域；本项目代码没有要求代理出口必须位于美国，但这不保证服务端没有其他地区判断。美国出口是当前测试选择，不需要把出口城市进一步限制到纽约/新泽西。

工具默认在内存中的代理登录参数显式设置 `cr.us`，保留已有其他参数，不重写私密 env。控制台的国家默认设置需要保存；连接正常并不意味着选中的国家已保存。一次 IP 检测也不能证明另一个 rotating 连接的出口国家和 IP。

## 命令与上限

仓库根目录：

```sh
# 默认三次小型连通性检测，不请求 Apple
python3 dataimpulse_smoke.py
# 三次检测成功且可见国家符合要求后，最多再做一次库存请求
python3 dataimpulse_smoke.py --country us --probes 3 --inventory
# Mock 测试，无真实代理流量
python3 -m unittest discover -s tests -p test_dataimpulse_smoke.py
```

probes 只能为 1–3；连通性调用 ipify 和最后一次 Cloudflare trace，后者提供 IP/国家。最后一次检测若国家与明确目标不同则跳过 Apple 请求。库存请求固定 ZIP 07094，四款配置，并调用现有库存解析器验证 12 店覆盖和库存字段；只保存状态、耗时、配置数、门店数及 offer 数，不通知或下单。

结果在忽略提交的 runtime/dataimpulse-smoke/时间/report.json。响应正文累计字节数不包含 TLS、CONNECT 等开销，不等于供应商账单流量。认证错误、代理错误等仅报告安全代码，不打印认证 URL 或原始异常。代理凭据只发送给 gateway；HTTPS 目标仍按默认 CA 验证，不禁用 TLS 验证。

## 2026-10-27 的现场测试

1. 初次使用原 env：三次出口检测成功，但国家检测显示 GB；Apple 库存请求成功，耗时 6.843 秒。因每次连接轮换，不能认定 Apple 那次就是英国出口。
2. 在连接参数中显式指定美国：三次检测成功、观察到三个不同出口，国家检测 US；Apple 返回 200、12 店、四配置，耗时 1.653 秒。
3. 用户保存控制台配置后，仅用原 env、不额外指定国家，补做一次 Cloudflare trace：US，耗时 0.780 秒。

这些是小样本 smoke test，不能当作稳定延迟、成功率或所有出口的国家保证。两次库存响应均没有 eligible offer，不触发任何通知。

## 与现有 IP 间隔规则的关系

Rotating gateway 是一个连接入口，不是固定 IP。检测 IP 的连接与随后 Apple 查询的连接可能使用不同出口；无法把单次探测结果作为该 Apple 请求的 IP 账本，也不能保证供应商不会短时间再次分配相同出口。

因此当前工具没有并入生产 IP 池，不能宣称自动继承现有“同一实际 IP 至少 60 秒再查”的保证。若后续正式接入，应设计并验证可识别的 sticky/session 池、实际出口去重、60 秒调度、冷却、流量上限，并处理住宅节点掉线导致的出口变化；不能直接把 rotating gateway 当成几十个已知独立 IP。
