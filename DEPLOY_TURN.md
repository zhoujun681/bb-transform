# 部署说明（含内置 TURN）

这个项目现在在**同一个 Docker 容器**里同时运行：
1. **Node 信令 + 静态网页服务**（`:8080`，HTTP/WS）
2. **coturn TURN 中继**（`:3478` TCP+UDP + `49152–49171` UDP relay）

TURN 的作用：手机在同一 WiFi 下若因**路由器隔离（AP isolation）**或 **mDNS 被拦**导致 host 候选为空（界面显示「直连失败 / 重新连接中」，候选行 `host=0 srflx=0 relay=0`），TURN 让数据经服务器中转，**必能连上**。

---

## 1. 构建并运行

```bash
cd <项目根目录>
docker compose up -d --build
```

查看两个进程是否都起来了：

```bash
docker logs -f bb-transform
# 应能看到：
#   bb-transform server listening on :8080
#   以及 coturn 的启动日志（0: IPv4. tcp/udp ... listening-port=3478）
```

容器对外暴露：
- `8080` — 网页 + 信令
- `3478` (TCP+UDP) — TURN 信令
- `49152–49171` (UDP) — TURN relay（每路连接占一个）

## 2. 手机访问

两台手机（同 WiFi）浏览器打开：

```
http://<服务器内网IP>:8080/
```

页面会**自动连接信令服务器**。TURN 配置框默认已填好：

```
turn:<服务器内网IP>:3478
用户名: bbuser
密码:   bbpass123
```

（这些是 `server/turnserver.conf` 里的静态账号，已与网页默认值一致。）

### 如果默认没生效 / 你改了账号
在网页「TURN 中继」一栏填好地址、用户名、密码，点 **保存 TURN**。已卡住的连接会**立即用 TURN 重试**（无需刷新）。

成员列表里对方应从「直连中…」变为「✓ 已直连」，即可互发消息/文件。

---

## 3. 改账号 / 密码（可选）

默认账号 `bbuser / bbpass123` 是明文静态账号，**仅适合可信内网**。如要改：

1. 编辑 `server/turnserver.conf`，改 `realm` 和 `user=账号:密码`。
2. 同步改 `app.js` 里的 `TURN_DEFAULT_USER` / `TURN_DEFAULT_PASS`（或直接在网页 TURN 框里填，点保存即可，无需改代码）。
3. `docker compose up -d --build` 重建。

## 4. 扩容 relay 端口（可选）

默认 20 个 UDP 端口，够几台手机。要更多：
1. 改 `server/turnserver.conf` 的 `min-port` / `max-port`。
2. 改 `docker-compose.yml` 的端口映射范围（两端要一致）。
3. 重建。

---

## 5. 故障排查

成员列表里每个设备下方会显示一行诊断：
```
候选: host=2 srflx=2 relay=0 · ICE: connected
```
- `host` 局域网候选、`srflx` 公网(STUN)候选、`relay` TURN 中继候选。
- `relay=0` 且连不上 → **TURN 没生效**（见下表最常见原因）。

| 现象 | 原因 / 检查 |
|---|---|
| 网页打不开 | `docker logs bb-transform` 看 8080；防火墙放行 8080 |
| 能打开网页、对方一直「直连中」 | 看候选行：`relay=0` 说明 TURN 没生效；点「保存 TURN」重试 |
| `relay=0`（TURN 候选一个都没有） | 三选一：① **浏览器不支持 TURN**（见下）；② coturn 没跑（`docker logs` 看有无 coturn 启动行）；③ 3478/relay UDP 端口没通 |
| `relay≥1` 但仍失败 | TURN relay UDP 端口（49152–49171）没映射出去 → 查 `docker-compose.yml` UDP 映射、宿主机防火墙 |
| 两台手机同 WiFi 但 host=0 | 路由器 AP 隔离 / mDNS 受限，TURN 可解决 |

### ⚠️ 最常见、最隐蔽的坑：自带/国产浏览器

手机**自带的浏览器**（小米浏览器、华为浏览器、UC、夸克、QQ 浏览器等，基于系统 WebView，**不是 Chrome**）对 WebRTC / TURN 的支持**参差不齐**，典型表现就是：
- `host=0 srflx=0 relay=0 · ICE: new` —— 一个候选都收不到；
- 即便配好 TURN，`relay` 仍是 0（自带浏览器对 TURN 的 username/credential 实现有缺陷，不收集 relay 候选）；
- "成功过一次、再就连不上"的不稳定行为。

**这不是代码或网络问题，是浏览器实现限制。** 解决办法：**在手机上装 Chrome 或 Edge 浏览器**再打开页面，候选行通常立刻出现 `relay≥1` 并连上。如果设备是国产手机，优先用 Chrome/Edge 验证，确认是浏览器问题后再决定是否长期依赖自带浏览器。

> 注：TURN 会把文件数据经服务器**临时中转**（传输期间占带宽，**不落盘、不存内存**），符合"服务器不存储"的要求。同网直连成功时不走 TURN，零开销。

