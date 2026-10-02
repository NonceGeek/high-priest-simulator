# 大祭司模拟器 Web 版

基于 Next.js 14、React 18、Socket.IO 与 Redis 的双人在线卡牌游戏。游戏规则见 [board-version/README.md](./board-version/README.md)。

## 本地运行

需要 Node.js 22 或更新版本，以及可通过 TCP 连接的 Redis。两个玩家与所有服务实例必须使用同一个 Redis。

```powershell
npm ci
$env:REDIS_URL = 'redis://127.0.0.1:6379'
npm run dev
```

打开 `http://127.0.0.1:8080`。可通过 `PORT`、`HOST` 指定监听地址。生产模式需先构建：

```powershell
npm run build
npm run typecheck:server
npm start
```

创建房间后分享房间号；第二位玩家加入时双方进入对局，每回合各提交一个行动后立即结算。每个浏览器标签页独立保存玩家恢复凭证，刷新或网络断开后自动恢复原座位。主动返回大厅会清除本标签页凭证；服务器座位保留至房间过期。

## Vercel 部署

本项目使用 Vercel Services 将 Next.js 页面和独立 Node.js Socket.IO 服务部署到同一个域名。`vercel.json` 把 `/api/socket-io/socket.io/(.*)` 转发到 `socket` 服务，其余路径进入 `frontend`。客户端与服务器仅使用 WebSocket 传输，不需要 HTTP polling 的粘性会话。

1. 在 Vercel 项目中启用 **Fluid Compute**。WebSocket 和 Services 当前均属于公测；需要项目拥有相应平台能力。
2. 为服务配置 `REDIS_URL`，例如 `rediss://用户名:密码@主机:端口`。必须是 Redis TCP/TLS 地址，Redis REST API 地址不能代替它。
3. 可配置 `ROOM_TTL_SECONDS`（默认 86400）控制房间自最后一次成功操作起的空闲期限。
4. 部署仓库根目录，使用提交的 Services 配置与 npm 锁文件。不要配置旧版 builds 或把所有页面请求路由到自定义 `server.ts`。
5. 在最终 HTTPS 域名验证两位玩家加入、完成一回合、刷新恢复，以及跨越函数运行期限后继续对局。

Vercel 函数最长运行时间会结束连接；Socket.IO 自动重连后用服务器凭证重新加入原房间并读取 Redis 状态。Socket 服务配置为 300 秒，房间与已提交行动不会随实例终止而消失。Redis 故障会明确拒绝操作，当前实例需要重新启动后恢复 Redis 连接。

本地检查 Vercel 路由（不需要登录或部署）：

```powershell
$env:REDIS_URL = 'redis://127.0.0.1:6379'
npm run dev:vercel
```

官方文档：[WebSockets](https://vercel.com/docs/functions/websockets)、[Services](https://vercel.com/docs/services)、[Services routing](https://vercel.com/docs/services/routing)。

## 状态与通信

Redis 保存完整房间、游戏状态、状态版本和玩家凭证哈希；Socket.IO Redis adapter 负责跨实例广播。每次改变房间都经过 Lua compare-and-set，竞争时重新读取和校验，避免两位玩家同时出牌丢失行动或重复结算。仅查询状态不改变状态版本。客户端丢弃更旧版本的快照。

恢复凭证由服务器随机生成，原始 token 只通过创建或加入的 ACK 返回，不进入游戏状态广播。凭证保存在 `sessionStorage`；原有连接在身份被新连接恢复后不能再操作，新连接不会被旧连接的断线处理清除。

事件采用统一结果 `{ ok: true, value }` 或 `{ ok: false, error }`：

- `createRoom(nickname, ack)`、`joinRoom(roomId, nickname, ack)` 返回 `RoomSession`。
- `selectAction({ round, action }, ack)`、`getGameState(ack)` 返回权威 `GameState`。
- `gameState` 广播状态，`serverError` 报告异步基础设施故障。

保留既有游戏状态可见性：网络消息包含双方完整手牌和未揭晓行动，当前 UI 仅选择性显示。若用于有对抗风险的公开游戏，应另行实现每位玩家的可见状态投影。

## 验证

```powershell
npm run typecheck
npm run typecheck:server
npm run build
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379'
npm test
```

集成测试使用真实 Redis、两个独立 HTTP/Socket.IO 实例和随机隔离的键前缀，覆盖跨实例联机、并发加入、唯一结算、重复与过期行动、错误身份、刷新式恢复、旧连接断开和实例停止后的继续结算。测试不会清空 Redis 数据库。

## 项目结构

```text
src/app/                   Next.js 大厅和游戏页面
src/lib/gameLogic.ts        卡牌规则与回合结算
src/lib/socketServer.ts     Socket.IO、认证和事件处理
src/lib/roomStore.ts        Redis 原子房间存储
src/lib/socketClient.ts     浏览器连接、凭证和请求
api/socket-io.mts           Vercel Node Socket 服务入口
server.ts                  本地同源 Next.js + Socket.IO 入口
tests/                     真实 Redis 集成测试
vercel.json                Services 与同域名路由配置
```

## License

MIT
