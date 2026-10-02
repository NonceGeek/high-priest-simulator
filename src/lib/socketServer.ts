/** 提供跨实例 Socket.IO 通信、服务器玩家认证与 Redis 原子游戏状态更新。 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Server as HTTPServer } from 'http';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Server as SocketServer, Socket } from 'socket.io';
import { createGameState, getAvailableActions, getPlayerLogName, resolveRound } from './gameLogic';
import { RoomError, RoomStore } from './roomStore';
import {
  Action,
  ActionRequest,
  ClientToServerEvents,
  GameState,
  Room,
  RoomSession,
  ServerToClientEvents,
  SocketResult,
} from './types';

interface SocketData {
  session?: RoomSession;
  recoveredState?: GameState;
  acquiringRoom?: boolean;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type GameServer = SocketServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface SocketServerOptions {
  redisUrl?: string;
  keyPrefix?: string;
  roomTtlSeconds?: number;
}

export interface SocketServerRuntime {
  io: GameServer;
  close: () => Promise<void>;
}

/**
 * 验证恢复凭证的网络结构，拒绝缺失、越界或未知角色。
 * @param value 不可信的 Socket.IO auth.session。
 * @returns 结构完整的玩家恢复凭证。
 * @throws RoomError 当结构无效。
 * @callers setupSocketServer 的 connection middleware。
 */
function parseSession(value: unknown): RoomSession {
  if (typeof value !== 'object' || value === null) throw new RoomError('恢复凭证格式无效');
  const session = value as Partial<RoomSession>;
  if (
    typeof session.roomId !== 'string' || !/^[a-f0-9]{12}$/.test(session.roomId) ||
    (session.playerId !== 'player1' && session.playerId !== 'player2') ||
    typeof session.token !== 'string' || !/^[a-f0-9]{64}$/.test(session.token)
  ) throw new RoomError('恢复凭证格式无效');
  return session as RoomSession;
}

/**
 * 哈希玩家凭证，仅将不可逆结果写入 Redis。
 * @param token 服务器生成的 32 字节十六进制凭证。
 * @returns SHA256 十六进制摘要。
 * @callers verifySession；handleCreateRoom；handleJoinRoom。
 */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 校验玩家凭证及可选的当前连接所有权。
 * @param room 最新权威房间。
 * @param session 已完成结构校验或服务器自己生成的会话。
 * @param socketId 若指定，要求当前座位仍归此连接。
 * @returns 无返回值。
 * @throws RoomError 当凭证不匹配或连接已被新的连接替代。
 * @callers handleRecovery；handleSelectAction；handleGetGameState；handleDisconnect。
 */
function verifySession(room: Room, session: RoomSession, socketId?: string): void {
  const expected = room.sessionTokenHashes[session.playerId];
  const actual = tokenHash(session.token);
  if (!expected || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new RoomError('恢复凭证无效');
  }
  if (socketId !== undefined && room.gameState.players[session.playerId].socketId !== socketId) {
    throw new RoomError('此玩家已在另一连接恢复，请重新连接');
  }
}

/**
 * 校验并标准化昵称，不接受异常结构或空昵称。
 * @param nickname 客户端提交的昵称。
 * @returns 最多 16 个字符的非空昵称。
 * @throws RoomError 当昵称不是字符串或为空。
 * @callers handleCreateRoom；handleJoinRoom。
 */
function parseNickname(nickname: unknown): string {
  if (typeof nickname !== 'string' || !nickname.trim()) throw new RoomError('请输入昵称');
  return nickname.trim().slice(0, 16);
}

/**
 * 校验回合和行动网络结构，人口必须为整数。
 * @param value 不可信行动请求。
 * @returns 结构完整且可由游戏规则验证的行动请求。
 * @throws RoomError 当结构不符合单一协议。
 * @callers handleSelectAction。
 */
function parseActionRequest(value: unknown): ActionRequest {
  if (typeof value !== 'object' || value === null) throw new RoomError('行动格式无效');
  const request = value as Partial<ActionRequest>;
  if (!Number.isInteger(request.round) || (request.round as number) < 1) throw new RoomError('回合编号无效');
  if (typeof request.action !== 'object' || request.action === null) throw new RoomError('行动格式无效');
  const action = request.action as Action;
  if (action.type === 'card' && typeof action.cardId === 'string' && action.cardId.length > 0) {
    return { round: request.round as number, action: { type: 'card', cardId: action.cardId } };
  }
  if (action.type === 'desperateStrike' && Number.isInteger(action.populationCost)) {
    return { round: request.round as number, action: { type: 'desperateStrike', populationCost: action.populationCost } };
  }
  throw new RoomError('行动格式无效');
}

