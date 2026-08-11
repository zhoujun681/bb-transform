# 局域网快传（文件 + 消息）

一个**纯网页**的局域网文件与消息传输工具。两台或多台设备打开本网页即可**点对点直传**文件、发送消息。数据全程走设备间 WebRTC 直连，**服务器只是信令中继，永不接触文件/消息内容**。

支持三种部署：① 纯扫码/粘贴（零服务器）；② Docker 信令服务器（免扫码自动组网）；③ 内置 TURN 中继（解决手机连不上）。

---

## 快速开始

### 方式一：Docker（推荐，自带 TURN，最省心）⭐

```bash
cd bb-transform
docker compose up --build        # 构建并运行
```

容器同时跑四个入口：
- **网页 + 信令**（`:8081`，HTTP/WS）
- **安全网页 + 信令**（`:8443`，HTTPS/WSS）
- **TURN 中继**（`:3478` TCP+UDP，用于手机直连失败时兜底）

同局域网任何设备的浏览器（**Chrome / Edge**，别用自带浏览器）打开：
```
https://运行服务器的电脑IP:8443
```
页面**自动连服务器、自动发现全网、自动建立直连**，全程免扫码。手机连不上时 TURN 自动兜底（详见下文「连不上的排查」）。

运行 `pack-deploy.ps1` 会把 HTTPS 启动脚本、`_cert.pem` 和 `_key.pem` 一起放入部署目录。上传到已安装 Docker、Docker Compose 和 OpenSSL 的 Linux 后执行 `sh deploy-linux.sh`，脚本会在证书 IP 不匹配时自动按 Linux 当前 IP 重新生成，并默认同时开启 HTTP `8081` 与 HTTPS `8443`。证书为自签证书；请在访问设备上信任部署后目录中的 `_cert.pem`，并妥善保护 `_key.pem`。

### 方式二：免 Docker 直接跑信令服务器

```bash
cd bb-transform/server
npm install
node server.js          # 默认 8080；PORT=9000 node server.js 改端口
```
同局域网设备访问 `http://电脑IP:8080`。此方式**不含 TURN**，仅适合能直连的同网环境。

### 方式三：免 Docker 单文件 exe（Windows，零依赖）

把信令服务器打包成自包含 exe（内嵌 Node + ws，双击即跑）：

```bash
cd bb-transform
node desktop/build.js       # 产物在 desktop/dist/
```
把**整个 `desktop/dist/`** 拷到目标电脑 → 双击 `start-server.bat`。窗口打印本机局域网 IP，手机访问 `http://电脑IP:8080`。

> 改了 `index.html`/`app.js` 直接覆盖同级文件即可，不用重打包；只有改了 `server.js` 才需重跑 `build.js`。
>
> 在运行 exe 的 Windows 电脑上用 `localhost` 或本机 IP 打开页面时，「复制」会同时写入文件和内容两类剪贴板格式：可粘贴到桌面/资源管理器，图片或文本也可直接粘贴到富文本/文本应用。该能力依赖 dist 中的 `windows-clipboard.ps1`，请勿单独移动 exe。

### 方式四：纯网页零服务器（扫码/粘贴配对）

把整个 `bb-transform` 文件夹拷到每台设备，双击 `index.html`：
- **A 设备**：点「创建房间」→ 显示二维码 + 邀请码。
- **B 设备**：点「加入房间」→ 扫码或粘贴邀请码 → 生成回执码。
- **A 设备**：扫/粘 B 的回执码 → 连接建立。
- 之后新设备扫**任一成员**一次码，自动与全网建立直连。

> 无摄像头时全程用「粘贴码」，完全等价。

---

## 功能

- **消息**：输入回车发送，全局共享，自动去重。
- **文件**：选择文件发送，或在聊天输入框中直接粘贴复制的文件/截图；多个粘贴文件自动排队。接收后可一键复制，并保留下载兜底。Windows 本机服务模式会同时提供桌面/资源管理器需要的文件格式和富文本需要的图片/文本格式；纯网页或远程访问时按浏览器能力复制内容。
- **传输取消**：发送方/接收方都能中途点「取消」，双方立即停止并清理，互相通知。
- **实时速度**：传输时状态栏显示瞬时速度（MB/s）+ 连接类型（直连/TURN 中转）+ 背压状态。
- **会话历史**：可保存当前会话（含/不含文件）到 IndexedDB，随时回看。
- **诊断**：成员列表显示每台设备的直连状态（已直连/直连中/重试中/失败）+ ICE 候选统计；设备退出网页后由信令服务立即通知其他成员移除。

---

## 连不上的排查（重要）

手机连不上是本方案最常见的问题，**90% 是浏览器或网络**。先看成员列表里对方的候选行：

```
候选: host=2 srflx=2 relay=0 · ICE: connected
```

