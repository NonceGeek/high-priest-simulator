'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSocket, onGameState, offGameState, selectAction } from '@/lib/socketClient';
import { GameState, PlayerId, Action } from '@/lib/types';
import { GameUI } from '@/lib/gameUI';

export default function GamePage() {
  const router = useRouter();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<PlayerId | null>(null);
  const [error, setError] = useState('');

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
      setGameState(JSON.parse(savedGameState));
    }
    
    const socket = getSocket();
    if (!socket.connected) {
      socket.connect();
    }
    
    onGameState((state: GameState) => {
      const withDraws = {
        ...state,
        nuwaDrawHistory: state.nuwaDrawHistory ?? [],
      };
      setGameState(withDraws);
      localStorage.setItem('gameState', JSON.stringify(withDraws));
      localStorage.setItem('nuwaDrawHistory', JSON.stringify(withDraws.nuwaDrawHistory));

      if (state.status === 'finished') {
        setTimeout(() => {
          if (confirm('游戏结束！是否返回大厅？')) {
            localStorage.removeItem('roomId');
            localStorage.removeItem('playerId');
            localStorage.removeItem('gameState');
            localStorage.removeItem('nuwaDrawHistory');
            router.push('/');
          }
        }, 1000);
      }
    });
    
    socket.emit('getGameState', (state: GameState | null) => {
      if (state) {
        const withDraws = {
          ...state,
          nuwaDrawHistory: state.nuwaDrawHistory ?? [],
        };
        setGameState(withDraws);
        localStorage.setItem('gameState', JSON.stringify(withDraws));
        localStorage.setItem('nuwaDrawHistory', JSON.stringify(withDraws.nuwaDrawHistory));
      } else {
        setError('无法获取游戏状态');
      }
    });
    
    return () => {
      offGameState();
    };
  }, [router]);

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

  return <GameUI gameState={gameState} playerId={playerId} onActionSelect={handleActionSelect} />;
}