/**
 * 读取已经由服务器绑定的身份，禁止匿名游戏操作。
 * @param socket 当前服务器连接。
 * @returns 服务器认可的玩家恢复凭证。
 * @throws RoomError 当连接尚未进入房间。
 * @callers handleSelectAction；handleGetGameState。
 */
function requireSession(socket: GameSocket): RoomSession {
  if (!socket.data.session) throw new RoomError('尚未进入房间');
  return socket.data.session;
}

/**
 * 向客户端返回规则错误；基础设施失败记录具体原因并返回明确失败。
 * @param error 异步操作拒绝原因。
 * @returns 不包含服务器连接参数的公开错误消息。
 * @callers registerOperation；connection middleware；handleDisconnect。
 */
function publicError(error: unknown): string {
  if (error instanceof RoomError) return error.message;
  console.error('Socket.IO 房间操作失败:', error);
  return '服务器存储或通信失败，请重新连接后获取状态';
}

/**
 * 为 HTTP server 安装可跨实例、可恢复的 Socket.IO 游戏服务。
 * @param httpServer 应用使用的 Node HTTP server。
 * @param options Redis 地址、应用键前缀及房间空闲生存时间。
 * @returns Socket.IO 实例和释放其所有连接的异步 close。
 * @throws 配置无效、Redis 初始连接失败或服务初始化失败。
 * @callers server.ts；api/socket-io.ts；socketServer.integration.test.ts。
 */
