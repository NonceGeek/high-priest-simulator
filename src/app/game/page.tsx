/** 显示服务器权威对局状态，处理恢复连接、回合行动和游戏日志下载。 */
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  getSocket, connectSocket, onGameState, offGameState, selectAction,
  getGameState, getStoredSession, clearRoomSession,
} from '@/lib/socketClient';
import { GameState, PlayerId, Action } from '@/lib/types';
import { GameUI, formatLogEntryForViewer } from '@/lib/gameUI';
import { getTotalPopulation } from '@/lib/gameLogic';

/**
 * 下载当前玩家可见的游戏日志。
 * @param gameState 服务器提供的当前对局。
 * @param viewerId 当前玩家身份。
 * @returns 无返回值。
 * @Callers GamePage.handleDownloadLog。
 */
function downloadGameLog(gameState: GameState, viewerId: PlayerId): void {
  const content = gameState.gameLog
    .map((entry) => formatLogEntryForViewer(entry, viewerId, gameState))
    .join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'high-priest-simulator.txt';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 渲染对局与结束提示，刷新后使用凭证恢复会话。
 * @returns 游戏页面 React 元素。
 * @Callers Next.js /game 路由。
 */
export default function GamePage() {
  const router = useRouter();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<PlayerId | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showGameEndDialog, setShowGameEndDialog] = useState(false);
  const gameEndPrompted = useRef(false);
  const latestRevision = useRef(-1);

  /**
   * 显示服务器快照，不使用浏览器旧状态替代。
   * @param state 当前权威游戏状态。
   * @returns 是否接受此版本的快照。
   * @Callers receiveState、handleActionSelect。
   */
  const applyGameState = useCallback((state: GameState) => {
    if (state.revision < latestRevision.current) return false;
    latestRevision.current = state.revision;
    setGameState(state);
    return true;
  }, []);

  /**
   * 首次收到游戏结束状态时显示结果。
   * @returns 无返回值。
   * @Callers receiveState。
   */
  const promptGameEnd = useCallback(() => {
    if (gameEndPrompted.current) return;
    gameEndPrompted.current = true;
    setShowGameEndDialog(true);
  }, []);

  /**
   * 退出本标签页的会话并返回大厅。
   * @returns 无返回值。
   * @Callers 返回大厅按钮。
   */
  const returnToLobby = useCallback(() => {
    clearRoomSession();
    router.push('/');
  }, [router]);

  /**
   * 下载当前已经加载的游戏日志。
   * @returns 无返回值。
   * @Callers 游戏结束弹窗下载按钮。
   */
  const handleDownloadLog = useCallback(() => {
    if (!gameState || !playerId) return;
    downloadGameLog(gameState, playerId);
  }, [gameState, playerId]);

  useEffect(() => {
    const session = getStoredSession();
    if (!session) {
      router.push('/');
      return;
    }

    setPlayerId(session.playerId);

    const socket = getSocket();
    let cancelled = false;
    /**
     * 接收权威状态并按游戏状态导航或显示结果。
     * @param state Redis 中当前对局状态。
     * @returns 无返回值。
     * @Callers Socket.IO gameState 广播、restoreState。
     */
    function receiveState(state: GameState): void {
      if (cancelled) return;
      if (state.revision < latestRevision.current) return;
      if (state.status === 'waiting') { router.push('/'); return; }
      if (!applyGameState(state)) return;
      if (state.status === 'finished') promptGameEnd();
    }
    /**
     * 连接或重连后请求完整快照。
     * @returns 无返回值。
     * @Callers Socket.IO connect 事件及页面初始化。
     */
    function restoreState(): void {
      setConnected(true);
      setError('');
      void getGameState().then(receiveState).catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    }
    /**
     * 断线时禁用行动，等待 Socket.IO 自动恢复连接。
     * @returns 无返回值。
     * @Callers Socket.IO disconnect 事件。
     */
    function disconnected(): void { setConnected(false); }
    /**
     * 显示服务端鉴权或连接失败。
     * @param cause Socket.IO 错误对象。
     * @returns 无返回值。
     * @Callers Socket.IO connect_error 事件。
     */
    function connectionFailed(cause: Error): void { setError(cause.message); setConnected(false); }
    /**
     * 显示服务器异步错误，例如 Redis 故障。
     * @param message 服务端错误消息。
     * @returns 无返回值。
     * @Callers Socket.IO serverError 事件。
     */
    function serverFailed(message: string): void { setError(message); }
    onGameState(receiveState);
    socket.on('connect', restoreState);
    socket.on('disconnect', disconnected);
    socket.on('connect_error', connectionFailed);
    socket.on('serverError', serverFailed);
    if (socket.connected) restoreState();
    else connectSocket();

    return () => {
      cancelled = true;
      offGameState(receiveState);
      socket.off('connect', restoreState);
      socket.off('disconnect', disconnected);
      socket.off('connect_error', connectionFailed);
      socket.off('serverError', serverFailed);
    };
  }, [router, applyGameState, promptGameEnd]);

  /**
   * 提交带回合号的行动，并显示服务器的结果或拒绝原因。
   * @param action 玩家选择的卡牌或垂死一搏。
   * @returns 异步完成通知。
   * @Callers GameUI.onActionSelect。
   */
  const handleActionSelect = async (action: Action) => {
    if (!gameState || submitting) return;
    setSubmitting(true);
    setError('');
    await selectAction(gameState.currentRound, action).then(applyGameState)
      .catch((cause: Error) => setError(cause.message)).finally(() => setSubmitting(false));
  };

  if (!gameState || !playerId) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-700 flex items-center justify-center">
        <div className="text-white text-center">
          <p className="text-2xl">{error || '正在恢复房间连接...'}</p>
          {error && <>
            <button onClick={() => connectSocket()} className="mt-4 bg-green-600 px-6 py-2 rounded-lg mr-3">重新连接</button>
            <button onClick={returnToLobby} className="mt-4 bg-blue-600 px-6 py-2 rounded-lg">返回大厅</button>
          </>}
        </div>
      </div>
    );
  }

  return (
    <>
      {(!connected || error) && (
        <div role="alert" className="fixed top-0 inset-x-0 z-40 bg-red-900 text-white p-3 text-center">
          {error || '连接已断开，正在恢复；请等待连接成功后再出牌。'}
          <button onClick={() => connectSocket()} className="ml-4 underline">重新连接</button>
          <button onClick={returnToLobby} className="ml-4 underline">返回大厅</button>
        </div>
      )}
      <fieldset disabled={!connected || submitting} className="contents">
        <GameUI gameState={gameState} playerId={playerId} onActionSelect={handleActionSelect} />
      </fieldset>
      {showGameEndDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-gray-800 text-white rounded-lg shadow-2xl p-8 max-w-md w-full text-center">
            <h2 className="text-2xl font-bold mb-2">游戏结束</h2>
            {(() => {
              const bothHaveHands =
                gameState.players.player1.hand.length > 0 &&
                gameState.players.player2.hand.length > 0;
              const bothWipedOut =
                getTotalPopulation(gameState.players.player1) <= 0 &&
                getTotalPopulation(gameState.players.player2) <= 0;
              const outcome =
                gameState.winner === 'draw'
                  ? '最终无人获胜。'
                  : `${
                      gameState.players[gameState.winner!]?.nickname?.trim() || '祭司'
                    }的部落获得了最终胜利。`;

              let flavor: string | null = null;
              if (gameState.endReason === 'population') {
                flavor = '双方部落都耗尽了手上的资源，进入了最惨烈的肉搏战……';
              } else if (gameState.endReason === 'knockout' && bothHaveHands && bothWipedOut) {
                flavor = '双方部众皆已阵亡，只有两位祭司在战场上默默地看着对方……';
              }

              return (
                <div className="text-gray-300 mb-6 space-y-3">
                  {flavor && <p>{flavor}</p>}
                  {gameState.endReason === 'population' && (
                    <p className="text-sm text-gray-400">
                      总人口 {getTotalPopulation(gameState.players.player1)} vs{' '}
                      {getTotalPopulation(gameState.players.player2)}
                      {' · '}
                      俘虏 {gameState.players.player1.captives.length} vs{' '}
                      {gameState.players.player2.captives.length}
                    </p>
                  )}
                  <p className="text-yellow-300 font-semibold">{outcome}</p>
                </div>
              );
            })()}
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleDownloadLog}
                className="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-bold"
              >
                下载游戏日志
              </button>
              <button
                type="button"
                onClick={returnToLobby}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-bold"
              >
                返回大厅
              </button>
              <button
                type="button"
                onClick={() => setShowGameEndDialog(false)}
                className="w-full bg-gray-600 hover:bg-gray-700 text-white py-2 rounded-lg"
              >
                继续查看
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
