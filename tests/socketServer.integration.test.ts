/**
 * 文件用途：使用真实 Redis 与两个独立 HTTP/Socket.IO 实例验证共享房间、原子行动和会话恢复。
 * 运行方式：设置 TEST_REDIS_URL，再通过 tsx 与 Node 内置测试运行器执行本文件。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import test, { TestContext } from 'node:test';
import { io, Socket } from 'socket.io-client';
import { setupSocketServer, SocketServerRuntime } from '../src/lib/socketServer';
import { Action, GameState, RoomSession, SocketResult } from '../src/lib/types';

const SOCKET_PATH = '/api/socket-io/socket.io';
const EVENT_TIMEOUT_MS = 5000;

interface RunningServer {
  httpServer: HttpServer;
  runtime: SocketServerRuntime;
  url: string;
  closed: boolean;
}

interface Fixture {
  servers: RunningServer[];
  clients: Set<Socket>;
}

interface PlayingRoom {
  player1: Socket;
  player2: Socket;
  session1: RoomSession;
  session2: RoomSession;
  state: GameState;
}

/**
 * 启动一个使用指定 Redis 和测试命名空间的独立 HTTP 服务。
 * @param redisUrl 真实 Redis 连接地址。
 * @param keyPrefix 当前测试独享的 Redis 键与广播频道前缀。
 * @returns 已监听本机随机端口的服务及其关闭状态。
 * @throws Redis 初始化或 HTTP 监听失败时透传错误。
 * @Callers createFixture。
 */
async function startServer(redisUrl: string, keyPrefix: string): Promise<RunningServer> {
  const httpServer = createServer();
  const runtime = await setupSocketServer(httpServer, {
    redisUrl,
    keyPrefix,
    roomTtlSeconds: 60,
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  return { httpServer, runtime, url: `http://127.0.0.1:${address.port}`, closed: false };
}

/**
 * 关闭指定服务，并标记为已关闭以免测试清理时重复释放。
 * @param server 要关闭的独立服务。
 * @returns 服务及其 Redis 连接关闭完成时兑现的 Promise。
 * @Callers createFixture 的清理钩子、实例关闭后的恢复测试。
 */
async function closeServer(server: RunningServer): Promise<void> {
  if (server.closed) return;
  server.closed = true;
  await server.runtime.close();
}

/**
 * 为单个测试准备两个共享真实 Redis 的独立服务及资源清理。
 * @param context 当前测试的生命周期上下文。
 * @returns 含两个服务和全部客户端连接的夹具。
 * @throws TEST_REDIS_URL 缺失或服务启动失败时拒绝执行测试。
 * @Callers 本文件全部正常 Redis 集成测试。
 */
async function createFixture(context: TestContext): Promise<Fixture> {
  const redisUrl = process.env.TEST_REDIS_URL;
  assert.ok(redisUrl, '必须显式设置 TEST_REDIS_URL，不能以模拟存储替代 Redis 集成测试');
  const fixture: Fixture = { servers: [], clients: new Set() };
  context.after(async () => {
    for (const client of fixture.clients) client.disconnect();
    await Promise.all(fixture.servers.map(closeServer));
  });
  const keyPrefix = `high-priest-test-${randomUUID()}`;
  fixture.servers.push(await startServer(redisUrl, keyPrefix));
  fixture.servers.push(await startServer(redisUrl, keyPrefix));
  return fixture;
}

/**
 * 创建未连接的 WebSocket 客户端，并把它纳入当前测试清理范围。
 * @param fixture 当前测试的服务与资源集合。
 * @param serverIndex 目标服务索引，0 或 1。
 * @param session 可选的服务端签发恢复会话。
 * @returns 尚未发起连接的 Socket.IO 客户端。
 * @Callers createPlayingRoom、认证测试、会话恢复测试、并发加入测试。
 */
function createClient(fixture: Fixture, serverIndex: number, session?: RoomSession): Socket {
  const socket = io(fixture.servers[serverIndex].url, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    auth: session ? { session } : {},
  });
  fixture.clients.add(socket);
  return socket;
}

/**
 * 等待客户端成功连接，或在认证失败、连接超时时明确拒绝。
 * @param socket 尚未连接的 Socket.IO 客户端。
 * @returns 连接完成时兑现的 Promise。
 * @throws 服务端认证错误或连接超时错误。
 * @Callers createPlayingRoom、本文件各连接与恢复测试。
 */
function connectClient(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      socket.disconnect();
      reject(new Error('Socket.IO 连接超时'));
    }, EVENT_TIMEOUT_MS);

    /**
     * 清理连接监听器并兑现连接 Promise。
     * @returns 无返回值。
     * @Callers Socket.IO connect 事件。
     */
    function onConnect(): void {
      clearTimeout(timer);
      socket.off('connect_error', onError);
      resolve();
    }

    /**
     * 清理连接监听器并把真实连接错误交给测试。
     * @param error Socket.IO 返回的连接或认证错误。
     * @returns 无返回值。
     * @Callers Socket.IO connect_error 事件。
     */
    function onError(error: Error): void {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.disconnect();
      reject(error);
    }

    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  });
}