export async function setupSocketServer(
  httpServer: HTTPServer,
  options: SocketServerOptions = {},
): Promise<SocketServerRuntime> {
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const keyPrefix = options.keyPrefix ?? 'high-priest';
  const roomTtlSeconds = options.roomTtlSeconds ?? Number(process.env.ROOM_TTL_SECONDS ?? 86400);
  if (!redisUrl) throw new Error('必须配置 REDIS_URL');
  if (!/^[a-zA-Z0-9:_-]+$/.test(keyPrefix)) throw new Error('Redis keyPrefix 格式无效');
  if (!Number.isSafeInteger(roomTtlSeconds) || roomTtlSeconds < 1) throw new Error('ROOM_TTL_SECONDS 必须为正整数');

  const stateClient = createClient({
    url: redisUrl,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  const pubClient = stateClient.duplicate();
  const subClient = stateClient.duplicate();
  const clients = [stateClient, pubClient, subClient];
  for (const client of clients) client.on('error', (error) => console.error('Redis 连接失败:', error));
  await Promise.all(clients.map((client) => client.connect())).catch((error: unknown) => {
    for (const client of clients) if (client.isOpen) client.destroy();
    throw error;
  });

  const store = new RoomStore(stateClient, keyPrefix, roomTtlSeconds);
  let io: GameServer;
  let lastPublication: ReturnType<typeof pubClient.publish> | undefined;

  /**
   * 报告 Redis 运行故障并终止本实例连接，促使客户端明确重新认证。
   * @param error Redis 连接或消息命令失败的实际原因。
   * @returns 无返回值；故障不会被伪装为成功。
   * @callers Redis error listener；observeCommand；publish。
   */
  function reportInfrastructureFailure(error: unknown): void {
    console.error('Redis 存储或消息通道失败:', error);
    io.local.emit('serverError', '房间存储或跨实例通信不可用，请重新连接');
    io.local.disconnectSockets(true);
  }

  /**
   * 为 adapter 忽略的命令 Promise 附加故障报告，保留原始拒绝结果。
   * @param command 已绑定到 Redis 客户端的消息命令。
   * @returns 同一命令的受观察执行函数。
   * @callers adapter 的订阅和取消订阅命令配置。
   */
  function observeCommand<CommandArgs extends unknown[], Value>(
    command: (...args: CommandArgs) => Promise<Value>,
  ): (...args: CommandArgs) => Promise<Value> {
    /**
     * 执行消息命令并报告失败，不修改其兑现或拒绝语义。
     * @param args Redis 命令的原始参数。
     * @returns 原始命令 Promise。
     * @callers Socket.IO Redis adapter。
     */
    return function observedCommand(...args: CommandArgs): Promise<Value> {
      const operation = command(...args);
      void operation.catch(reportInfrastructureFailure);
      return operation;
    };
  }

  const originalPublish = pubClient.publish.bind(pubClient);

  /**
   * 保留本次广播的实际发布 Promise，使业务响应能等待 Redis 接受消息。
   * @param args Redis PUBLISH 的频道及消息。
   * @returns 未修改成功或失败结果的发布 Promise。
   * @callers Socket.IO Redis adapter.broadcast；broadcastState。
   */
  function publish(...args: Parameters<typeof pubClient.publish>): ReturnType<typeof pubClient.publish> {
    const operation = originalPublish(...args);
    lastPublication = operation;
    void operation.catch(reportInfrastructureFailure);
    return operation;
  }

  const adapterPublisher = {
    publish,
    pSubscribe: pubClient.pSubscribe.bind(pubClient),
    on: pubClient.on.bind(pubClient),
    off: pubClient.off.bind(pubClient),
  };
  const adapterSubscriber = {
    pSubscribe: observeCommand(subClient.pSubscribe.bind(subClient)),
    subscribe: observeCommand(subClient.subscribe.bind(subClient)),
    pUnsubscribe: observeCommand(subClient.pUnsubscribe.bind(subClient)),
    unsubscribe: observeCommand(subClient.unsubscribe.bind(subClient)),
    on: subClient.on.bind(subClient),
    off: subClient.off.bind(subClient),
  };
  io = new SocketServer(httpServer, {
    path: '/api/socket-io/socket.io',
    transports: ['websocket'],
    cors: { origin: false },
    adapter: createAdapter(adapterPublisher, adapterSubscriber, { key: `${keyPrefix}:socket.io` }),
  });
  const pending = new Set<Promise<void>>();
  let closePromise: Promise<void> | undefined;
  for (const client of clients) client.on('error', reportInfrastructureFailure);

  /**
   * 拒绝任何 Redis 连接不完整的操作，避免只在当前实例广播。
   * @returns 无返回值。
   * @throws RoomError 当状态或消息通道不可用。
   * @callers handleRecovery；handleCreateRoom；handleJoinRoom；handleSelectAction；handleGetGameState。
   */
  function requireInfrastructure(): void {
    if (!clients.every((client) => client.isReady)) throw new RoomError('房间存储或跨实例通信不可用，请重新连接');
  }

  /**
   * 发布已提交的权威状态，并等待 Redis 接受跨实例消息。
   * @param roomId 已认证的房间 ID。
   * @param state 已通过 CAS 保存的游戏状态。
   * @returns Redis PUBLISH 成功后的 Promise。
   * @throws Redis 不可用、发布失败或 adapter 未产生发布命令。
   * @callers handleCreateRoom；handleJoinRoom；handleSelectAction；handleDisconnect；connection listener。
   */
  async function broadcastState(roomId: string, state: GameState): Promise<void> {
    requireInfrastructure();
    lastPublication = undefined;
    io.to(roomId).emit('gameState', state);
    const publication = lastPublication;
    if (!publication) throw new Error('Socket.IO adapter 未发布状态消息');
    await publication;
  }

  /**
   * 跟踪已经包含明确错误处理的任务，使正常关闭等待其完成。
   * @param operation 不会吞掉错误的已处理异步任务。
   * @returns 无返回值。
   * @callers registerOperation；connection middleware；disconnect listener。
   */
  function track(operation: Promise<void>): void {
    pending.add(operation);
    void operation.then(() => pending.delete(operation));
  }

  /**
   * 执行一个事件操作并通过统一结果响应，缺少 ACK 时发 serverError。
   * @param socket 发起操作的连接。
   * @param operation 产生权威结果的异步函数。
   * @param ack 客户端可选 ACK 回调。
   * @returns 无返回值。
   * @callers connection 中的 createRoom；joinRoom；selectAction；getGameState listener。
   */
  function registerOperation<T>(
    socket: GameSocket,
    operation: () => Promise<T>,
    ack: ((result: SocketResult<T>) => void) | undefined,
  ): void {
    if (typeof ack !== 'function') {
      socket.emit('serverError', '请求缺少结果确认回调');
      return;
    }
    track(operation().then((value) => ack({ ok: true, value })).catch((error: unknown) => {
      ack({ ok: false, error: publicError(error) });
    }));
  }

  /**
   * 对同一连接的房间获取过程加排他标记，防止并发创建或加入改变身份。
   * @param socket 需要获取座位的连接。
   * @param operation 创建或加入房间的异步操作。
   * @returns 服务器签发的玩家会话。
   * @throws RoomError 当此连接已有身份或正在获取身份。
   * @callers createRoom listener；joinRoom listener。
   */
  async function acquireRoom(socket: GameSocket, operation: () => Promise<RoomSession>): Promise<RoomSession> {
    if (socket.data.session || socket.data.acquiringRoom) throw new RoomError('当前连接已进入或正在进入房间');
    socket.data.acquiringRoom = true;
    return operation().finally(() => { delete socket.data.acquiringRoom; });
  }

  /**
   * 在握手阶段认证并恢复角色，先原子接管座位再允许事件处理。
   * @param socket 新连接。
   * @param value 不可信 auth.session。
   * @returns 无返回值，恢复状态保存在 socket.data。
   * @callers connection middleware。
   */
  async function handleRecovery(socket: GameSocket, value: unknown): Promise<void> {
    requireInfrastructure();
    const session = parseSession(value);
    const room = await store.update(session.roomId, (current) => {
      verifySession(current, session);
      current.gameState.players[session.playerId].socketId = socket.id;
    });
    socket.data.session = session;
    socket.data.recoveredState = room.gameState;
    await socket.join(session.roomId);
  }

  io.use((socket, next) => {
    const value: unknown = socket.handshake.auth.session;
    if (value === undefined) {
      next();
      return;
    }
    track(handleRecovery(socket, value).then(() => next()).catch((error: unknown) => next(new Error(publicError(error)))));
  });

  /**
   * 创建唯一房间和 player1 凭证，再把当前连接加入房间。
   * @param socket 创建连接。
   * @param nickname 客户端昵称。
   * @returns 仅通过创建 ACK 返回的原始凭证。
   * @callers createRoom listener。
   */
  async function handleCreateRoom(socket: GameSocket, nickname: unknown): Promise<RoomSession> {
    requireInfrastructure();
    if (socket.data.session) throw new RoomError('当前连接已经进入房间');
    const playerName = parseNickname(nickname);
    const token = randomBytes(32).toString('hex');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const roomId = randomBytes(6).toString('hex');
      const gameState = createGameState(roomId);
      gameState.revision = 0;
      gameState.players.player1.socketId = socket.id;
      gameState.players.player1.nickname = playerName;
      gameState.gameLog.push(`${getPlayerLogName(gameState, 'player1')} 创建了房间 ${roomId}，等待对手加入...`);
      const room: Room = {
        id: roomId,
        gameState,
        createdAt: Date.now(),
        revision: 0,
        sessionTokenHashes: { player1: tokenHash(token) },
      };
      if (await store.create(room)) {
        const session: RoomSession = { roomId, playerId: 'player1', token };
        socket.data.session = session;
        await socket.join(roomId);
        await broadcastState(roomId, gameState);
        return session;
      }
    }
    throw new RoomError('无法分配唯一房间 ID，请重新创建');
  }

  /**
   * 原子占用 player2 座位，断线角色仍保留其凭证所有权。
   * @param socket 加入连接。
   * @param roomId 不可信的房间 ID。
   * @param nickname 不可信的玩家昵称。
   * @returns 仅通过加入 ACK 返回的 player2 凭证。
   * @callers joinRoom listener。
   */
  async function handleJoinRoom(socket: GameSocket, roomId: unknown, nickname: unknown): Promise<RoomSession> {
    requireInfrastructure();
    if (socket.data.session) throw new RoomError('当前连接已经进入房间');
    if (typeof roomId !== 'string' || !/^[a-f0-9]{12}$/.test(roomId)) throw new RoomError('房间 ID 格式无效');
    const playerName = parseNickname(nickname);
    const session: RoomSession = { roomId, playerId: 'player2', token: randomBytes(32).toString('hex') };
    const room = await store.update(roomId, (current) => {
      if (current.sessionTokenHashes.player2) throw new RoomError('房间已满');
      if (current.gameState.status !== 'waiting') throw new RoomError('游戏已经开始');
      current.sessionTokenHashes.player2 = tokenHash(session.token);
      current.gameState.players.player2.socketId = socket.id;
      current.gameState.players.player2.nickname = playerName;
      current.gameState.status = 'playing';
      current.gameState.gameLog.push(`${getPlayerLogName(current.gameState, 'player2')} 加入了游戏，对战开始！`);
    });
    socket.data.session = session;
    await socket.join(roomId);
    await broadcastState(roomId, room.gameState);
    return session;
  }

  /**
   * 校验身份及当前回合，在双方行动齐备的同一次事务中唯一结算。
   * @param socket 当前玩家连接。
   * @param value 不可信行动请求。
   * @returns 最终已持久化的权威游戏状态。
   * @callers selectAction listener。
   */
  async function handleSelectAction(socket: GameSocket, value: unknown): Promise<GameState> {
    requireInfrastructure();
    const session = requireSession(socket);
    const request = parseActionRequest(value);
    const room = await store.update(session.roomId, (current) => {
      verifySession(current, session, socket.id);
      const state = current.gameState;
      if (state.status !== 'playing') throw new RoomError('游戏尚未开始或已经结束');
      if (state.currentRound !== request.round) throw new RoomError('回合已变化，请获取最新状态');
      if (state.selectedActions[session.playerId]) throw new RoomError('本回合已经提交行动');
      const available = getAvailableActions(state.players[session.playerId], state);
      const valid = available.some((action) => action.type === request.action.type && (
        action.type === 'card' && request.action.type === 'card'
          ? action.cardId === request.action.cardId
          : action.type === 'desperateStrike' && request.action.type === 'desperateStrike' && action.populationCost === request.action.populationCost
      ));
      if (!valid) throw new RoomError('此行动当前不可用');
      state.selectedActions[session.playerId] = request.action;
      state.gameLog.push(`${getPlayerLogName(state, session.playerId)} 已选择行动`);
      if (state.selectedActions.player1 && state.selectedActions.player2) current.gameState = resolveRound(state);
    });
    await broadcastState(session.roomId, room.gameState);
    return room.gameState;
  }

  /**
   * 认证当前连接并读取完整权威状态，同时延长房间空闲期限。
   * @param socket 当前玩家连接。
   * @returns 已提交的游戏状态。
   * @callers getGameState listener。
   */
  async function handleGetGameState(socket: GameSocket): Promise<GameState> {
    requireInfrastructure();
    const session = requireSession(socket);
    const room = await store.update(session.roomId, (current) => verifySession(current, session, socket.id));
    return room.gameState;
  }

  /**
   * 只清除仍属于本连接的在线 ID，保留座位与恢复凭证。
   * @param socket 已断开的旧连接。
   * @returns 无返回值；过期连接不会清除新连接。
   * @callers disconnect listener。
   */
  async function handleDisconnect(socket: GameSocket): Promise<void> {
    const session = socket.data.session;
    if (!session) return;
    const room = await store.update(session.roomId, (current) => {
      verifySession(current, session);
      if (current.gameState.players[session.playerId].socketId !== socket.id) return;
      delete current.gameState.players[session.playerId].socketId;
      current.gameState.gameLog.push(`${getPlayerLogName(current.gameState, session.playerId)} 已断开连接`);
    });
    await broadcastState(session.roomId, room.gameState);
  }

  io.on('connection', (socket) => {
    if (socket.data.recoveredState) {
      track(broadcastState(requireSession(socket).roomId, socket.data.recoveredState).catch((error: unknown) => {
        socket.emit('serverError', publicError(error));
        socket.disconnect(true);
      }));
      delete socket.data.recoveredState;
    }
    socket.on('createRoom', (nickname, ack) => registerOperation(socket, () => acquireRoom(socket, () => handleCreateRoom(socket, nickname)), ack));
    socket.on('joinRoom', (roomId, nickname, ack) => registerOperation(socket, () => acquireRoom(socket, () => handleJoinRoom(socket, roomId, nickname)), ack));
    socket.on('selectAction', (request, ack) => registerOperation(socket, () => handleSelectAction(socket, request), ack));
    socket.on('getGameState', (ack) => registerOperation(socket, () => handleGetGameState(socket), ack));
    socket.on('disconnect', () => {
      track(handleDisconnect(socket).catch((error: unknown) => {
        console.error('记录玩家断线失败:', publicError(error));
      }));
    });
  });

  /**
   * 幂等停止服务，等待事件事务完成后释放三个 Redis 连接。
   * @returns 所有本实例资源已关闭的 Promise。
   * @callers server.ts 正常退出；socketServer.integration.test.ts 清理。
   */
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = new Promise<void>((resolve, reject) => {
      io.close((error?: Error) => error ? reject(error) : resolve());
    }).finally(async () => {
      await Promise.all(pending);
      await Promise.all(clients.filter((client) => client.isOpen).map((client) => client.close()));
    });
    return closePromise;
  }

  return { io, close };
}
