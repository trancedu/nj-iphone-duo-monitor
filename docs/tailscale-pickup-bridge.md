# Mac Mini → Safari Mac：跨 Wi-Fi / 手机热点的库存通信

当前设备地址（2026-10-28 实测，两台 Tailscale 均在线）：

- Safari Mac：`100.103.212.49`
- Mac Mini：`100.83.108.82`

Tailscale 只承载两台设备之间的库存信号。不要为此启用 Exit Node 或系统代理；Safari 访问 Apple 仍走当前 Wi-Fi / 手机热点。保持两台设备登录同一受控 tailnet，并允许 Mini 到 Safari Mac 的 TCP 8765。不要开启 Funnel、端口转发或公网监听。

## 本机接收器

私有配置 `~/Library/Application Support/iPhoneDuo/receiver-safari/receiver.router.local.json` 中：

```json
{
  "host": "100.103.212.49",
  "port": 8765,
  "allowed_sources": ["127.0.0.1", "100.83.108.82"],
  "drop_busy_events": false,
  "recent_request_ttl_seconds": 10
}
```

这是字段片段，不能用它覆盖整份配置。六窗口、自提邮编、联系人和共享密钥沿用原配置。`drop_busy_events:false` 明确保留当前正在使用的 10 秒最新候选补跑行为。

传输范围验证支持 RFC1918、loopback 和 Tailscale 使用的 `100.64.0.0/10`；实际 HTTP 请求仍需要精确来源白名单和原 Bearer 密钥，接受这个地址范围不等于允许任意来源。IPv6 发送端尚未启用。

配置地址暂时不可用时，本地 loopback 监听继续提供健康检查和 Safari 会话维护，每 5 秒重试原地址。health 的 `listener_status.lan_available` 表示配置的私有网络监听已开启（此字段也用于 Tailscale）；它不代表 Mini 已实际投递成功。`loopback_available` 只表示本机可达。

## 用户更新 Mac Mini

在 Mini 仓库目录更新代码：

```sh
git fetch origin
git pull --rebase origin main
```

若工作目录有未提交修改，先检查并保留它们，不要强制覆盖。

修改 Mini 的实际 bridge 私有配置（通常为 `pickup_bridge.local.json`，以服务实际加载的文件为准），保留已有密钥环境变量和其他参数，只将 endpoint 改为：

```json
"endpoint": "http://100.103.212.49:8765/prepare"
```

确认 bridge 已启用，并重启 Mini 上原有监控服务，使它重新加载代码和配置。不要另开第二个监控副本。

在 Mini 仓库目录，用已有的密钥环境文件执行只读连通检查：

```sh
python3 bridge_client.py health --env-file .env --endpoint http://100.103.212.49:8765
```

`.env` 应替换成该服务原本的环境文件。预期看到 Safari、六个 profiles 和 ready 状态；401 表示密钥不一致，403 表示来源白名单不匹配，连接失败先检查 Tailscale、tailnet 访问规则及监听状态。测试不会触发抢购。确认 health 后再通过原有模拟事件入口验证一次配置路由。

此改动没有在 Mini 上替用户部署或重启监控。
