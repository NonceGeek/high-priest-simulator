'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getSocket, onGameState, offGameState, selectAction } from '@/lib/socketClient';
import { GameState, PlayerId, Action } from '@/lib/types';
import { GameUI, formatLogEntryForViewer } from '@/lib/gameUI';
import { getTotalPopulation } from '@/lib/gameLogic';

function normalizeGameState(state: GameState): GameState {
  return {
    ...state,
    nuwaDrawHistory: state.nuwaDrawHistory ?? [],
    lastReveal: state.lastReveal ?? null,
    endReason: state.endReason ?? null,
    players: {
      player1: {
        ...state.players.player1,
        faceUpDiscards: state.players.player1.faceUpDiscards ?? [],
      },
      player2: {
        ...state.players.player2,
        faceUpDiscards: state.players.player2.faceUpDiscards ?? [],
      },
    },
  };
}

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

export default function GamePage() {
  const router = useRouter();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<PlayerId | null>(null);
  const [error, setError] = useState('');
  const [showGameEndDialog, setShowGameEndDialog] = useState(false);
  const gameEndPrompted = useRef(false);

  const applyGameState = useCallback((state: GameState) => {
    const normalized = normalizeGameState(state);
    setGameState(normalized);
    localStorage.setItem('gameState', JSON.stringify(normalized));
    localStorage.setItem('nuwaDrawHistory', JSON.stringify(normalized.nuwaDrawHistory));
    return normalized;
  }, []);

  const promptGameEnd = useCallback(() => {
    if (gameEndPrompted.current) return;
    gameEndPrompted.current = true;
    setTimeout(() => setShowGameEndDialog(true), 1000);
  }, []);

  const returnToLobby = useCallback(() => {
    localStorage.removeItem('roomId');
    localStorage.removeItem('playerId');
    localStorage.removeItem('gameState');
    localStorage.removeItem('nuwaDrawHistory');
    router.push('/');
  }, [router]);

  const handleDownloadLog = useCallback(() => {
    if (!gameState || !playerId) return;
    downloadGameLog(gameState, playerId);
  }, [gameState, playerId]);

  useEffect(() => {
    const savedRoomId = localStorage.getItem('roomId');
    const savedPlayerId = localStorage.getItem('playerId') as PlayerId | null;
    const savedGameState = localStorage.getItem('gameState');

    if (!savedRoomId || !savedPlayerId) {
      router.push('/');
      return;
    }

    setPlayerId(savedPlayerId);

    if (savedGameState) {
      const parsed = normalizeGameState(JSON.parse(savedGameState) as GameState);
      setGameState(parsed);
      if (parsed.status === 'finished') {
        promptGameEnd();
      }
    }

    const socket = getSocket();
    if (!socket.connected) {
      socket.connect();
    }

    onGameState((state: GameState) => {
      const normalized = applyGameState(state);
      if (normalized.status === 'finished') {
        promptGameEnd();
      }
    });

    socket.emit('getGameState', (state: GameState | null) => {
      if (state) {
        const normalized = applyGameState(state);
        if (normalized.status === 'finished') {
          promptGameEnd();
        }
      } else {
        setError('无法获取游戏状态');
      }
    });

    return () => {
      offGameState();
    };
  }, [router, applyGameState, promptGameEnd]);

  const handleActionSelect = (action: Action) => {
    selectAction(action, (success, errorMsg) => {
      if (!success) {
        setError(errorMsg || '操作失败');
      } else {
        setError('');
      }
    });
  };

  if (!gameState || !playerId) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-700 flex items-center justify-center">
        <div className="text-white text-2xl">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-700 flex items-center justify-center">
        <div className="bg-gray-800 p-8 rounded-lg text-center">
          <div className="text-red-400 text-xl mb-4">{error}</div>
          <button
            onClick={() => router.push('/')}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg"
          >
            返回大厅
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <GameUI gameState={gameState} playerId={playerId} onActionSelect={handleActionSelect} />
      {showGameEndDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-gray-800 text-white rounded-lg shadow-2xl p-8 max-w-md w-full text-center">
            <h2 className="text-2xl font-bold mb-2">游戏结束</h2>
            {(() => {
              const bothHaveHands =
                gameState.players.player1.hand.length > 0 &&
                gameState.players.player2.hand.length > 0;

              if (gameState.endReason === 'population') {
                return (
                  <div className="text-gray-300 mb-6 space-y-3">
                    <p>双方部落都耗尽了手上的资源，进入了最惨烈的肉搏战……</p>
                    <p className="text-sm text-gray-400">
                      总人口 {getTotalPopulation(gameState.players.player1)} vs{' '}
                      {getTotalPopulation(gameState.players.player2)}
                    </p>
                    <p className="text-yellow-300 font-semibold">
                      {gameState.winner === 'draw'
                        ? '最终无人获胜。'
                        : `${
                            gameState.players[gameState.winner!].nickname?.trim() || '祭司'
                          }的部落获得了最终胜利。`}
                    </p>
                  </div>
                );
              }

              // Both still hold cards, but tribes were wiped out (e.g. mutual 献祭).
              if (
                gameState.endReason === 'knockout' &&
                bothHaveHands &&
                getTotalPopulation(gameState.players.player1) <= 0 &&
                getTotalPopulation(gameState.players.player2) <= 0
              ) {
                return (
                  <div className="text-gray-300 mb-6 space-y-3">
                    <p>双方部众皆已阵亡，只有两位祭司在战场上默默地看着对方……</p>
                    <p className="text-yellow-300 font-semibold">最终无人获胜。</p>
                  </div>
                );
              }

              return <p className="text-gray-300 mb-6">选择下一步操作</p>;
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
