/** 管理浏览器 Socket.IO 连接、每个标签页的恢复凭证和有时限的服务器请求。 */
'use client';

import { io, Socket } from 'socket.io-client';
import type {
  Action, ClientToServerEvents, GameState, RoomSession, ServerToClientEvents, SocketResult,
} from './types';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const SESSION_KEY = 'high-priest.session';
const REQUEST_TIMEOUT_MS = 8000;
let socket: GameSocket | null = null;

/**
 * 读取当前标签页的恢复凭证；格式损坏时明确报错。
 * @returns 当前会话，没有保存会话时返回 null。
 * @throws 保存的凭证结构无效时抛出错误。
 * @Callers getSocket、connectSocket、Home、GamePage。
 */
export function getStoredSession(): RoomSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (raw === null) return null;
  const session: unknown = JSON.parse(raw);
  if (typeof session !== 'object' || session === null) throw new Error('保存的房间凭证无效');
  const value = session as Partial<RoomSession>;
  if (typeof value.roomId !== 'string' || typeof value.token !== 'string' ||
      (value.playerId !== 'player1' && value.playerId !== 'player2')) {
    throw new Error('保存的房间凭证无效');
  }
  return value as RoomSession;
}

/**
 * 获取使用统一 WebSocket 路径的单例客户端。
 * @returns 已配置但不会自动连接的 Socket.IO 客户端。
 * @Callers connectSocket、clearRoomSession、onGameState、offGameState、selectAction。
 */
export function getSocket(): GameSocket {
  if (!socket) {
    socket = io({
      path: '/api/socket-io/socket.io',
      transports: ['websocket'],
      autoConnect: false,
      auth: getStoredSession() ? { session: getStoredSession() } : {},
    });
  }
  return socket;
}

/**
 * 在连接前提供服务器签发的恢复凭证。
 * @returns 当前 Socket.IO 客户端。
 * @Callers requireConnection、Home、GamePage。
 */
export function connectSocket(): GameSocket {
  const client = getSocket();
  if (!client.connected) {
    const session = getStoredSession();
    client.auth = session ? { session } : {};
    client.connect();
  }
  return client;
}

/**
 * 保存新房间凭证，供刷新与自动重连使用。
 * @param session 服务器创建或加入房间后返回的会话。
 * @returns 无返回值。
 * @Callers createRoom、joinRoom。
 */
function rememberSession(session: RoomSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  getSocket().auth = { session };
}

/**
 * 主动退出当前会话并关闭连接，不删除服务器房间。
 * @returns 无返回值。
 * @Callers Home、GamePage。
 */
export function clearRoomSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  const client = getSocket();
  client.disconnect();
  client.auth = {};
}

/**
 * 等待当前连接就绪；超时与鉴权失败均传给调用页面。
 * @returns 已连接的客户端。
 * @throws 连接错误或超过等待时间时拒绝 Promise。
 * @Callers createRoom、joinRoom、getGameState。
 */
async function requireConnection(): Promise<GameSocket> {
  const client = getSocket();
  if (client.connected) return client;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('连接服务器超时，请检查网络后重试'));
    }, REQUEST_TIMEOUT_MS);
    /**
     * 释放本次连接等待的监听器和计时器。
     * @returns 无返回值。
     * @Callers connected、failed、连接超时回调。
     */
    function cleanup(): void {
      clearTimeout(timer);
      client.off('connect', connected);
      client.off('connect_error', failed);
    }
    /**
     * 结束成功的连接等待。
     * @returns 无返回值。
     * @Callers Socket.IO connect 事件。
     */
    function connected(): void { cleanup(); resolve(); }
    /**
     * 向页面报告连接失败。
     * @param error Socket.IO 的连接错误。
     * @returns 无返回值。
     * @Callers Socket.IO connect_error 事件。
     */
    function failed(error: Error): void { cleanup(); reject(error); }
    client.once('connect', connected);
    client.once('connect_error', failed);
    connectSocket();
  });
  return client;
}

/**
 * 将服务器拒绝转换为页面可显示的错误。
 * @param result 服务器的唯一响应协议。
 * @returns 成功结果中的权威值。
 * @throws 服务器拒绝时抛出其错误信息。
 * @Callers createRoom、joinRoom、selectAction、getGameState。
 */
function unwrap<T>(result: SocketResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/**
 * 创建房间并保存服务器签发的身份。
 * @param nickname 玩家昵称。
 * @returns 新房间的恢复会话。
 * @Callers Home.handleCreateRoom。
 */
export async function createRoom(nickname: string): Promise<RoomSession> {
  const client = await requireConnection();
  const session = unwrap<RoomSession>(await client.timeout(REQUEST_TIMEOUT_MS).emitWithAck('createRoom', nickname));
  rememberSession(session);
  return session;
}

/**
 * 加入房间并保存服务器签发的身份。
 * @param roomId 要加入的房间号。
 * @param nickname 玩家昵称。
 * @returns 加入后的恢复会话。
 * @Callers Home.handleJoinRoom。
 */
export async function joinRoom(roomId: string, nickname: string): Promise<RoomSession> {
  const client = await requireConnection();
  const session = unwrap<RoomSession>(await client.timeout(REQUEST_TIMEOUT_MS).emitWithAck('joinRoom', roomId, nickname));
  rememberSession(session);
  return session;
}

/**
 * 提交指定回合的行动，断线期间拒绝在客户端排队出牌。
 * @param round 当前服务器回合。
 * @param action 玩家选择的行动。
 * @returns 提交后的权威游戏状态。
 * @Callers GamePage.handleActionSelect。
 */
export async function selectAction(round: number, action: Action): Promise<GameState> {
  const client = getSocket();
  if (!client.connected) throw new Error('连接已断开，请等待恢复后再出牌');
  return unwrap(await client.timeout(REQUEST_TIMEOUT_MS).emitWithAck('selectAction', { round, action }));
}

/**
 * 获取 Redis 中当前权威状态。
 * @returns 当前房间状态。
 * @Callers Home、GamePage。
 */
export async function getGameState(): Promise<GameState> {
  const client = await requireConnection();
  return unwrap(await client.timeout(REQUEST_TIMEOUT_MS).emitWithAck('getGameState'));
}

/**
 * 注册状态广播监听，调用方须在连接前注册。
 * @param callback 接收服务器状态的页面回调。
 * @returns 无返回值。
 * @Callers Home、GamePage。
 */
export function onGameState(callback: (state: GameState) => void): void {
  getSocket().on('gameState', callback);
}

/**
 * 只释放当前页面自己的状态监听器。
 * @param callback 与注册时相同的回调。
 * @returns 无返回值。
 * @Callers Home、GamePage 的 effect 清理函数。
 */
export function offGameState(callback: (state: GameState) => void): void {
  getSocket().off('gameState', callback);
}