/**
 * 发送带超时确认的业务请求，并保留服务端明确的成功或失败结果。
 * @param socket 已连接的 Socket.IO 客户端。
 * @param event createRoom、joinRoom、selectAction 或 getGameState。
 * @param args 该事件的协议参数，不含确认回调。
 * @returns 服务端原始确认结果。
 * @throws 在确认超时或连接失败时拒绝。
 * @Callers createPlayingRoom、getState、本文件各业务请求测试。
 */
function request<T>(socket: Socket, event: string, ...args: unknown[]): Promise<SocketResult<T>> {
  return socket.timeout(EVENT_TIMEOUT_MS).emitWithAck(event, ...args) as Promise<SocketResult<T>>;
}

/**
 * 要求业务请求成功，并提取其权威返回值。
 * @param result 业务请求的确认结果。
 * @returns 成功结果携带的值。
 * @throws 服务端返回失败或缺少成功值时产生测试断言错误。
 * @Callers createPlayingRoom、getState、本文件各成功请求测试。
 */
function requireSuccess<T>(result: SocketResult<T>): T {
  if (!result.ok) assert.fail(result.error);
  return result.value;
}

/**
 * 等待满足指定条件的游戏广播，超时则明确失败。
 * @param socket 接收广播的客户端。
 * @param predicate 判断广播是否为预期权威状态的条件。
 * @returns 首个满足条件的游戏状态。
 * @throws 未在期限内收到预期广播时拒绝。
 * @Callers 跨实例广播测试、会话恢复测试、并发出牌测试。
 */
function waitForState(socket: Socket, predicate: (state: GameState) => boolean): Promise<GameState> {
  return new Promise<GameState>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('gameState', onState);
      reject(new Error('未收到预期的权威游戏广播'));
    }, EVENT_TIMEOUT_MS);

    /**
     * 筛选游戏广播并在匹配时释放监听资源。
     * @param state 服务端广播的游戏状态。
     * @returns 无返回值。
     * @Callers Socket.IO gameState 事件。
     */
    function onState(state: GameState): void {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off('gameState', onState);
      resolve(state);
    }

    socket.on('gameState', onState);
  });
}

/**
 * 从客户端所在会话读取服务端权威游戏状态。
 * @param socket 已绑定玩家身份的客户端。
 * @returns 服务端持久化的当前游戏状态。
 * @Callers 本文件所有状态一致性、持久化和行动验证测试。
 */
async function getState(socket: Socket): Promise<GameState> {
  return requireSuccess(await request<GameState>(socket, 'getGameState'));
}

/**
 * 在两个不同服务实例分别创建和加入同一游戏房间。
 * @param fixture 当前测试的服务夹具。
 * @returns 两位玩家客户端、恢复会话及 playing 状态。
 * @Callers 并发出牌、重复行动、认证、恢复、实例关闭测试。
 */
async function createPlayingRoom(fixture: Fixture): Promise<PlayingRoom> {
  const player1 = createClient(fixture, 0);
  const player2 = createClient(fixture, 1);
  await Promise.all([connectClient(player1), connectClient(player2)]);
  const session1 = requireSuccess(await request<RoomSession>(player1, 'createRoom', '甲'));
  const playingBroadcast = waitForState(player1, (state) => state.status === 'playing');
  const session2 = requireSuccess(await request<RoomSession>(player2, 'joinRoom', session1.roomId, '乙'));
  const state = await playingBroadcast;
  assert.equal(session1.playerId, 'player1');
  assert.equal(session2.playerId, 'player2');
  assert.equal(session1.roomId, session2.roomId);
  assert.equal(state.id, session1.roomId);
  assert.equal(player1.io.engine.transport.name, 'websocket');
  assert.equal(player2.io.engine.transport.name, 'websocket');
  return { player1, player2, session1, session2, state };
}

/**
 * 为指定玩家选择一张无额外支付条件的起始劫掠牌。
 * @param state 当前游戏状态。
 * @param playerId 出牌玩家的身份。
 * @returns 可用于真实 selectAction 请求的行动。
 * @Callers 本文件并发、重复、恢复与持久化测试。
 */
