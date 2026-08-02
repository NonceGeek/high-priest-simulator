# 大祭司模拟器 Web 版

基于 WebSocket 的在线卡牌对战游戏。

## 游戏规则

详见 [board-version/README.md](./board-version/README.md)

## 技术栈

- **前端**: Next.js 14, React 18, TypeScript
- **实时通信**: Socket.IO
- **样式**: Tailwind CSS
- **部署**: Vercel

## 本地运行

1. 安装依赖:
```bash
npm install
```

2. 启动开发服务器:
```bash
npm run dev
```

3. 打开浏览器访问 `http://localhost:3000`

## 游戏流程

1. 玩家 A 点击"创建房间"，获得一个房间号
2. 将房间号分享给玩家 B
3. 玩家 B 点击"加入房间"，输入房间号
4. 双方同时选择行动（出牌或垂死一搏）
5. 行动同时结算，直到一方人口降至 0

## 游戏特性

- 16 牌基础版（每人 8 张牌）
- 实时 WebSocket 对战
- 完整的游戏规则实现
- 游戏日志记录
- 客户端状态保存（localStorage）

## 部署到 Vercel

1. 安装 Vercel CLI:
```bash
npm i -g vercel
```

2. 部署:
```bash
vercel
```

注意：由于 Vercel 的无服务器架构，WebSocket 连接可能需要特殊配置。建议使用 Vercel 的 Edge Functions 或考虑使用其他支持长连接的平台（如 Railway、Render）。

## 项目结构

```
├── src/
│   ├── app/              # Next.js 页面
│   │   ├── page.tsx      # 大厅页面
│   │   └── game/
│   │       └── page.tsx  # 游戏页面
│   ├── lib/              # 核心逻辑
│   │   ├── types.ts      # 类型定义
│   │   ├── gameLogic.ts  # 游戏逻辑
│   │   ├── socketServer.ts  # Socket 服务端
│   │   ├── socketClient.ts  # Socket 客户端
│   │   └── gameUI.tsx    # 游戏 UI 组件
├── server.ts             # 自定义服务器
└── package.json
```

## 卡牌说明

- **劫掠** (x2): 从敌方转移 1 人口
- **夜袭** (x2): 造成 3 点伤害
- **守夜** (x2): 抵消夜袭/劫掠，反击夜袭
- **向蚩尤献祭** (x1): 牺牲 2 人口造成 4 伤害，或牺牲 2 俘虏造成 6 伤害
- **向女娲祭祀** (x1): 从弃牌堆抽取 1 张牌

## License

MIT