| 现象 | 原因 | 解决 |
|---|---|---|
| `host=0 srflx=0 relay=0` 且一直连不上 | **用了自带/国产浏览器**（小米/华为/UC 等基于 WebView，WebRTC 支持差） | **装 Chrome 或 Edge** |
| 候选正常但 ICE 卡在 `checking`/`failed` | 路由器 AP 隔离 / mDNS 受限，纯 P2P 打不通 | 用 **Docker 方式**（自带 TURN 兜底），或配置 TURN |
| Linux 端显示 `host=1 srflx=1 relay=0 · ICE: disconnected` | 只收集到了直连/STUN 候选；Linux 防火墙、网络隔离或 standalone 部署未运行 coturn | 放行 UDP、关闭 AP 隔离，或配置可用 TURN；Docker 部署需确认 `3478` 和 `49152–49171/UDP` 已发布 |
| 同 WiFi 两台设备互不可达 | AP 隔离 / 访客网络 | TURN 中转，或关闭路由器 AP 隔离 |
| 跨网络（一台 WiFi 一台流量） | 必须有 TURN | 配置 TURN |

### 配置 TURN（跨网/受限网络兜底）

Docker 方式已内置 coturn，默认账号 `bbuser:bbpass123`，页面「TURN 中继」框默认填好 `turn:服务器IP:3478`，点「保存 TURN」即启用。改账号见 `server/turnserver.conf`。详细部署见 [DEPLOY_TURN.md](DEPLOY_TURN.md)。

> TURN 只在**传输期间临时中转**数据，**不落盘、不持久占内存**。同网直连成功时根本不走 TURN，零开销。

---

## 性能调优（可选）

传输参数可通过浏览器控制台 `window.BT_TUNING` 覆盖（**刷新页面或传输前设置**）：

```js
window.BT_TUNING = { highWater: 8*1024*1024, lowWater: 2*1024*1024 };
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `chunk` | 手机约 128 KiB；电脑最高约 256 KiB | 负载大小；还会自动受对端声明和 SCTP 协商上限约束 |
| `highWater` | 手机 4 MiB；电脑 12 MiB | 发送背压高水位，可覆盖范围 1–16 MiB |
| `lowWater` | 手机 1 MiB；电脑 3 MiB | 背压续发阈值，始终限制在高水位的一半以内 |

> **为什么没有多连接提速？** 每对设备仍使用一条 RTCPeerConnection/SCTP 路径，通过设备能力协商、较大的桌面端发送队列和 DataChannel 背压保持链路饱和。向多台设备广播时每台设备有独立发送泵，慢设备不会让快设备停发。

传输时状态栏若显示「· 排空队列」，说明瓶颈在背压（`bufferedAmount` 顶到高水位），可尝试调大 `highWater`。

---

## 能力与限制

| 项 | 说明 |
|---|---|
| 拓扑 | 全连接网状（full mesh），2~6 台设备最佳 |
| 传输 | WebRTC DataChannel，设备间 P2P 直连（trickle ICE + host/srflx/relay 候选） |
| 信令 | 二维码/粘贴（零服务器）或 WebSocket 中继（roster-push 即时发现） |
| 离线 | 全部资源本地打包，纯网页模式断网可用 |
| 浏览器 | **Chrome / Edge 推荐**；自带/国产浏览器 WebRTC 不可靠 |
| 安全 | 服务器 `from` 字段覆盖（防冒充）、64KB 上限、~50msg/s 限流；TURN 静态账号；Windows 原生剪贴板接口仅接受本机请求 |

---

## 目录结构

```
index.html / styles.css / app.js     入口页面 / 样式 / UI 控制器
core/
  identity.js        peerId 持久化 + 昵称
  signaling.js       SDP 压缩 / 二维码生成 / 扫码
  server-signaling.js  WebSocket 信令中继客户端（含重连）
  transport.js       DataChannel：信封路由 + 文件分块/背压/重组/取消
  mesh.js            RTCPeerConnection + 网状扩展 + trickle ICE + roster-push
  storage.js         IndexedDB 会话历史
vendor/              二维码生成/扫描（本地）
server/
  server.js          哑信令中继（ws）+ 静态托管 + roster-push
  turnserver.conf    coturn 配置（静态账号 + relay 端口）
  supervisord.conf   同容器跑 node + coturn
  package.json
Dockerfile / docker-compose.yml   Docker 打包（含 coturn）
desktop/             免 Docker 单文件 exe 打包
serve_https.py / serve.bat   HTTPS 托管（启用网页内扫码摄像头）
test/                单元测试（传输重组 / 聊天 / 信令路由 / 服务器发现 / 取消）
DEPLOY_TURN.md       TURN 部署详细文档
```

## 测试

```bash
node test/logic.test.js        # 文件分块重组 + 聊天投递 + 取消
node test/routing-repro.test.js # 信令路由（server 模式 offer/answer 经中继）
node test/server.test.js       # 服务器模式：两客户端经 roster-push 互发现
```

## 托管页面以启用扫码（可选）

手机网页内扫码需「安全上下文」（`https://` 或 `localhost`），`http://局域网IP` 下摄像头被禁用：

```bash
python serve_https.py          # 默认 8443，自签证书
# 或 Windows 双击 serve.bat
```
手机访问 `https://电脑IP:8443`，首次提示证书不受信 → 「高级 / 仍然继续」。无摄像头时全程用「粘贴码」，完全等价。