function raidAction(state: GameState, playerId: RoomSession['playerId']): Action {
  const card = state.players[playerId].hand.find((candidate) => candidate.type === 'raid');
  assert.ok(card, '当前测试回合必须仍有劫掠牌');
  return { type: 'card', cardId: card.id };
}

test('跨实例创建和加入能收到一致状态，恢复凭证不进入游戏状态', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const room = await createPlayingRoom(fixture);
  assert.deepEqual(await getState(room.player1), await getState(room.player2));
  const serialized = JSON.stringify(room.state);
  for (const session of [room.session1, room.session2]) {
    assert.ok(session.token.length >= 32, '恢复凭证必须具有足够长度');
    assert.equal(serialized.includes(session.token), false);
    assert.equal(serialized.includes(createHash('sha256').update(session.token).digest('hex')), false);
  }
});

test('并发加入只能占据一个座位，断开连接也不能让第三人接管', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const owner = createClient(fixture, 0);
  const contender1 = createClient(fixture, 0);
  const contender2 = createClient(fixture, 1);
  await Promise.all([connectClient(owner), connectClient(contender1), connectClient(contender2)]);
  const session = requireSuccess(await request<RoomSession>(owner, 'createRoom', '房主'));
  const results = await Promise.all([
    request<RoomSession>(contender1, 'joinRoom', session.roomId, '竞争者一'),
    request<RoomSession>(contender2, 'joinRoom', session.roomId, '竞争者二'),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  const winnerIndex = results.findIndex((result) => result.ok);
  const clients = [contender1, contender2];
  const state = await getState(owner);
  assert.equal(state.status, 'playing');
  assert.equal(state.players.player2.nickname, winnerIndex === 0 ? '竞争者一' : '竞争者二');
  clients[winnerIndex].disconnect();
  const retry = await request<RoomSession>(clients[1 - winnerIndex], 'joinRoom', session.roomId, '第三人');
  assert.equal(retry.ok, false);
  assert.equal((await getState(owner)).players.player2.nickname, state.players.player2.nickname);
});

test('两个实例同时出牌只结算一次，双方各消耗一张牌并收到结算广播', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const room = await createPlayingRoom(fixture);
  const broadcasts = [
    waitForState(room.player1, (state) => state.currentRound === 2),
    waitForState(room.player2, (state) => state.currentRound === 2),
  ];
  const results = await Promise.all([
    request<GameState>(room.player1, 'selectAction', { round: 1, action: raidAction(room.state, 'player1') }),
    request<GameState>(room.player2, 'selectAction', { round: 1, action: raidAction(room.state, 'player2') }),
  ]);
  results.forEach(requireSuccess);
  const [broadcast1, broadcast2] = await Promise.all(broadcasts);
  assert.deepEqual(broadcast1, broadcast2);
  const state = await getState(room.player1);
  assert.equal(state.currentRound, 2);
  assert.equal(state.players.player1.hand.length, room.state.players.player1.hand.length - 1);
  assert.equal(state.players.player2.hand.length, room.state.players.player2.hand.length - 1);
  assert.equal(state.players.player1.discardPile.length, 1);
  assert.equal(state.players.player2.discardPile.length, 1);
  assert.equal(state.lastReveal?.round, 1);
  assert.equal(state.lastReveal?.resolved, true);
  assert.deepEqual(state.selectedActions, { player1: null, player2: null });
  assert.equal(state.gameLog.filter((entry) => entry === '\n--- Round 1 ---').length, 1);
  assert.deepEqual(state, await getState(room.player2));
});

test('拒绝同轮重复行动和旧回合请求，不覆盖行动也不重复消耗手牌', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const room = await createPlayingRoom(fixture);
  const action1 = raidAction(room.state, 'player1');
  requireSuccess(await request<GameState>(room.player1, 'selectAction', { round: 1, action: action1 }));
  const duplicate = await request<GameState>(room.player1, 'selectAction', { round: 1, action: action1 });
  assert.equal(duplicate.ok, false);
  const pending = await getState(room.player2);
  assert.deepEqual(pending.selectedActions.player1, action1);
  assert.equal(pending.currentRound, 1);
  requireSuccess(await request<GameState>(room.player2, 'selectAction', {
    round: 1,
    action: raidAction(room.state, 'player2'),
  }));
  const stale = await request<GameState>(room.player1, 'selectAction', {
    round: 1,
    action: raidAction(await getState(room.player1), 'player1'),
  });
  assert.equal(stale.ok, false);
  const state = await getState(room.player2);
  assert.equal(state.currentRound, 2);
  assert.equal(state.players.player1.discardPile.length, 1);
  assert.equal(state.players.player2.discardPile.length, 1);
  assert.deepEqual(state.selectedActions, { player1: null, player2: null });
});

test('未认证会话和畸形行动明确失败，不能改变游戏状态', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const room = await createPlayingRoom(fixture);
  const stranger = createClient(fixture, 1);
  await connectClient(stranger);
  assert.equal((await request<GameState>(stranger, 'getGameState')).ok, false);
  assert.equal((await request<GameState>(stranger, 'selectAction', {
    round: 1,
    action: raidAction(room.state, 'player1'),
  })).ok, false);
  const malformedRequests: unknown[] = [
    null,
    { round: 1, action: null },
    { round: 1, action: { type: 'unknown' } },
    { round: 1, action: { type: 'card', cardId: 123 } },
    { round: 1, action: { type: 'card', cardId: 'not-in-hand' } },
    { round: 1, action: { type: 'desperateStrike', populationCost: 1.5 } },
    { round: 1.5, action: raidAction(room.state, 'player1') },
    { action: raidAction(room.state, 'player1') },
  ];
  for (const payload of malformedRequests) {
    assert.equal((await request<GameState>(room.player1, 'selectAction', payload)).ok, false);
  }
  assert.deepEqual(await getState(room.player1), room.state);
});

test('错误凭证、冒用对手身份与不存在房间在连接阶段被拒绝', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const room = await createPlayingRoom(fixture);
  const invalidSessions: RoomSession[] = [
    { ...room.session1, token: '0'.repeat(64) },
    { ...room.session1, playerId: 'player2' },
    { ...room.session1, roomId: '0'.repeat(12) },
  ];
  for (const session of invalidSessions) {
    const invalid = createClient(fixture, 1, session);
    await assert.rejects(connectClient(invalid), /.+/);
    assert.equal(invalid.connected, false);
  }
  assert.deepEqual(await getState(room.player1), room.state);
});

test('同身份可跨实例恢复，旧连接不能继续操作且其断开不能清除新连接', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const room = await createPlayingRoom(fixture);
  const restored = createClient(fixture, 1, room.session1);
  const initial = waitForState(restored, (state) => state.id === room.session1.roomId);
  await connectClient(restored);
  const recovered = await initial;
  assert.equal(recovered.players.player1.socketId, restored.id);
  assert.deepEqual(recovered.players.player1.hand, room.state.players.player1.hand);
  if (room.player1.connected) {
    assert.equal((await request<GameState>(room.player1, 'getGameState')).ok, false);
    assert.equal((await request<GameState>(room.player1, 'selectAction', {
      round: 1,
      action: raidAction(recovered, 'player1'),
    })).ok, false);
  }
  room.player1.disconnect();
  requireSuccess(await request<GameState>(restored, 'selectAction', {
    round: 1,
    action: raidAction(recovered, 'player1'),
  }));
  requireSuccess(await request<GameState>(room.player2, 'selectAction', {
    round: 1,
    action: raidAction(recovered, 'player2'),
  }));
  const state = await getState(restored);
  assert.equal(state.currentRound, 2);
  assert.equal(state.players.player1.socketId, restored.id);
  assert.deepEqual(state, await getState(room.player2));
});

test('关闭一个服务实例后已提交行动保留，换实例恢复后仍能完成同一回合', { timeout: 20000 }, async (context) => {
  const fixture = await createFixture(context);
  const room = await createPlayingRoom(fixture);
  const action1 = raidAction(room.state, 'player1');
  requireSuccess(await request<GameState>(room.player1, 'selectAction', { round: 1, action: action1 }));
  await closeServer(fixture.servers[0]);
  const restored = createClient(fixture, 1, room.session1);
  const initial = waitForState(restored, (state) => state.id === room.session1.roomId);
  await connectClient(restored);
  const recovered = await initial;
  assert.equal(recovered.currentRound, 1);
  assert.deepEqual(recovered.selectedActions.player1, action1);
  assert.equal(recovered.players.player1.hand.length, room.state.players.player1.hand.length);
  requireSuccess(await request<GameState>(room.player2, 'selectAction', {
    round: 1,
    action: raidAction(recovered, 'player2'),
  }));
  const state = await getState(restored);
  assert.equal(state.currentRound, 2);
  assert.equal(state.players.player1.discardPile.length, 1);
  assert.equal(state.players.player2.discardPile.length, 1);
  assert.deepEqual(state.selectedActions, { player1: null, player2: null });
});

test('Redis 无法连接时服务初始化明确失败', { timeout: 15000 }, async () => {
  const httpServer = createServer();
  await assert.rejects(setupSocketServer(httpServer, {
    redisUrl: 'redis://127.0.0.1:1',
    keyPrefix: `high-priest-unavailable-${randomUUID()}`,
  }), /Redis|connect|ECONNREFUSED/i);
});
